import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { HOME_ROOT } from "./config.js";
import { confirmAction } from "./tools.js";
import { looksInjected } from "./security.js";

const execFileAsync = promisify(execFile);

// Memory is stored as an OKF bundle (https://okf.md/spec/): one markdown
// "concept" file per memory, YAML frontmatter (required `type`), body is
// freeform markdown. Concept id = path under the bundle minus ".md".
export const MEMORY_DIR = join(HOME_ROOT, "memory");
const RESERVED = new Set(["index.md", "log.md"]);

// `id` comes from the model — a trust boundary. Resolve and confirm the path
// stays inside the bundle so a crafted id (../, absolute) can't escape it.
export function memoryPath(id: string): string | null {
  const file = resolve(MEMORY_DIR, `${id}.md`);
  return file.startsWith(resolve(MEMORY_DIR) + sep) ? file : null;
}

// "explicit" = a direct remember call or a human editing memory through the
// web UI; "synthesized" = an approved reflect proposal. The distinction exists
// so a future automated pass can be built to never silently touch an explicit
// entry — nothing today auto-EDITS existing memories, but this establishes the
// invariant up front rather than bolting it on after something needs it.
export type MemoryOrigin = "explicit" | "synthesized";

export type Memory = {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  timestamp: string;
  body: string;
  origin: MemoryOrigin;
};

// Minimal frontmatter parse — no YAML dep, same spirit as parseSkill.
// Handles scalar fields plus inline `tags: [a, b]`.
export function parse(md: string, id: string): Memory {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = md.trim();
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split("\n")) {
      const c = line.indexOf(":");
      if (c === -1) continue;
      meta[line.slice(0, c).trim()] = line.slice(c + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const tags = (meta.tags ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return {
    id,
    type: meta.type || "note",
    title: meta.title || id,
    description: meta.description || "",
    tags,
    timestamp: meta.timestamp || "",
    body,
    // Missing on disk (every memory written before this field existed) defaults
    // to "explicit" — the safe default, since it either came from an unconfirmed
    // remember call or a human-approved reflect proposal, never from an
    // automated pass that could need this invariant.
    origin: meta.origin === "synthesized" ? "synthesized" : "explicit",
  };
}

export function serialize(m: Omit<Memory, "id">): string {
  const fm = [
    `type: ${m.type}`,
    `title: ${m.title}`,
    `description: ${m.description}`,
    `tags: [${m.tags.join(", ")}]`,
    `timestamp: ${m.timestamp}`,
    `origin: ${m.origin}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${m.body.trim()}\n`;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".md") && !RESERVED.has(e.name)) out.push(full);
  }
  return out;
}

export function loadMemories(): Memory[] {
  return walk(MEMORY_DIR).map((file) => {
    const id = relative(MEMORY_DIR, file).replace(/\.md$/, "");
    return parse(readFileSync(file, "utf8"), id);
  });
}

export function memoryPromptSection(mems: Memory[]): string {
  if (!mems.length) return "";
  const lines = mems.map((m) => `- ${m.id} (${m.type}): ${m.description}`).join("\n");
  return `\n\nYour memory (call recall with the id to load full detail; call remember to save durable facts):\n${lines}`;
}

// --- git-backed history -------------------------------------------------
// Memory is a folder of markdown, not a vector index — the whole point is that
// what's on disk is what the model reasons over, no embedding drift to trust.
// But a plain writeFileSync overwrite loses whatever the fact used to say the
// moment it changes. Making the bundle its own git repo fixes that for free:
// every save/delete becomes a commit, so "how did this change" is a `git log`
// / `git show` in ~/.adhd/memory away when you actually need it — nothing
// diffs or surfaces history unless you go look. Best-effort throughout: no
// git binary, a repo that failed to init, a concurrent commit racing another
// — none of that should ever block a memory save.
let repoReady: Promise<void> | null = null;

async function runGit(args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd: MEMORY_DIR });
  } catch {
    /* no git installed, nothing staged, or some other non-fatal case */
  }
}

function ensureMemoryRepo(): Promise<void> {
  if (!repoReady) {
    repoReady = (async () => {
      mkdirSync(MEMORY_DIR, { recursive: true });
      if (!existsSync(join(MEMORY_DIR, ".git"))) await runGit(["init", "-q"]);
    })();
  }
  return repoReady;
}

// Scoped via -c, not a global git config write — this identity only applies to
// commits inside adhd's own memory repo, never the user's project.
async function commitMemory(message: string): Promise<void> {
  await ensureMemoryRepo();
  await runGit(["add", "-A"]);
  await runGit(["-c", "user.name=adhd", "-c", "user.email=adhd@localhost", "commit", "-q", "-m", message]);
}

// Prepend a dated entry to log.md, newest-first. ponytail: dedups today's header only.
function appendLog(action: "Create" | "Update", id: string, description: string) {
  const path = join(MEMORY_DIR, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `* **${action}**: [${id}](/${id}.md) — ${description}`;
  let text = existsSync(path) ? readFileSync(path, "utf8") : "# Update Log\n";
  if (text.includes(`## ${date}`)) {
    text = text.replace(`## ${date}\n`, `## ${date}\n${entry}\n`);
  } else {
    text = text.replace(/^# Update Log\n?/, `# Update Log\n\n## ${date}\n${entry}\n`);
  }
  writeFileSync(path, text);
}

// Content-based identity, independent of whatever id the caller chose — a
// remember-happy model re-saving the same fact under a slightly different slug
// still fingerprints the same, so it's caught as a duplicate instead of piling
// up near-identical concepts.
export function memoryFingerprint(body: string): string {
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha1").update(normalized).digest("hex");
}

// --- tombstones ---------------------------------------------------------
// One JSON file per deleted memory's content fingerprint, so a later save (the
// model's own remember call, or a reflect proposal re-deriving the same fact
// from the same recurring conversation) can't silently bring back something a
// human deliberately removed. Lives alongside the git-backed memory repo, so
// deletions AND their tombstones ride the same commit history.
const TOMBSTONE_DIR = join(MEMORY_DIR, ".tombstones");
type Tombstone = { id: string; fingerprint: string; deletedAt: string; description: string };

function tombstonePath(fingerprint: string): string {
  return join(TOMBSTONE_DIR, `${fingerprint}.json`);
}

function recordTombstone(t: Tombstone): void {
  mkdirSync(TOMBSTONE_DIR, { recursive: true });
  writeFileSync(tombstonePath(t.fingerprint), JSON.stringify(t, null, 2));
}

function findTombstone(fingerprint: string): Tombstone | null {
  const file = tombstonePath(fingerprint);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Write (create or update) a memory concept. Shared by the remember tool and the
// web memory editor. `id` is path-safe-checked so a crafted id can't escape the bundle.
// `overrideTombstone` is a human-only escape hatch (web.ts's /memory route) —
// never exposed on the model-facing remember tool, since the whole point of a
// tombstone is that model output can't be the thing that clears it.
export function saveMemory(m: {
  id: string;
  type: string;
  title?: string;
  description: string;
  tags?: string[];
  body: string;
  origin: MemoryOrigin;
  overrideTombstone?: boolean;
}): { ok: boolean; existed: boolean; duplicateOf?: string; tombstoned?: boolean; message: string } {
  const file = memoryPath(m.id);
  if (!file) return { ok: false, existed: false, message: `invalid memory id "${m.id}"` };

  const fp = memoryFingerprint(m.body);
  const tomb = findTombstone(fp);
  if (tomb && !m.overrideTombstone)
    return {
      ok: false,
      existed: false,
      tombstoned: true,
      message: `a memory with this exact content was deleted (${tomb.deletedAt}) — not re-saving`,
    };

  const duplicate = loadMemories().find((mm) => mm.id !== m.id && memoryFingerprint(mm.body) === fp);
  if (duplicate)
    return {
      ok: false,
      existed: false,
      duplicateOf: duplicate.id,
      message: `already saved as memory "${duplicate.id}" — not duplicating`,
    };

  const existed = existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    serialize({
      type: m.type,
      title: m.title || m.id,
      description: m.description,
      tags: m.tags ?? [],
      timestamp: new Date().toISOString(),
      body: m.body,
      origin: m.origin,
    }),
  );
  appendLog(existed ? "Update" : "Create", m.id, m.description);
  void commitMemory(`${existed ? "Update" : "Create"} ${m.id}: ${m.description}`);
  return { ok: true, existed, message: `${existed ? "updated" : "saved"} memory ${m.id}` };
}

export function deleteMemory(id: string): { ok: boolean; message: string } {
  const file = memoryPath(id);
  if (!file) return { ok: false, message: `invalid memory id "${id}"` };
  if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, message: `no memory "${id}"` };
  const { body, description } = parse(readFileSync(file, "utf8"), id);
  recordTombstone({ id, fingerprint: memoryFingerprint(body), deletedAt: new Date().toISOString(), description });
  unlinkSync(file);
  void commitMemory(`Delete ${id}`);
  return { ok: true, message: `deleted memory ${id}` };
}

export function memoryTools(): Record<string, Tool> {
  return {
    remember: tool({
      description:
        "Save a fact to memory as an OKF concept. Only call this when the user explicitly asks you to remember something, or for a genuinely unique, durable fact about the user (a stable preference, their setup) worth recalling in future sessions. Do NOT save conversation trivia or anything derivable from the code. `id` is a path-like slug (e.g. 'preferences/style').",
      inputSchema: z.object({
        id: z.string().describe("path-like slug, no extension, e.g. preferences/style"),
        type: z.string().describe("concept type, e.g. preference, project-fact, reference"),
        title: z.string().optional(),
        description: z.string().describe("one-line summary shown in the memory list"),
        tags: z.array(z.string()).optional(),
        body: z.string().describe("the knowledge, as markdown"),
      }),
      execute: async ({ id, type, title, description, tags, body }) => {
        // remember used to write instantly and unconfirmed — reachable purely
        // from model output, including output derived from an injected tool
        // result. permissionMode "auto" keeps the old instant-write behavior;
        // "ask"/"normal" now require a nod, same gate bash/pip_install use.
        const suspicious = looksInjected(`${description}\n${body}`);
        const prompt =
          `remember "${id}": ${description}` +
          (suspicious ? "\n\n⚠ this content looks like it may contain embedded instructions — review before saving." : "");
        if (!(await confirmAction(prompt))) return "user declined to save this memory";
        const r = saveMemory({ id, type, title, description, tags, body, origin: "explicit" });
        return r.message;
      },
    }),
    recall: tool({
      description: "Load a memory's full content by id. Prefer this over guessing when memory lists a relevant concept.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const file = memoryPath(id);
        if (!file) return `invalid memory id "${id}"`;
        if (!existsSync(file) || !statSync(file).isFile()) {
          const ids = loadMemories().map((m) => m.id).join(", ") || "(none)";
          return `no memory "${id}". Available: ${ids}`;
        }
        return readFileSync(file, "utf8");
      },
    }),
  };
}
