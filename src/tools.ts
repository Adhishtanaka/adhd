import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, extname, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { ROOTS, allowedRoots, isUnderRoots, allowedCommands } from "./config.js";
import { rankChunks, extractImages } from "./extract.js";
import { recordFailure, isBadDomain, domainOf } from "./failcache.js";
import { withDeadline } from "./jobs.js";

// How long a tool may hold the turn open before it finishes in the background.
// Shell gets longer than network: a command the user just approved is usually
// one they're watching for, and bouncing it to the background reads as a stall.
const SLOW = { net: 20_000, shell: 25_000 };

// Decorate a tool so slow runs background themselves, without touching its body.
// Only for tools that DON'T prompt the user — the shell tools wrap after their
// approve() call instead, so time spent waiting on a human never counts.
function deadlined(t: Tool, ms: number, label: (args: any) => string): Tool {
  const inner = t.execute!;
  return {
    ...t,
    execute: (args: any, opts: any) => withDeadline(label(args), ms, async () => String(await inner(args, opts))),
  } as Tool;
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Emitted so the UI can ask the user before a shell command runs. `explain` is
// the model's own plain-English description of what the command does, so the
// user can judge it without reading shell. `allowKey` is non-null only when the
// command is safe to blanket-approve (see allowKeyFor).
// Wired by the agent at startup. Default: deny (safe when running headless).
export type ConfirmReq = { command: string; explain?: string; allowKey?: string | null };
export type Confirm = (req: ConfirmReq) => Promise<boolean>;
let confirmBash: Confirm = async () => false;
export function setBashConfirm(fn: Confirm) {
  confirmBash = fn;
}
// Reuse the same prompt for any action that needs approval (e.g. loop_task).
export const confirmAction = (message: string): Promise<boolean> => confirmBash({ command: message });

// "Always allow" grants a PROGRAM, never a command line. A line with shell
// operators can hide a second program behind an allowed name (`ls && rm -rf ~`),
// so anything but a single plain command gets one-time approval only — null here
// means the UI shows no "always allow" button at all.
const SHELL_OPS = /[;&|<>`$(){}\n]/;
export function allowKeyFor(runner: string, command: string): string | null {
  if (SHELL_OPS.test(command)) return null;
  const first = command.trim().split(/\s+/)[0] ?? "";
  return /^[\w./-]+$/.test(first) ? `${runner}:${first}` : null;
}

// One gate for bash/powershell: skip the prompt if this program was already
// blanket-approved, otherwise ask.
async function approve(runner: string, command: string, explain?: string): Promise<boolean> {
  const allowKey = allowKeyFor(runner, command);
  if (allowKey && allowedCommands().includes(allowKey)) return true;
  return confirmBash({ command, explain, allowKey });
}

const EXPLAIN = z
  .string()
  .describe(
    "One short plain-English sentence for the user: what this command does and what it changes on their machine. " +
      "Written for someone who does not read shell. Say plainly if it deletes, overwrites, installs, or sends anything.",
  );

// Emitted so the UI can ask the user to pick an option (or type their own).
// Wired by the agent at startup. Default (headless): take the first option.
export type AskUser = (question: string, options: string[]) => Promise<string>;
let askUser: AskUser = async (_q, options) => options[0] ?? "";
export function setAskUser(fn: AskUser) {
  askUser = fn;
}

// Keep tool output small — it all lands back in the model's context and a tiny
// tokens-per-minute budget fills up fast. ponytail: crude char caps beat dumps.
const MAX_OUT = 2500;
export function cap(s: string, max = MAX_OUT): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
// Squeeze the noise agent-browser leaves in scraped markdown (blank-line runs,
// trailing spaces) so a fetched page costs fewer tokens.
function cleanMarkdown(s: string): string {
  return s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Serper (google.serper.dev) search. One tool, `type` picks the vertical /
// endpoint. Returns a compact list — every row carries a URL so the model can
// then web_fetch the one it wants. ponytail: hand-formatted lines beat dumping
// raw JSON into the model's tiny token budget.
export const SERPER_TYPES = ["search", "images", "videos", "places", "shopping", "news"] as const;
export type SerperType = (typeof SERPER_TYPES)[number];

// Drop results on domains that keep failing to fetch, so the model stops picking them.
const okDomain = (link: string) => !isBadDomain(domainOf(link || ""));

// Verify a URL actually serves an image (Content-Type image/*) before we render
// it or hand it to the model — search/scrape results are full of dead links,
// tracking pixels, and HTML pages dressed up as image URLs. HEAD is cheapest;
// some hosts reject HEAD, so fall back to a 1-byte ranged GET. Checking the
// Content-Type (not the extension) means every real image type — webp, avif,
// svg, gif, … — is accepted automatically. ponytail: content-type, not magic bytes.
const IMAGE_CT = /^image\//i;
export async function isRealImage(url: string): Promise<boolean> {
  const check = async (method: string, headers?: Record<string, string>): Promise<boolean> => {
    try {
      const r = await fetch(url, { method, headers, redirect: "follow", signal: AbortSignal.timeout(5000) });
      const ok = r.ok && IMAGE_CT.test(r.headers.get("content-type") || "");
      r.body?.cancel().catch(() => {}); // don't download the body, just the headers
      return ok;
    } catch {
      return false;
    }
  };
  if (await check("HEAD")) return true;
  return check("GET", { Range: "bytes=0-0" }); // some hosts 405 on HEAD
}
export async function keepRealImages<T extends { src: string }>(items: T[]): Promise<T[]> {
  const ok = await Promise.all(items.map((it) => isRealImage(it.src)));
  return items.filter((_, i) => ok[i]);
}

export function formatSerper(type: SerperType, r: any): string {
  const rows: string[] = [];
  if (type === "search") {
    const kg = r.knowledgeGraph;
    if (kg?.title) rows.push(`# ${kg.title}${kg.description ? ` — ${kg.description}` : ""}${kg.website ? ` (${kg.website})` : ""}`);
    if (r.answerBox?.answer || r.answerBox?.snippet) rows.push(`answer: ${r.answerBox.answer ?? r.answerBox.snippet}`);
    for (const o of (r.organic ?? []).filter((o: any) => okDomain(o.link)).slice(0, 8))
      rows.push(`${o.title} — ${o.link}${o.snippet ? `\n  ${o.snippet}` : ""}`);
  } else if (type === "news") {
    for (const n of (r.news ?? []).filter((n: any) => okDomain(n.link)).slice(0, 8))
      rows.push(`${n.title} — ${n.link}${n.date ? ` (${n.date})` : ""}${n.snippet ? `\n  ${n.snippet}` : ""}`);
  } else if (type === "videos") {
    for (const v of (r.videos ?? []).filter((v: any) => okDomain(v.link ?? v.videoUrl)).slice(0, 8))
      rows.push(`${v.title} — ${v.link ?? v.videoUrl}${v.duration ? ` (${v.duration})` : ""}${v.channel ? ` | ${v.channel}` : ""}`);
  } else if (type === "images") {
    for (const im of (r.images ?? []).filter((im: any) => okDomain(im.link)).slice(0, 10))
      rows.push(`${im.title} — ${im.imageUrl} (page: ${im.link})`);
  } else if (type === "places") {
    for (const p of (r.places ?? []).slice(0, 8))
      rows.push(`${p.title} — ${p.address ?? "?"}${p.rating ? ` | ${p.rating}★ (${p.ratingCount ?? 0})` : ""}${p.phoneNumber ? ` | ${p.phoneNumber}` : ""}${p.website ? ` | ${p.website}` : ""}`);
  } else if (type === "shopping") {
    for (const s of (r.shopping ?? []).filter((s: any) => okDomain(s.link)).slice(0, 10))
      rows.push(`${s.title}${s.price ? ` — ${s.price}` : ""}${s.source ? ` | ${s.source}` : ""}${s.link ? ` | ${s.link}` : ""}`);
  }
  return rows.join("\n") || `no ${type} results`;
}

export function builtinTools(): Record<string, Tool> {
  const t: Record<string, Tool> = {
    read_file: tool({
      description: "Read a UTF-8 text file and return its contents.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => cap(readFileSync(path, "utf8")),
    }),
    write_file: tool({
      description: "Write text to a file, creating parent dirs. Overwrites.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return `wrote ${content.length} bytes to ${path}`;
      },
    }),
    list_dir: tool({
      description: "List entries in a directory (name and type).",
      inputSchema: z.object({ path: z.string().default(".") }),
      execute: async ({ path }) =>
        readdirSync(path, { withFileTypes: true })
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .join("\n"),
    }),
    grep: tool({
      description: "Search files under a directory for a regex; returns matching lines with file:line.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().default("."),
      }),
      execute: async ({ pattern, path }) => {
        // Fast path: ripgrep. It's native, multithreaded, memory-maps files, and
        // skips binaries/.gitignore itself — orders of magnitude faster than
        // reading every file in JS. rg exits 1 on "no matches", which isn't an error.
        try {
          const { stdout } = await execFileAsync(
            "rg",
            ["--line-number", "--no-heading", "--color=never", "-g", "!.git", "-g", "!node_modules", "-e", pattern, "--", path],
            { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
          );
          return cap(stdout.split("\n").slice(0, 500).join("\n")) || "no matches";
        } catch (e: any) {
          if (e.code === 1 && !e.stdout) return "no matches"; // rg: no matches
          if (e.stdout) return cap(String(e.stdout).split("\n").slice(0, 500).join("\n")); // hit the 500 cap
          if (e.code !== "ENOENT") return `grep failed: ${e.message}`;
        }
        // Fallback (rg not installed): the old JS walk. ponytail: slow, install rg.
        const re = new RegExp(pattern);
        const hits: string[] = [];
        const walk = (dir: string) => {
          if (hits.length > 500) return;
          for (const d of readdirSync(dir, { withFileTypes: true })) {
            if (d.name === "node_modules" || d.name.startsWith(".git")) continue;
            const full = join(dir, d.name);
            if (d.isDirectory()) walk(full);
            else {
              let text: string;
              try {
                text = readFileSync(full, "utf8");
              } catch {
                continue; // binary / unreadable
              }
              text.split("\n").forEach((line, i) => {
                if (re.test(line)) hits.push(`${full}:${i + 1}: ${line.trim()}`);
              });
            }
          }
        };
        walk(path);
        return cap(hits.slice(0, 500).join("\n")) || "no matches";
      },
    }),
    glob: tool({
      description: "Find files by glob pattern (e.g. '**/*.md', 'src/**/*.ts', '*.pdf'). Returns matching paths under cwd.",
      inputSchema: z.object({ pattern: z.string(), cwd: z.string().default(".") }),
      execute: async ({ pattern, cwd }) => {
        const hits: string[] = [];
        for (const p of new Bun.Glob(pattern).scanSync({ cwd })) {
          hits.push(p);
          if (hits.length >= 500) break;
        }
        return cap(hits.sort().join("\n")) || "no matches";
      },
    }),
    // bash, powershell and run_script are the destructive trio: all ALWAYS route
    // through confirmBash, including inside loop_task, subagents, and scheduled runs.
    bash: tool({
      description: "Run a shell command. The user must approve it first, and sees your `explain` text when deciding.",
      inputSchema: z.object({ command: z.string(), explain: EXPLAIN }),
      execute: async ({ command, explain }) => {
        // sudo blocks on an interactive password prompt this tool can't answer —
        // it just hangs the terminal until timeout. Refuse instead of running it.
        if (/\bsudo\b/.test(command))
          return "sudo isn't available here (no way to enter a password). Run the command without sudo, or skip the privileged path.";
        if (!(await approve("bash", command, explain))) return "user denied command";
        return withDeadline(`bash: ${command}`, SLOW.shell, async () => {
          try {
            const { stdout, stderr } = await execAsync(command, {
              maxBuffer: 10 * 1024 * 1024,
              timeout: 120_000,
            });
            return cap((stdout + stderr).trim()) || "(no output)";
          } catch (e) {
            return `command failed: ${(e as Error).message}`;
          }
        });
      },
    }),
    powershell: tool({
      description:
        "Run a PowerShell command via pwsh (cross-platform). The user must approve it first and sees your `explain` text when deciding. Needs PowerShell installed.",
      inputSchema: z.object({ command: z.string(), explain: EXPLAIN }),
      execute: async ({ command, explain }) => {
        if (!(await approve("pwsh", command, explain))) return "user denied command";
        return withDeadline(`powershell: ${command}`, SLOW.shell, async () => {
          try {
            const { stdout, stderr } = await execFileAsync("pwsh", ["-NoProfile", "-Command", command], {
              maxBuffer: 10 * 1024 * 1024,
              timeout: 120_000,
            });
            return cap((stdout + stderr).trim()) || "(no output)";
          } catch (e: any) {
            if (e.code === "ENOENT") return "powershell needs pwsh installed — see https://aka.ms/powershell";
            return `command failed: ${e.message}`;
          }
        });
      },
    }),
    run_script: tool({
      description:
        "Write a TypeScript snippet to a temp file and run it with Bun (for a quick test, a fetch/curl, or file probing). The user must approve it first. Bun APIs, fetch, and node builtins are available.",
      inputSchema: z.object({
        code: z.string(),
        explain: EXPLAIN,
      }),
      execute: async ({ code, explain }) => {
        // allowKey null: a script is arbitrary code, so there is no program name
        // worth blanket-approving — run_script always asks. ponytail: no exceptions.
        if (!(await confirmBash({ command: `bun run <script>\n${code}`, explain, allowKey: null })))
          return "user denied script";
        const file = join(tmpdir(), `adhd-${Date.now()}.ts`);
        writeFileSync(file, code);
        return withDeadline(`run_script: ${code.split("\n")[0]}`, SLOW.shell, async () => {
          try {
            const { stdout, stderr } = await execFileAsync("bun", ["run", file], {
              maxBuffer: 10 * 1024 * 1024,
              timeout: 120_000,
            });
            return cap((stdout + stderr).trim()) || "(no output)";
          } catch (e) {
            return `script failed: ${(e as Error).message}`;
          }
        });
      },
    }),
    ask_user: tool({
      description:
        "Ask the user a multiple-choice question — the LAST resort, only when you truly cannot proceed. Call this BEFORE writing any answer, never after: if you need the user's input, ask first and wait, then answer using their reply. Do not produce an answer and then ask. FIRST try recall (their saved memory), then your other tools, to get the answer yourself; only ask for things no tool can give you (a fresh decision or a preference not in memory). E.g. never ask where the user lives before calling recall. Give 2-4 short options; the user may also type their own answer. Returns their answer.",
      inputSchema: z.object({
        question: z.string(),
        options: z.array(z.string()).min(2).max(4),
      }),
      execute: async ({ question, options }) => `user answered: ${await askUser(question, options)}`,
    }),
    web_search: tool({
      description:
        "Search Google via Serper when you DON'T already have a URL — to find the right pages, images, videos, local places/shops, or news for a query. type: 'search' (default, web results), 'images', 'videos', 'places' (locations/shops, pass `location` like 'Colombo, Sri Lanka'), 'shopping', 'news'. Returns a compact list where each row has a URL. Pick the best result and call web_fetch on its URL to read it. If you already know the exact URL, skip this and call web_fetch directly.",
      inputSchema: z.object({
        q: z.string(),
        type: z.enum(SERPER_TYPES).default("search"),
        location: z.string().optional(),
      }),
      execute: async ({ q, type, location }) => {
        const key = process.env.SERPER_API_KEY;
        if (!key) return "web_search needs SERPER_API_KEY — put it in .env or the environment.";
        try {
          const res = await fetch(`https://google.serper.dev/${type}`, {
            method: "POST",
            headers: { "X-API-KEY": key, "Content-Type": "application/json" },
            body: JSON.stringify(location ? { q, location } : { q }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) return `serper ${type} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim();
          const data = await res.json();
          // Image search returns plenty of dead/non-image URLs — keep only the ones
          // that actually serve an image, so the model never cites or shows a bad link.
          if (type === "images" && Array.isArray(data.images)) {
            const ok = await Promise.all(data.images.map((im: any) => isRealImage(im.imageUrl)));
            data.images = data.images.filter((_: any, i: number) => ok[i]);
          }
          return cap(formatSerper(type, data));
        } catch (e) {
          return `serper ${type} failed: ${(e as Error).message}`;
        }
      },
    }),
    web_fetch: tool({
      description:
        "Fetch a KNOWN URL and return its readable content as cleaned markdown. Use when you have the URL — e.g. one the user gave you, or a link web_search returned. ALWAYS pass `query` describing what you're looking for on the page; only the most relevant sections are returned (the rest of the page is dropped to save context). To discover URLs first, use web_search.",
      inputSchema: z.object({
        url: z.string().url(),
        query: z.string().optional().describe("what you're looking for on this page — returns only the most relevant sections"),
      }),
      execute: async ({ url, query }) => {
        // agent-browser `read` extracts clean markdown (no Chrome for static
        // pages). execFile, not a shell, so the model's URL can't inject.
        // It exits non-zero on failure but still prints the JSON error to
        // stdout, so parse stdout whether or not the process threw.
        let stdout: string;
        try {
          ({ stdout } = await execFileAsync("agent-browser", ["read", url, "--json"], {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 30_000, // fail fast — a hung page shouldn't stall the whole turn
          }));
        } catch (e: any) {
          if (e.code === "ENOENT")
            return "web_fetch needs agent-browser — install it with `npm install -g agent-browser`.";
          stdout = e.stdout ?? "";
        }
        let r: any;
        try {
          r = JSON.parse(stdout);
        } catch {
          recordFailure(url, "unreadable response");
          return `could not read ${url}. Try a different URL — this does NOT mean you lack network access.`;
        }
        if (r.success) {
          const clean = cleanMarkdown(String(r.data?.content ?? ""));
          // Query-aware: keep only the paragraphs that matter. Falls back to
          // head-truncation when no query or nothing matches.
          const focused = query ? rankChunks(clean, query, MAX_OUT) : "";
          // Surface page images (with alt) so the model can show relevant ones —
          // but only ones whose URL actually serves an image (drop dead/HTML links).
          const imgs = await keepRealImages(extractImages(clean));
          const imgList = imgs.length
            ? `\n\nImages:\n${imgs.map((i) => `- ${i.alt}: ${i.src}`).join("\n")}`
            : "";
          return cap(focused || clean) + imgList;
        }
        // Be specific: a dead host is not "no internet", or the model gives up.
        recordFailure(url, String(r.error ?? "fetch failed"));
        return `could not read ${url}: ${r.error}. The host may be down or the URL wrong — try a different URL. This does NOT mean you lack network access.`;
      },
    }),
    search_files: tool({
      description:
        "Search the user's OWN files by name, under their allowed local folders (home by default). Use to find and then show local images, videos, or documents. To display a found image/video, call render_ui with an Image or Video whose src is 'local://<absolute path>'.",
      inputSchema: z.object({
        query: z.string().describe("filename text to match (case-insensitive)"),
        kind: z.enum(["image", "video", "doc", "any"]).default("any"),
        root: z.string().optional().describe("limit to this folder (must be inside an allowed root)"),
      }),
      execute: async ({ query, kind, root }) => {
        const roots = root ? (isUnderRoots(root) ? [root] : []) : allowedRoots();
        if (!roots.length) return root ? `"${root}" is outside the allowed folders.` : "no allowed folders.";
        const ext: Record<string, RegExp> = {
          image: /\.(jpe?g|jfif|png|apng|gif|webp|avif|svg|bmp|ico|heic|heif)$/i,
          video: /\.(mp4|webm|mov|mkv|avi|m4v)$/i,
          doc: /\.(pdf|docx?|txt|md|csv|xlsx?|pptx?|rtf)$/i,
        };
        const kx = kind !== "any" ? ext[kind] : null;
        const q = query.toLowerCase();
        let candidates: string[] = [];
        try {
          // macOS Spotlight — instant. Falls back to a bounded walk elsewhere.
          const { stdout } = await execFileAsync("mdfind", [...roots.flatMap((r) => ["-onlyin", r]), "-name", query], {
            timeout: 8000,
            maxBuffer: 4 * 1024 * 1024,
          });
          candidates = stdout.split("\n").filter(Boolean);
        } catch {
          const walk = (dir: string, depth: number) => {
            if (candidates.length >= 200 || depth > 6) return;
            let entries;
            try {
              entries = readdirSync(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (candidates.length >= 200 || e.name.startsWith(".") || e.name === "node_modules") continue;
              const full = join(dir, e.name);
              if (e.isDirectory()) walk(full, depth + 1);
              else if (e.name.toLowerCase().includes(q)) candidates.push(full);
            }
          };
          for (const r of roots) walk(r, 0);
        }
        const hits = candidates
          .filter((p) => !p.split(sep).some((s) => s.startsWith("."))) // no hidden segments
          .filter((p) => basename(p).toLowerCase().includes(q) && (!kx || kx.test(p)) && isUnderRoots(p))
          .slice(0, 40);
        if (!hits.length) return `no ${kind === "any" ? "" : kind + " "}files matching "${query}".`;
        return hits.map((h) => `- ${basename(h)}: local://${h}`).join("\n");
      },
    }),
  };
  // Network/disk tools have no approval prompt, so the whole call is machine
  // time and safe to put on a deadline wholesale.
  return {
    ...t,
    web_search: deadlined(t.web_search, SLOW.net, (a) => `web_search: ${a.q}`),
    web_fetch: deadlined(t.web_fetch, SLOW.net, (a) => `web_fetch: ${a.url}`),
    search_files: deadlined(t.search_files, SLOW.net, (a) => `search_files: ${a.query}`),
  };
}

// Load user tools from <root>/tools/*.{ts,js}. Filename = tool name.
// A broken file is warned and skipped, never fatal. ponytail: startup-only scan.
// Bun imports .ts natively, so a plain dynamic import() is all we need.
export async function loadUserTools(): Promise<Record<string, Tool>> {
  const out: Record<string, Tool> = {};
  for (const root of ROOTS) {
    const dir = join(root, "tools");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (![".ts", ".js", ".mjs"].includes(extname(file))) continue;
      const name = basename(file, extname(file));
      try {
        const mod: any = await import(join(dir, file));
        const t = mod.default ?? mod.tool;
        if (!t) {
          console.error(`adhd: tool ${file} has no default export, skipping`);
          continue;
        }
        out[name] = t;
      } catch (e) {
        console.error(`adhd: failed to load tool ${file}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}
