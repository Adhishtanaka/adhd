import { join } from "node:path";
import { existsSync } from "node:fs";
import { marked } from "marked";
import { buildAgent } from "./setup.js";
import { setBashConfirm, setAskUser, orAfter } from "./tools.js";
import { setSubagentSink } from "./subagent.js";
import { setRenderSink, carriesAnswer } from "./render.js";
import { sanitize } from "./sanitize.js";
import { listFailures, clearFailures, removeDomain } from "./failcache.js";
import { KNOWN_MODELS, KEY_NAMES, keyStatus, writeSecret, loadSecretsIntoEnv, isUnderRoots, allowedRoots, setLocalRoots, allowedCommands, setAllowedCommands, mcpServers, setMcpServers, setCustomBaseURL, loadConfig, capabilities, setCapabilities, permissionMode, setPermissionMode, disabledTools, setDisabledTools, splitSpec, PROVIDER_KEY, CAPABILITIES, type Capabilities, type KeyName } from "./config.js";
import { setJobSinks, type FinishedJob } from "./jobs.js";
import { loadMemories, saveMemory, deleteMemory } from "./memory.js";
import { loadSchedule, saveSchedule, isDue, parseAt, type Task } from "./scheduler.js";
import { loadFlows, saveFlows, seedExamples, toolArgSpecs, RunControl, type Flow } from "./flows.js";
import { migrateMcpDefaults, mcpCatalog } from "./mcp.js";
import { todoItems, setTodoSink, resetTodos, loadTodos, type TodoItem } from "./todo.js";
import type { Agent } from "./agent.js";

// The AI SDK leaves some internal promises unawaited on error; swallow the stray
// rejections so they don't crash the server (real errors reach the client).
process.on("unhandledRejection", () => {});

loadSecretsIntoEnv(); // hydrate API keys from ~/.adhd/secrets.json before building
migrateMcpDefaults(); // drop the old seeded Chrome server — must precede buildAgent's loadMcpTools
const built = await buildAgent();
setTodoSink((items) => broadcast("todos", { items })); // agent's plan → the strip under the composer
seedExamples(); // first run: put a few worked examples on the Flows page

// Prefer public/ next to the source; fall back to cwd/public (compiled binary,
// where import.meta.dir isn't a real directory).
const PUBLIC = existsSync(join(import.meta.dir, "..", "public", "index.html"))
  ? join(import.meta.dir, "..", "public")
  : join(process.cwd(), "public");
const PORT = Number(process.env.ADHD_PORT ?? 8787);
const enc = new TextEncoder();

// --- sessions ---------------------------------------------------------------
// One conversation per browser, keyed by an httpOnly cookie. Before this there
// was a single agent and a single client set, so two windows shared one history
// and each saw the other's transcript stream past. Only the CONVERSATION is
// per-session: keys, config, memory, skills, flows and the schedule are the
// user's machine, not the chat, and stay shared.
//
// ponytail: in RAM, no persistence — history already died with the process, so
// this only stops tabs colliding. It is NOT an access control: same browser
// means same cookie, so it does not stop someone at your keyboard reading the
// chat. A passcode is the upgrade for that.
type Session = {
  id: string;
  agent: Agent;
  clients: Set<ReadableStreamDefaultController>;
  todos: TodoItem[];
  seen: number;
};
const sessions = new Map<string, Session>();
const SID_COOKIE = "adhd_sid";
// A browser that never comes back should not pin its history forever.
const SESSION_TTL = 60 * 60_000;

// Background work — a scheduled task, a finished job — has no browser behind it.
// It runs against this one when no real session exists, so runTurn always has an
// agent to talk to and its output simply goes nowhere (no clients), which is
// already what happened when nothing was connected.
let systemSession: Session;

// Whose turn is running right now. adhd runs exactly ONE turn at a time — `busy`
// gates chat, flows, job drains and the scheduler alike — so a single pointer is
// enough to route every global tool sink (confirm, ask, subagent, render_ui,
// todos) back to the session that asked for the work, with no session id
// threaded through any tool signature.
let active: Session | null = null;

// --- SSE broadcast ----------------------------------------------------------
function send(target: Session, chunk: Uint8Array) {
  for (const c of target.clients) {
    try {
      c.enqueue(chunk);
    } catch {
      /* dropped client */
    }
  }
}
/** To one session — by default whichever one's turn is currently running. */
function broadcast(event: string, data: unknown, target: Session | null = active) {
  if (!target) return;
  send(target, enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
/**
 * To every attached browser. Only for facts that are genuinely machine-wide:
 * `busy` (one turn at a time, so everyone is blocked), a model switch, and Flows
 * page progress (one shared canvas). Anything conversational must not use this.
 */
function broadcastAll(event: string, data: unknown) {
  const chunk = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const s of sessions.values()) send(s, chunk);
}

function makeSession(id: string): Session {
  return { id, agent: built.newAgent(), clients: new Set(), todos: [], seen: Date.now() };
}
systemSession = makeSession("system"); // kept out of `sessions`, so no cookie can name it
/** The session named by the request's cookie, created on first sight. */
function sessionFor(req: Request): Session {
  const id = req.headers.get("cookie")?.match(/(?:^|;\s*)adhd_sid=([^;]+)/)?.[1];
  const found = id ? sessions.get(id) : undefined;
  if (found) {
    found.seen = Date.now();
    return found;
  }
  const s = makeSession(id && /^[\w-]{8,64}$/.test(id) ? id : crypto.randomUUID());
  sessions.set(s.id, s);
  return s;
}
/**
 * Where unattended output should land: the most recently used real session, so a
 * scheduled task appears in the transcript someone is actually looking at rather
 * than in all of them at once.
 */
function ownerSession(): Session {
  let best: Session | null = null;
  for (const s of sessions.values()) if (!best || s.seen > best.seen) best = s;
  return best ?? systemSession;
}
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) {
    if (s.clients.size || s.seen > cutoff) continue;
    built.dropAgent(s.agent);
    sessions.delete(id);
  }
}, 10 * 60_000);

// --- interactive bridge: confirm / ask / subagent → SSE, answered via POST ---
const pending = new Map<string, (v: unknown) => void>();
// token → the allowKey this prompt may grant. Kept server-side so "always allow"
// can only ever store the key WE derived, not whatever the page posts back.
const pendingAllowKey = new Map<string, string>();

// A prompt nobody answers must not hold the turn open forever. An unattended run
// (a scheduled task, a Flow) broadcasts its confirm to whatever SSE clients exist
// — possibly none, since broadcast is fire-and-forget and a reconnecting page
// never sees the missed event. Without a deadline `busy` would stay true for good,
// and the scheduler tick skips every fire while busy: adhd wedged until restart.
// ponytail: timeout → the safe answer. Parking the ask so it can be answered later
// (an inbox) is the upgrade if unattended runs ever need to *complete* rather than
// just fail safely.
const APPROVAL_TIMEOUT = 5 * 60_000;

// Drop a prompt's server-side state and tell the transcript why. Called only on
// timeout; an answered prompt is cleaned up by the /confirm and /ask routes.
function expire(token: string, note: string): void {
  pending.delete(token);
  pendingAllowKey.delete(token);
  broadcast("info", { message: note });
}

setBashConfirm(({ command, explain, allowKey }) => {
  const token = crypto.randomUUID();
  const answered = new Promise<boolean>((resolve) => {
    pending.set(token, (v) => resolve(!!v));
    if (allowKey) pendingAllowKey.set(token, allowKey);
    broadcast("confirm", { token, command, explain, allowKey });
  });
  // Unanswered means declined — the same default tools.ts uses when headless.
  return orAfter(answered, APPROVAL_TIMEOUT, false, () =>
    expire(token, "no answer in 5 min — command declined"),
  );
});
setAskUser((question, options) => {
  const token = crypto.randomUUID();
  const fallback = options[0] ?? "";
  const answered = new Promise<string>((resolve) => {
    pending.set(token, (v) => resolve(String(v ?? fallback)));
    broadcast("ask", { token, question, options });
  });
  return orAfter(answered, APPROVAL_TIMEOUT, fallback, () =>
    expire(token, `no answer in 5 min — using "${fallback}"`),
  );
});
setSubagentSink((line) => broadcast("sub", { line }));
// Text nodes carry markdown (bold, lists, inline code). Render it to safe HTML
// here — reusing the same marked+sanitize path as assistant prose — so the
// client can drop it in as innerHTML instead of showing literal ** and #.
// Every *Html prop below is ALWAYS server-derived from the matching text prop
// and sanitized — never trust a model-supplied html field (the client drops
// these into innerHTML, so a raw html value here would be a straight XSS bypass).
const mdBlock = (s: string) => sanitize(marked.parse(s) as string);
// Inline: no wrapping <p>, for text that sits in a heading, a title or an <li>.
const mdInline = (s: string) => sanitize(marked.parseInline(s) as string);

setRenderSink((spec) => {
  for (const el of Object.values(spec.elements ?? {})) {
    const p = el.props as Record<string, unknown> | undefined;
    if (!p) continue;
    // Models write markdown in every text field, not just Text — a bolded label
    // in a card title or a link in a list item came through as literal
    // asterisks. Each of these gets the same sanitize-then-render treatment.
    if (el.type === "Text") {
      if (typeof p.content === "string") p.html = mdBlock(p.content);
      else delete p.html;
    } else if (el.type === "Heading" || el.type === "Card") {
      for (const k of ["content", "title"]) {
        if (typeof p[k] === "string") p[`${k}Html`] = mdInline(p[k] as string);
        else delete p[`${k}Html`];
      }
    } else if (el.type === "List") {
      p.itemsHtml = Array.isArray(p.items)
        ? p.items.map((i: unknown) => mdInline(String(i ?? "")))
        : undefined;
    }
  }
  // Ship the verdict with the spec rather than letting the browser re-derive it:
  // the model was being told one thing and the transcript deciding another (a Map
  // counted as media client-side and as a finished answer server-side), so the
  // prose was suppressed at the source and kept at the sink, or vice versa.
  broadcast("render_ui", { spec, carries: carriesAnswer(spec) });
});


function summarize(args: unknown): string {
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    const v = o.q ?? o.command ?? o.path ?? o.pattern ?? o.url ?? o.task ?? o.id ?? o.query;
    if (v != null) return String(v).slice(0, 80);
  }
  return "";
}

// --- run a turn (one at a time) --------------------------------------------
// Still one at a time across the whole machine: sessions separate the histories,
// not the execution. `busy` therefore stays global and is announced to everyone,
// because a second browser really is blocked while this runs — its composer
// queues the message rather than pretending it can start.
let busy = false;
async function runTurn(message: string, s: Session) {
  busy = true;
  active = s; // routes every tool sink at this session for the whole turn
  loadTodos(s.todos); // its checklist, not whoever ran last
  broadcastAll("busy", { busy: true });
  let assistant = "";
  try {
    await s.agent.send(message, (e) => {
      switch (e.type) {
        case "text":
          assistant += e.delta;
          broadcast("text", { delta: e.delta });
          break;
        case "tool-call":
          broadcast("tool-call", { id: e.id, name: e.name, summary: summarize(e.args) });
          break;
        case "tool-result":
          broadcast("tool-result", { id: e.id });
          break;
        case "usage":
          broadcast("usage", { total: e.total });
          break;
        case "context":
          broadcast("context", e.stats);
          break;
        // Summary goes over as plain text, not rendered markdown: it's a prose
        // blob dense with figures like "~400 words", which GFM reads as
        // strikethrough. Nothing to sanitize either, since nothing becomes HTML.
        case "compaction":
          broadcast("compaction", { items: e.items, pruned: e.pruned, summary: e.summary });
          break;
        case "info":
          broadcast("info", { message: e.message });
          break;
        case "error":
          broadcast("error", { message: e.message });
          break;
      }
    });
    broadcast("done", { html: sanitize(await marked.parse(assistant)) });
  } catch (err) {
    broadcast("error", { message: (err as Error)?.message ?? String(err) });
    broadcast("done", { html: "" });
  } finally {
    s.todos = todoItems(); // hand the checklist back before another session's turn
    active = null;
    busy = false;
    broadcastAll("busy", { busy: false });
    // A job may have landed while this turn was running — pick it up now that the
    // agent is free. Debounced (not a direct call) so any siblings still landing
    // coalesce into the same next turn, and it runs on a clean stack.
    scheduleDrain();
  }
}

// --- background jobs: a slow tool ends its turn, then wakes the agent ---------
// A tool that blows its deadline hands the turn back (see jobs.ts) so the UI
// goes idle and the user can keep chatting. Its result arrives here later and is
// replayed to the agent as a new turn — one at a time, never while it's busy.
const finishedJobs: FinishedJob[] = [];
// Coalesce completions that land close together into ONE turn. Backgrounding N
// fetches used to wake the agent N times → N near-duplicate replies stacked under
// the answer. A short trailing debounce lets a burst of finishes drain together.
const DRAIN_DEBOUNCE_MS = 1000;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDrain() {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainJobs();
  }, DRAIN_DEBOUNCE_MS);
}
// A job finishes long after the turn that started it, so `active` is null by
// then. Send the notice to the session most recently in use — the one whose
// transcript the answer is going to be folded into by drainJobs below.
setJobSinks(
  (j) => {
    finishedJobs.push(j);
    broadcast("info", { message: `[${j.id}] ${j.label} — finished after ${j.seconds}s` }, ownerSession());
    scheduleDrain();
  },
  (id, label) =>
    broadcast("info", { message: `[${id}] ${label} — still running, continuing in the background` }, ownerSession()),
);
function drainJobs() {
  if (busy || !finishedJobs.length || !built.hasKey()) return;
  const owner = ownerSession();
  const jobs = finishedJobs.splice(0); // take every finished job — one turn, not one each
  broadcast("notify", { title: "Background task finished", body: jobs.map((j) => j.label).join(", ") }, owner);
  const results = jobs
    .map((j) => `[job ${j.id} "${j.label}" — finished in ${j.seconds}s]\n${j.result}`)
    .join("\n\n---\n\n");
  const lead =
    jobs.length === 1
      ? `A background job you started earlier just finished.`
      : `${jobs.length} background jobs you started earlier just finished.`;
  void runTurn(
    `${lead} These are the results of tool calls you backgrounded — do not re-run that work.\n\n${results}\n\n` +
      `Fold them into the answer the user was waiting for, in ONE short reply. If the results add nothing ` +
      `beyond what you already told the user, end your turn with no message rather than repeating yourself.`,
    owner,
  );
}

// --- flows: run a saved graph, streaming progress to the Flows page ----------
// Shares the same `busy` flag as chat, so a flow and a chat turn never run at
// once (they'd fight over the same agent history and the same tool confirms).
let currentRun: RunControl | null = null; // the in-flight flow, for pause/stop
async function runFlowById(id: string): Promise<void> {
  const flow = loadFlows().find((f) => f.id === id);
  if (!flow) return;
  busy = true;
  // The Flows page is one shared canvas, so its progress goes to everyone — but
  // a flow still runs tools, and those sinks need a transcript to land in.
  active = ownerSession();
  currentRun = new RunControl();
  broadcastAll("busy", { busy: true });
  broadcastAll("flow", { type: "run-start", name: flow.name });
  try {
    await built.runFlow(flow, (e) => broadcastAll("flow", e), currentRun);
  } catch (err) {
    broadcastAll("flow", { type: "node-error", id: "", ms: 0, message: (err as Error)?.message ?? String(err) });
  } finally {
    currentRun = null;
    active = null;
    busy = false;
    broadcastAll("busy", { busy: false });
    scheduleDrain();
  }
}

// --- scheduler tick (moved from the Ink UI) ---------------------------------
const lastRun: Record<string, number> = {};
setInterval(() => {
  if (busy || !built.hasKey()) return;
  const now = new Date();
  for (const t of loadSchedule()) {
    if (isDue(t, now, lastRun[t.id])) {
      lastRun[t.id] = now.getTime();
      // Nobody asked for this, so it lands in the transcript most recently in use
      // rather than in every open window at once.
      const owner = ownerSession();
      broadcast("info", { message: `[scheduled] ${t.id}` }, owner);
      broadcast("notify", { title: `Scheduled: ${t.id}`, body: t.prompt }, owner);
      // A prompt of "flow:<id>" runs a saved flow instead of a chat turn — reuses
      // the existing schedule format, so no migration and no extra UI.
      if (t.prompt.startsWith("flow:")) void runFlowById(t.prompt.slice(5).trim());
      else void runTurn(t.prompt, owner);
      break; // one at a time
    }
  }
}, 30_000);

// --- HTML fragments (HTMX targets) ------------------------------------------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Every section is rendered INLINE, not as a nested `hx-trigger="load"` div that
// fetches itself. Those self-loading children raced the parent: re-swapping
// #settings (saving a key returns a fresh fragment) detached them while their
// own request was still in flight, and htmx then threw on the null target —
// which aborted processing, leaving the sections BELOW it permanently empty.
// These are all cheap local file reads, so inlining costs nothing and removes
// five round-trips along with the race. The /memory, /schedule, /roots,
// /allowed and /failures endpoints still exist — the forms POST to them and
// swap the result into #mem, #sched, etc.
function settingsFragment(): string {
  const ks = keyStatus();
  const keyRows = KEY_NAMES.map(
    (k) => `<div class="row">
        <span class="mono">${k}</span>
        <span class="badge ${ks[k] ? "ok" : "off"}">${ks[k] ? "••••set" : "not set"}</span>
        <form hx-post="/keys" hx-target="#settings" hx-swap="innerHTML" class="inline">
          <input type="password" name="${k}" placeholder="paste to replace" autocomplete="off" />
          <button class="btn">Save</button>
        </form>
      </div>`,
  ).join("");
  // Appearance + Notifications are client-only (theme in localStorage, notif
  // permission in the browser); app.js wires #appearance-select / #notif-toggle
  // on each settings swap. Everything else is server state via HTMX fragments.
  //
  // Nine flat sections was one long scroll, so they're grouped by the question
  // each answers. <details> gives collapse with no JS and keyboard support for
  // free; only the group you most often come here to change starts open. A swap
  // of #settings re-renders this, so open/closed resets to these defaults.
  const group = (title: string, note: string, body: string, open = false): string =>
    `<details class="settings-group"${open ? " open" : ""}>
      <summary>${title}${note ? ` <span class="muted">${note}</span>` : ""}</summary>
      ${body}
    </details>`;

  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  return (
    group(
      "Keys",
      "models and web search",
      `<p class="muted">Stored in <span class="mono">~/.adhd/secrets.json</span> (chmod 600). Keys never leave this machine.
       You only need a key for the provider you actually use — a model is named <span class="mono">provider:id</span>
       (<span class="mono">anthropic:claude-sonnet-5</span>), and a bare id means DeepSeek.</p>
      <div class="settings-section">${keyRows}</div>
      <h2>Any other model <span class="muted">(not in the dropdown)</span></h2>
      <div class="settings-section">
        <div class="row">
          <span class="mono">model</span>
          <form hx-post="/model" hx-target="#settings" hx-swap="innerHTML" class="inline">
            <input name="id" placeholder="e.g. anthropic:claude-fable-5" value="" autocomplete="off" />
            <button class="btn">Use</button>
          </form>
        </div>
        <div class="row">
          <span class="mono">custom: base URL</span>
          <form hx-post="/base-url" hx-target="#settings" hx-swap="innerHTML" class="inline">
            <input name="url" placeholder="https://openrouter.ai/api/v1" value="${loadConfig().customBaseURL ?? ""}" autocomplete="off" />
            <button class="btn">Save</button>
          </form>
        </div>
      </div>`,
      true,
    ) +
    group(
      "Capabilities",
      `${built.toolNames.length} of ${built.allToolNames.length} tools active`,
      `<p class="muted">Everything switched on here is sent to the model on every message, whether you use it or not.
       Switch off what this chat doesn't need and the context goes further.</p>
      <div class="settings-section">${capsFragment()}</div>`,
    ) +
    group(
      "Permissions",
      MODE_LABEL[permissionMode()][0].toLowerCase(),
      `<p class="muted">When adhd should stop and ask before doing something to your machine.</p>
      <div class="settings-section">${permissionsFragment()}</div>`,
    ) +
    group(
      "What adhd may do",
      `${n(allowedRoots().length, "folder")} · ${n(allowedCommands().length, "command")} · ${n(Object.keys(mcpServers()).length, "server")}`,
      `<h2>Local folders <span class="muted">(files adhd may read)</span></h2>
      <div class="settings-section"><div id="roots">${rootsFragment()}</div></div>
      <h2>Always-allowed commands <span class="muted">(run without asking)</span></h2>
      <div class="settings-section"><div id="allowed">${allowedFragment()}</div></div>
      <h2>MCP servers <span class="muted">(extra tools)</span></h2>
      <div class="settings-section"><div id="mcp">${mcpFragment()}</div></div>`,
    ) +
    group(
      "What adhd remembers",
      `${n(built.memoryIds.length, "memory", "memories")} · ${n(loadSchedule().length, "task")}`,
      `<h2>Memory</h2>
      <div class="settings-section"><div id="mem">${memoryFragment()}</div></div>
      <h2>Schedule</h2>
      <div class="settings-section"><div id="sched">${scheduleFragment()}</div></div>`,
    ) +
    group(
      "App",
      "appearance, notifications, blocked pages",
      `<h2>Appearance</h2>
      <div class="settings-section">
        <div class="row">
          <span>Theme</span>
          <select id="appearance-select">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </div>
      <h2>Notifications</h2>
      <div class="settings-section">
        <div class="row">
          <span>Notify when a scheduled task runs</span>
          <label class="switch"><input type="checkbox" id="notif-toggle" /><span class="track"></span></label>
        </div>
      </div>
      <h2>Blocked pages <span class="muted">(fetch failures)</span></h2>
      <div class="settings-section"><div id="fails">${failuresFragment()}</div></div>`,
    )
  );
}

function rootsFragment(): string {
  const rows = allowedRoots()
    .map(
      (r) => `<div class="row">
        <span class="mono">${esc(r)}</span>
        <button class="btn ghost" hx-post="/roots/delete" hx-vals='{"root":"${esc(r)}"}' hx-target="#roots" hx-swap="innerHTML">Remove</button>
      </div>`,
    )
    .join("");
  return `${rows}
    <form hx-post="/roots" hx-target="#roots" hx-swap="innerHTML" class="stack">
      <input name="root" placeholder="/absolute/path/to/folder" required />
      <button class="btn">Add folder</button>
    </form>`;
}

function allowedFragment(): string {
  const rows = allowedCommands()
    .map((k) => {
      const [runner, prog] = k.split(":");
      return `<div class="row">
        <span class="mono">${esc(prog ?? k)} <span class="muted">(${esc(runner ?? "")})</span></span>
        <button class="btn ghost" hx-post="/allowed/delete" hx-vals='{"key":"${esc(k)}"}' hx-target="#allowed" hx-swap="innerHTML">Revoke</button>
      </div>`;
    })
    .join("");
  return rows || '<p class="muted">None. Approving a command with “Always allow” adds it here.</p>';
}

// MCP servers are launched once at startup (see mcp.ts), so edits here land on
// the next run rather than mid-session — say so instead of pretending otherwise.
// ponytail: config editor, not a live connection manager. Hot-connecting a new
// server is the upgrade if editing these turns out to be a frequent thing.
// A toggle that POSTs its new value straight away. `on` is the current state;
// clicking sends the opposite, so there's no Save button to forget.
function toggleRow(label: string, note: string, on: boolean, post: string, vals: Record<string, unknown>): string {
  // HTMX lives on the <input>, not the wrapper, so the control stays reachable
  // by keyboard and `change` fires for space/enter as well as a click.
  return `<label class="row">
      <span>${label}${note ? ` <span class="muted">${note}</span>` : ""}</span>
      <span class="switch">
        <input type="checkbox" ${on ? "checked" : ""}
          hx-post="${post}" hx-trigger="change" hx-vals='${esc(JSON.stringify({ ...vals, on: !on }))}'
          hx-target="#settings" hx-swap="innerHTML" /><span class="track"></span>
      </span>
    </label>`;
}

const CAP_LABEL: Record<keyof Capabilities, [string, string]> = {
  files: ["Files", "read, write, search your files"],
  shell: ["Shell", "bash, powershell, scripts"],
  web: ["Web", "search and fetch pages"],
  memory: ["Memory", "remember facts across sessions"],
  skills: ["Skills", "instruction packs it loads on demand"],
  schedule: ["Schedule", "run things later"],
  mcp: ["MCP servers", "tools from other programs"],
  subagents: ["Subagents", "delegate and iterate"],
  flows: ["Run flows from chat", "the Flows page keeps working"],
  renderUi: ["Rich replies", "charts, maps, galleries"],
  todo: ["Task list", "show its plan while it works"],
};

// Every group here is context you pay for on every request, so the counts are
// the point of the screen, not decoration.
function capsFragment(): string {
  const caps = capabilities();
  const rows = (Object.keys(CAPABILITIES) as (keyof Capabilities)[])
    .map((k) => toggleRow(CAP_LABEL[k][0], CAP_LABEL[k][1], caps[k], "/capabilities", { cap: k }))
    .join("");
  const on = built.toolNames.length;
  const total = built.allToolNames.length;
  return `${rows}
    <p class="muted">${on} of ${total} tools active. Switching a group off removes its tools and its slice of the
    system prompt from every request — that's the context it stops costing you. Takes effect on your next message.
    Turning MCP back on needs a restart, because the servers connect at startup.</p>`;
}

const MODE_LABEL: Record<string, [string, string]> = {
  ask: ["Ask every time", "nothing runs unseen — ignores the always-allow list and read-only MCP servers"],
  normal: ["Normal", "asks before anything that changes your machine, minus what you've already allowed"],
  auto: ["Approve everything", "never asks. Only for a sandbox you don't mind losing"],
};

function permissionsFragment(): string {
  const mode = permissionMode();
  const rows = ["ask", "normal", "auto"]
    .map(
      (m) => `<label class="row">
        <span>${MODE_LABEL[m][0]} <span class="muted">${MODE_LABEL[m][1]}</span></span>
        <input type="radio" name="mode" value="${m}" ${m === mode ? "checked" : ""}
          hx-post="/permissions" hx-vals='{"mode":"${m}"}' hx-target="#settings" hx-swap="innerHTML" />
      </label>`,
    )
    .join("");
  return `${rows}${mode === "auto" ? '<p class="muted" style="color:rgb(var(--c-negative))">Every shell command, file write and MCP call runs without asking.</p>' : ""}`;
}

function mcpFragment(): string {
  const servers = mcpServers();
  const cat = mcpCatalog();
  const off = disabledTools();
  const rows = Object.entries(servers)
    .map(([name, s]) => {
      // Its tools, collapsed — a big server can bring dozens, which is a wall
      // of text until you actually want to switch one off.
      const tools = cat[name] ?? [];
      const live = tools.filter((t) => !off.has(t.full)).length;
      const list = tools
        .map((t) =>
          toggleRow(
            `<span class="mono">${esc(t.name)}</span>`,
            esc(t.description.split("\n")[0].slice(0, 80)),
            !off.has(t.full),
            "/mcp/tool",
            { tool: t.full },
          ),
        )
        .join("");
      return `<div class="row">
        <div><span class="mono">${esc(name)}</span>
          <span class="muted">${esc([s.command, ...(s.args ?? [])].join(" "))}</span>
          <span class="badge ${s.trust === "read" ? "ok" : ""}">${s.trust === "read" ? "read-only" : "asks first"}</span></div>
        <button class="btn ghost" hx-post="/mcp/delete" hx-vals='{"name":"${esc(name)}"}' hx-target="#mcp" hx-swap="innerHTML" hx-confirm="Remove ${esc(name)}?">Remove</button>
      </div>
      ${tools.length ? `<details class="settings-group"><summary>${tools.length} tools <span class="muted">${live} on</span></summary>${list}</details>` : ""}`;
    })
    .join("");
  const loaded = built.toolNames.filter((n) => Object.keys(servers).some((s) => n.startsWith(`${s}_`))).length;
  return `${rows || '<p class="muted">None. Add a server to give adhd tools it doesn\'t ship with.</p>'}
    <form hx-post="/mcp" hx-target="#mcp" hx-swap="innerHTML" class="stack">
      <input name="name" placeholder="name (e.g. notes)" required />
      <input name="command" placeholder="command (e.g. npx)" required />
      <input name="args" placeholder="arguments, space-separated (e.g. -y @some/notes-mcp)" />
      <label class="row"><span>Read-only — run its tools without asking</span>
        <input type="checkbox" name="trust" value="read" /></label>
      <button class="btn">Add server</button>
    </form>
    <p class="muted">${loaded} tool${loaded === 1 ? "" : "s"} loaded. Switching individual tools off applies to your next
    message; adding or removing a server needs a restart.</p>`;
}

function failuresFragment(): string {
  const rows = listFailures()
    .map(
      (f) => `<div class="row">
        <div><span class="mono">${esc(f.domain)}</span> <span class="badge">${f.count}×</span> <span class="muted">${esc(f.reason)}</span></div>
        <button class="btn ghost" hx-post="/failures/delete" hx-vals='{"domain":"${esc(f.domain)}"}' hx-target="#fails" hx-swap="innerHTML">Unblock</button>
      </div>`,
    )
    .join("");
  return `${rows || '<p class="muted">No failed fetches. Domains that fail twice get dropped from search.</p>'}
    ${listFailures().length ? `<button class="btn ghost" hx-post="/failures/clear" hx-target="#fails" hx-swap="innerHTML">Clear all</button>` : ""}`;
}

function memoryFragment(): string {
  const rows = loadMemories()
    .map(
      (m) => `<div class="row">
        <div><span class="mono">${esc(m.id)}</span> <span class="muted">${esc(m.description)}</span></div>
        <button class="btn ghost" hx-post="/memory/delete" hx-vals='{"id":"${esc(m.id)}"}' hx-target="#mem" hx-swap="innerHTML" hx-confirm="Delete ${esc(m.id)}?">Delete</button>
      </div>`,
    )
    .join("");
  return `${rows || '<p class="muted">No memories.</p>'}
    <form hx-post="/memory" hx-target="#mem" hx-swap="innerHTML" class="stack">
      <input name="id" placeholder="id, e.g. preferences/style" required />
      <input name="description" placeholder="one-line summary" required />
      <textarea name="body" placeholder="the fact / detail" required></textarea>
      <button class="btn">Add memory</button>
    </form>`;
}

function scheduleFragment(): string {
  const rows = loadSchedule()
    .map(
      (t) => `<div class="row">
        <div><span class="mono">${esc(t.id)}</span> <span class="badge">${esc(t.at)}</span> <span class="muted">${esc(t.prompt)}</span></div>
        <button class="btn ghost" hx-post="/schedule/delete" hx-vals='{"id":"${esc(t.id)}"}' hx-target="#sched" hx-swap="innerHTML">Delete</button>
      </div>`,
    )
    .join("");
  return `${rows || '<p class="muted">No scheduled tasks.</p>'}
    <form hx-post="/schedule" hx-target="#sched" hx-swap="innerHTML" class="stack">
      <input name="id" placeholder="id" required />
      <input name="at" placeholder="09:00  or  every 30m" required />
      <input name="prompt" placeholder="what to do" required />
      <button class="btn">Add task</button>
    </form>`;
}

async function readBody(req: Request): Promise<Record<string, any>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
}

const html = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const noContent = () => new Response(null, { status: 204 });

// CSRF guard: the Host header stays "127.0.0.1" even when a malicious page in the
// user's browser POSTs here, so Host alone isn't enough. Require that any
// state-changing request is same-origin — a cross-origin browser request always
// carries a mismatching Origin (or Referer). Requests with neither header are
// non-browser clients (curl, tests), which aren't a CSRF vector.
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
function sameOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (o) return ORIGINS.has(o);
  const r = req.headers.get("referer");
  if (r) {
    try {
      return ORIGINS.has(new URL(r).origin);
    } catch {
      return false;
    }
  }
  return true; // no Origin/Referer → not a browser CSRF vector
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // keep SSE connections open
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // DNS-rebinding guard: only accept loopback Host headers.
    const host = (req.headers.get("host") || "").split(":")[0];
    if (host && host !== "127.0.0.1" && host !== "localhost") return new Response("forbidden", { status: 403 });

    // CSRF guard: state-changing requests must be same-origin.
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req))
      return new Response("forbidden", { status: 403 });

    // static. Loading the page is what mints a session: httpOnly so no script can
    // read the id, SameSite=Strict so another origin can't drive this one's chat.
    if (p === "/") {
      const s = sessionFor(req);
      return new Response(Bun.file(join(PUBLIC, "index.html")), {
        headers: { "set-cookie": `${SID_COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}` },
      });
    }
    // Vite build output: /assets/<name>-<hash>.js|css. The regex is the traversal
    // guard — no slashes, no dots-dots, so join() can't escape PUBLIC.
    if (/^\/assets\/[\w.-]+\.(js|css|map|svg|png|jpe?g|gif|webp|woff2?)$/.test(p))
      return new Response(Bun.file(join(PUBLIC, p)));

    // serve a local file — restricted to allowed roots + same-site requests only
    if (p === "/local") {
      const sfs = req.headers.get("sec-fetch-site");
      if (sfs && sfs !== "same-origin" && sfs !== "none") return new Response("forbidden", { status: 403 });
      const fp = url.searchParams.get("path") || "";
      if (!isUnderRoots(fp)) return new Response("forbidden", { status: 403 });
      const file = Bun.file(fp);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      // A local file is user DATA, never app code. If someone navigates straight
      // to one (an .html or .svg can carry script), these stop it executing in
      // this origin — which can POST to /chat and /confirm. Images and video are
      // loaded as subresources (<img>/<video>), which these headers don't affect.
      const guard = {
        "content-security-policy": "sandbox; default-src 'none'",
        "x-content-type-options": "nosniff",
      };
      const range = req.headers.get("range");
      if (range) {
        const size = file.size;
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            ...guard,
            "content-range": `bytes ${start}-${end}/${size}`,
            "accept-ranges": "bytes",
            "content-length": String(end - start + 1),
            "content-type": file.type || "application/octet-stream",
          },
        });
      }
      return new Response(file, { headers: { ...guard, "accept-ranges": "bytes" } });
    }

    // SSE stream
    if (p === "/events") {
      // Attaches to the caller's own session, so a turn in another window never
      // reaches this stream.
      const s = sessionFor(req);
      let ref: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ref = c;
          s.clients.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() {
          s.clients.delete(ref);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    if (req.method === "POST") {
      const b = await readBody(req);
      switch (p) {
        case "/chat": {
          const message = (b.message || "").trim();
          if (!message) return noContent();
          if (!built.hasKey()) return Response.json({ error: "no-key" }, { status: 400 });
          if (busy) return Response.json({ error: "busy" }, { status: 409 });
          void runTurn(message, sessionFor(req));
          return noContent();
        }
        case "/confirm": {
          const ok = b.ok === true || b.ok === "true";
          const key = pendingAllowKey.get(b.token);
          if (ok && (b.always === true || b.always === "true") && key)
            setAllowedCommands([...new Set([...allowedCommands(), key])]);
          pending.get(b.token)?.(ok);
          pending.delete(b.token);
          pendingAllowKey.delete(b.token);
          return noContent();
        }
        case "/ask":
          pending.get(b.token)?.(b.answer);
          pending.delete(b.token);
          return noContent();
        case "/flows": {
          // Nodes/edges come straight from the canvas; stored verbatim.
          const f = b as Flow;
          if (!f.id || !Array.isArray(f.nodes)) return Response.json({ error: "bad-flow" }, { status: 400 });
          saveFlows([...loadFlows().filter((x) => x.id !== f.id), f]);
          return Response.json({ ok: true });
        }
        case "/flows/delete":
          saveFlows(loadFlows().filter((f) => f.id !== b.id));
          return Response.json({ ok: true });
        case "/flows/run": {
          if (!built.hasKey()) return Response.json({ error: "no-key" }, { status: 400 });
          if (busy) return Response.json({ error: "busy" }, { status: 409 });
          void runFlowById(String(b.id));
          return noContent();
        }
        case "/flows/control": {
          // pause / resume / stop the in-flight run
          if (!currentRun) return Response.json({ state: "idle" });
          if (b.action === "pause") currentRun.pause();
          else if (b.action === "resume") currentRun.resume();
          else if (b.action === "stop") currentRun.stop();
          const state = currentRun?.state ?? "idle";
          broadcastAll("flow", { type: "state", state }); // shared canvas, like the rest of the flow events
          return Response.json({ state });
        }
        // Clears only the caller's conversation — another window's chat is not
        // this window's to throw away.
        case "/new": {
          const s = sessionFor(req);
          s.agent.reset();
          s.todos = [];
          if (active === s) resetTodos();
          broadcast("context", s.agent.stats(), s);
          return noContent();
        }
        // Compact on demand, rather than waiting for the budget to force it —
        // useful right before handing the agent a big task. Refused mid-turn:
        // rewriting history while a request is in flight would corrupt it.
        case "/compact": {
          if (busy) return Response.json({ ok: false, reason: "busy" }, { status: 409 });
          const s = sessionFor(req);
          let landed = false;
          await s.agent.compact((e) => {
            if (e.type === "info") broadcast("info", { message: e.message }, s);
            else if (e.type === "context") broadcast("context", e.stats, s);
            else if (e.type === "compaction") {
              landed = true;
              broadcast("compaction", { items: e.items, pruned: e.pruned, manual: true, summary: e.summary }, s);
            }
          });
          // A conversation short enough to have nothing to fold still deserves an
          // answer — a click that produces no row at all reads as a broken button.
          if (!landed) broadcast("info", { message: "nothing to compact yet" }, s);
          broadcast("context", s.agent.stats(), s);
          return noContent();
        }
        case "/model":
          if (b.id) {
            built.setModel(b.id);
            // Machine-level: one model, every session. Announce it to all of them.
            broadcastAll("model", { model: b.id });
          }
          return html(settingsFragment());
        case "/keys": {
          for (const k of KEY_NAMES) if (b[k]) writeSecret(k as KeyName, b[k].trim());
          built.refreshModels();
          return html(settingsFragment());
        }
        // Capability groups and individual tools both end at the same place:
        // rewrite config, then re-filter the live tool set so the next message
        // sees the change without a restart.
        case "/capabilities": {
          const on = b.on === true || b.on === "true";
          setCapabilities({ ...capabilities(), [b.cap]: on });
          built.applyCaps();
          return html(settingsFragment());
        }
        case "/mcp/tool": {
          const on = b.on === true || b.on === "true";
          const off = disabledTools();
          on ? off.delete(b.tool) : off.add(b.tool);
          setDisabledTools([...off]);
          built.applyCaps();
          return html(settingsFragment());
        }
        case "/permissions":
          if (b.mode === "ask" || b.mode === "normal" || b.mode === "auto") setPermissionMode(b.mode);
          return html(settingsFragment());
        // The "custom:" provider's endpoint — OpenRouter, Groq, Ollama, LM Studio.
        case "/base-url":
          if (b.url) {
            setCustomBaseURL(b.url.trim());
            built.config.customBaseURL = b.url.trim();
            built.refreshModels();
          }
          return html(settingsFragment());
        case "/memory":
          saveMemory({ id: b.id, type: b.type || "note", description: b.description, body: b.body });
          return html(memoryFragment());
        case "/memory/delete":
          deleteMemory(b.id);
          return html(memoryFragment());
        case "/schedule": {
          if (b.id && parseAt(b.at)) {
            const tasks = loadSchedule().filter((t) => t.id !== b.id);
            tasks.push({ id: b.id, at: b.at, prompt: b.prompt } as Task);
            saveSchedule(tasks);
          }
          return html(scheduleFragment());
        }
        case "/schedule/delete":
          saveSchedule(loadSchedule().filter((t) => t.id !== b.id));
          return html(scheduleFragment());
        case "/failures/clear":
          clearFailures();
          return html(failuresFragment());
        case "/failures/delete":
          removeDomain(b.domain);
          return html(failuresFragment());
        case "/roots": {
          const r = String(b.root || "").trim();
          if (r && existsSync(r)) setLocalRoots([...new Set([...allowedRoots(), r])]);
          return html(rootsFragment());
        }
        case "/roots/delete":
          setLocalRoots(allowedRoots().filter((r) => r !== b.root));
          return html(rootsFragment());
        case "/allowed/delete":
          setAllowedCommands(allowedCommands().filter((k) => k !== b.key));
          return html(allowedFragment());
        case "/mcp": {
          // Name goes into a tool name, so keep it to what a tool name allows.
          const name = String(b.name || "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
          const command = String(b.command || "").trim();
          if (name && command) {
            const args = String(b.args || "").trim().split(/\s+/).filter(Boolean);
            setMcpServers({
              ...mcpServers(),
              // Anything but an explicit read-only tick asks before every call.
              [name]: { command, ...(args.length ? { args } : {}), trust: b.trust === "read" ? "read" : "ask" },
            });
          }
          return html(mcpFragment());
        }
        case "/mcp/delete": {
          const { [String(b.name)]: _gone, ...rest } = mcpServers();
          setMcpServers(rest);
          return html(mcpFragment());
        }
      }
    }

    if (req.method === "GET") {
      if (p === "/flows") return Response.json(loadFlows());
      if (p === "/settings") return html(settingsFragment());
      if (p === "/memory") return html(memoryFragment());
      if (p === "/schedule") return html(scheduleFragment());
      if (p === "/failures") return html(failuresFragment());
      if (p === "/roots") return html(rootsFragment());
      if (p === "/allowed") return html(allowedFragment());
      if (p === "/mcp") return html(mcpFragment());
      if (p === "/state")
        // maptilerKey is a client-side map-tile key (public by design, kept in .env
        // not source) — the browser needs it to load MapTiler tiles.
        return Response.json({
          model: built.config.model,
          // Only models you can actually reach: no key for a provider, no entry
          // in the picker. Picking one that 401s is a worse experience than not
          // seeing it. The current model always stays listed so the dropdown
          // never disagrees with what's running.
          models: KNOWN_MODELS.filter(
            (m) => m === built.config.model || !!process.env[PROVIDER_KEY[splitSpec(m)[0]]],
          ),
          hasKey: built.hasKey(),
          tools: built.toolNames.length,
          // for the Flows page tool-node picker: the tools a flow node may call
          // directly (the agent-control ones aren't usable without a model turn)
          toolNames: built.toolNames.filter((t) => !["spawn_agent", "loop_task", "run_flow", "render_ui", "ask_user"].includes(t)),
          toolArgs: built.toolArgs, // arg fields per tool, read off each tool's schema
          // Both seed the page on load, so they must describe the CALLER's
          // conversation — reading the live todo module here would hand a
          // reloading tab whatever another session is mid-way through.
          context: sessionFor(req).agent.stats(),
          todos: sessionFor(req).todos,
          maptilerKey: process.env.MAPTILER_KEY ?? "",
        });
    }

    return new Response("not found", { status: 404 });
  },
});

const link = `http://127.0.0.1:${PORT}`;
console.log(`adhd web UI → ${link}${built.hasKey() ? "" : "   (add your DeepSeek key in Settings to start)"}`);
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
try {
  Bun.spawn([opener, link]);
} catch {
  /* headless / no browser */
}
