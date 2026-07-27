import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { contentToText } from "./mcp.js";
import { cap, cleanMarkdown, confirmAction, keepRealImages, MAX_OUT } from "./tools.js";
import { rankChunks, extractImages } from "./extract.js";
import { recordFailure } from "./failcache.js";
import { withDeadline } from "./jobs.js";
import { HOME_ROOT, isUnderRoots, loadConfig } from "./config.js";

// One browser, one tool.
//
// Chrome DevTools MCP used to be wired in as a normal MCP server, which meant 29
// tool schemas (~27k chars) on EVERY request — more context than the system
// prompt and every other tool put together. It's now an internal engine: adhd
// speaks MCP to it, but the model only ever sees `browser`, and web_fetch is
// gone because reading a page is just another action on the same browser.
//
// ponytail: hardcoded launch args with one escape hatch. `browserArgs` in
// config.json replaces the list wholesale for anyone who wants a visible window
// or their real Chrome profile. Headless + the installed Chrome + a throwaway
// profile is the default because it never steals focus and needs no setup.
const DEFAULT_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--headless",
  "--channel=stable",
  "--isolated",
  "--viewport=1280x800",
  // Without this the server confines every file-writing tool to the OS temp dir,
  // and screenshots silently never appear where we asked. Safe here because the
  // only path we ever pass is shotPath() — no browser action takes a path from
  // the model.
  "--allow-unrestricted-paths",
];

// --- engine ----------------------------------------------------------------
// Connected once, lazily, on the first browser call — the old setup paid an npx
// spawn and a Chrome launch at every startup even for a chat that never browsed.
// Kept warm for the process lifetime, which is what makes "read a page, then
// click something on it" work: every action lands on the same live page.
let session: Promise<Client> | null = null;

function connect(): Promise<Client> {
  const client = new Client({ name: "adhd-browser", version: "0.1.0" });
  return client
    .connect(
      new StdioClientTransport({
        command: "npx",
        args: loadConfig().browserArgs ?? DEFAULT_ARGS,
        env: process.env as Record<string, string>,
      }),
    )
    .then(() => client);
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  // A failed launch must not poison the singleton, or every later call reports a
  // stale error from the one time Chrome wasn't ready.
  session ??= connect().catch((e) => {
    session = null;
    throw e;
  });
  const client = await session;
  return contentToText(await client.callTool({ name, arguments: args as any }));
}

/** Reset between tests; not used by the app. */
export function _resetBrowser(): void {
  session = null;
}

// --- action → MCP call ------------------------------------------------------
export const ACTIONS = ["read", "snapshot", "screenshot", "fill", "click", "type", "press", "eval"] as const;
export type Action = (typeof ACTIONS)[number];

// Actions that change the page rather than just look at it. They go through the
// same approval gate the Chrome MCP server had (trust:"read" — silent on
// permission mode "normal", a card on "ask").
const MUTATING = new Set<Action>(["fill", "click", "type", "press", "eval"]);

export type Args = {
  action: Action;
  url?: string;
  query?: string;
  uid?: string;
  values?: { uid: string; value: string }[];
  text?: string;
  key?: string;
  script?: string;
  fullPage?: boolean;
};

// Pull the page's readable text out of a CLONE of the DOM. Cloning matters: the
// extraction strips nav/footer/script nodes, and doing that to the live document
// would invalidate the uids a following snapshot/click depends on. Images come
// back as markdown `![alt](src)` so extractImages parses them unchanged.
const EXTRACT = `() => {
  const doc = document.body.cloneNode(true);
  doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,svg').forEach(e => e.remove());
  const md = [...doc.querySelectorAll('h1,h2,h3,h4,p,li,td,pre')]
    .map(e => (/^H\\d$/.test(e.tagName) ? '#'.repeat(+e.tagName[1]) + ' ' : '') + e.innerText.trim())
    .filter(Boolean).join('\\n\\n');
  const imgs = [...document.images]
    .filter(i => i.alt && i.naturalWidth > 100).slice(0, 8)
    .map(i => '![' + i.alt + '](' + i.src + ')').join('\\n');
  return md + '\\n\\n' + imgs;
}`;

export const shotPath = (now = Date.now()): string => join(HOME_ROOT, "shots", `${now}.png`);

/**
 * Map an action to the MCP call(s) it needs. Pure, so the wiring is testable
 * without launching Chrome. Returns a string instead of a plan when a required
 * argument is missing — the model gets told what to pass, not an exception.
 */
export function plan(a: Args): { calls: { name: string; args: Record<string, unknown> }[] } | string {
  switch (a.action) {
    case "read":
      if (!a.url) return "read needs a `url`.";
      return {
        calls: [
          { name: "navigate_page", args: { type: "url", url: a.url, timeout: 20_000 } },
          { name: "evaluate_script", args: { function: EXTRACT } },
        ],
      };
    case "snapshot":
      return { calls: [{ name: "take_snapshot", args: {} }] };
    case "screenshot":
      return {
        calls: [{ name: "take_screenshot", args: { filePath: shotPath(), fullPage: a.fullPage ?? false } }],
      };
    case "fill":
      if (!a.values?.length) return "fill needs `values` — a list of {uid, value} from a snapshot.";
      return { calls: [{ name: "fill_form", args: { elements: a.values } }] };
    case "click":
      if (!a.uid) return "click needs a `uid` — take a snapshot first to get one.";
      return { calls: [{ name: "click", args: { uid: a.uid } }] };
    case "type":
      if (!a.text) return "type needs `text`.";
      return { calls: [{ name: "type_text", args: { text: a.text } }] };
    case "press":
      if (!a.key) return "press needs a `key`, e.g. 'Enter'.";
      return { calls: [{ name: "press_key", args: { key: a.key } }] };
    case "eval":
      if (!a.script) return "eval needs a `script` — a JS arrow function, e.g. \"() => document.title\".";
      return { calls: [{ name: "evaluate_script", args: { function: a.script } }] };
  }
}

/**
 * evaluate_script doesn't hand back the value — it hands back a human sentence
 * with the value JSON-encoded in a fenced block ("Script ran on page and
 * returned:\n```json\n\"…\"\n```"). Unwrap it, or the page text arrives as one
 * escaped blob with literal \n and the whole extraction pipeline reads garbage.
 * Falls through to the raw string if the shape ever changes.
 */
export function unwrapScript(s: string): string {
  const fenced = /```json\n([\s\S]*?)\n```/.exec(s);
  if (!fenced) return s;
  try {
    const v = JSON.parse(fenced[1]);
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return fenced[1];
  }
}

/**
 * Turn a raw extracted page into what the model actually gets: the paragraphs
 * that match `query` (BM25, the rest dropped to save context), plus the page's
 * images — only those whose URL really serves an image. Same pipeline web_fetch
 * used; exported so it's testable without a browser.
 */
export async function formatRead(raw: string, query?: string): Promise<string> {
  const clean = cleanMarkdown(raw);
  if (!clean) return "the page came back empty — it may need a login, or be blocked.";
  const focused = query ? rankChunks(clean, query, MAX_OUT) : "";
  const imgs = await keepRealImages(extractImages(clean));
  const imgList = imgs.length ? `\n\nImages:\n${imgs.map((i) => `- ${i.alt}: ${i.src}`).join("\n")}` : "";
  return cap(focused || clean) + imgList;
}

// --- the tool ---------------------------------------------------------------
const DESCRIPTION =
  "Drive a real (headless) browser: read pages, fill forms, click, and screenshot. " +
  "actions — " +
  "'read' (pass `url`, and ALWAYS a `query` describing what you want off the page; returns only the relevant parts as markdown) — use this to read ANY known URL; " +
  "'snapshot' (the current page's elements with a `uid` each — take one before any click/fill); " +
  "'screenshot' (`fullPage` optional; saves a PNG and returns a local:// path — show it with render_ui as an Image); " +
  "'fill' (`values`: [{uid, value}] — fill a whole form in ONE call, not one per field); " +
  "'click' (`uid`); 'type' (`text` into the focused element); 'press' (`key`, e.g. 'Enter'); " +
  "'eval' (`script`: a JS arrow function, last resort). " +
  "The page stays open between calls, so read → snapshot → fill → press → read all work on the same session. " +
  "To find a URL in the first place, use web_search.";

function browserTool(): Tool {
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(ACTIONS),
      url: z.string().url().optional().describe("action 'read': the page to open"),
      query: z.string().optional().describe("action 'read': what you're looking for on the page"),
      uid: z.string().optional().describe("action 'click': element uid from a snapshot"),
      values: z
        .array(z.object({ uid: z.string(), value: z.string() }))
        .optional()
        .describe("action 'fill': one entry per field"),
      text: z.string().optional().describe("action 'type'"),
      key: z.string().optional().describe("action 'press', e.g. 'Enter'"),
      script: z.string().optional().describe("action 'eval': a JS arrow function"),
      fullPage: z.boolean().optional().describe("action 'screenshot': whole page instead of the viewport"),
    }),
    execute: async (a: Args) => {
      const p = plan(a);
      if (typeof p === "string") return p;

      if (MUTATING.has(a.action)) {
        const detail = a.uid ?? a.text ?? a.key ?? JSON.stringify(a.values ?? a.script ?? "");
        // trusted:true matches what the Chrome MCP server had (trust:"read") —
        // silent on permission mode "normal", still a card on "ask".
        if (!(await confirmAction(`browser ${a.action}: ${cap(detail, 120)}`, true)))
          return "User declined this browser action.";
      }

      if (a.action === "screenshot") mkdirSync(join(HOME_ROOT, "shots"), { recursive: true });

      let out = "";
      try {
        for (const c of p.calls) out = await call(c.name, c.args);
      } catch (e) {
        const msg = (e as Error).message;
        if (a.url) recordFailure(a.url, msg);
        return `browser ${a.action} failed: ${msg}. The browser needs Chrome installed and network access to npx; this does NOT mean you lack internet.`;
      }

      if (a.action === "read") {
        const page = unwrapScript(out);
        if (!page.trim()) {
          recordFailure(a.url!, "empty page");
          return `could not read ${a.url} — the page came back empty. Try a different URL.`;
        }
        return formatRead(page, a.query);
      }
      if (a.action === "eval") return cap(unwrapScript(out));
      if (a.action === "screenshot") {
        const path = (p.calls[0].args as { filePath: string }).filePath;
        return isUnderRoots(path)
          ? `screenshot saved. Show it with render_ui as an Image whose src is "local://${path}".`
          : `screenshot saved to ${path}, but it's outside your allowed folders so it can't be displayed — add ${HOME_ROOT} in Settings → Files.`;
      }
      return cap(out);
    },
  });
}

// The first call pays an npx cold start plus a Chrome launch, so it gets a
// longer leash than SLOW.net's 20s before withDeadline backgrounds it.
export function browserTools(): Record<string, Tool> {
  const t = browserTool();
  const inner = t.execute!;
  return {
    browser: {
      ...t,
      execute: (a: Args, opts: any) =>
        withDeadline(`browser ${a.action}${a.url ? `: ${a.url}` : ""}`, 40_000, async () =>
          String(await inner(a, opts)),
        ),
    } as Tool,
  };
}
