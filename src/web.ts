#!/usr/bin/env bun
import { join } from "node:path";
import { existsSync } from "node:fs";
import { marked } from "marked";
import { buildAgent } from "./setup.js";
import { setBashConfirm, setAskUser, orAfter, currentTurnGrants, type ConfirmResolution } from "./tools.js";
import { setSubagentSink, setRunsSink, activeAgentRuns } from "./subagent.js";
import { setRenderSink, setTurnKey, carriesAnswer, type Spec } from "./render.js";
import { sanitize } from "./sanitize.js";
import { listFailures, clearFailures, removeDomain } from "./failcache.js";
import { KNOWN_MODELS, KEY_NAMES, keyStatus, writeSecret, loadSecretsIntoEnv, isUnderRoots, allowedRoots, setLocalRoots, allowedCommands, setAllowedCommands, deniedCommands, setDeniedCommands, mcpServers, setMcpServers, setCustomBaseURL, loadConfig, capabilities, setCapabilities, permissionMode, setPermissionMode, disabledTools, setDisabledTools, splitSpec, PROVIDER_KEY, CAPABILITIES, type Capabilities, type KeyName } from "./config.js";
import { setJobSinks, runningJobs, type FinishedJob } from "./jobs.js";
import { loadMemories, saveMemory, deleteMemory } from "./memory.js";
import { loadSchedule, saveSchedule, isDue, parseAt, type Task } from "./scheduler.js";
import { loadFlows, saveFlows, seedExamples, toolArgSpecs, RunControl, type Flow } from "./flows.js";
import { migrateMcpDefaults, mcpCatalog, closeMcpClients } from "./mcp.js";
import { todoItems, setTodoSink, resetTodos, loadTodos, type TodoItem } from "./todo.js";
import { logUser, logAssistant, logToolCall, logToolResult, logUsage, logInfo, logError, recentLogs, toolTotals, clearLogs, runInAgentContext, type LogRow } from "./toollog.js";
import { runReflection, approveProposal, rejectProposal, loadProposals, seedReflectTask } from "./reflect.js";
import type { Agent } from "./agent.js";

// The AI SDK leaves some internal promises unawaited on error; swallow the stray
// rejections so they don't crash the server (real errors reach the client).
process.on("unhandledRejection", () => {});

loadSecretsIntoEnv(); // hydrate API keys from ~/.adhd/secrets.json before building
migrateMcpDefaults(); // drop the old seeded Chrome server — must precede buildAgent's loadMcpTools
const built = await buildAgent();
setTodoSink((items) => broadcast("todos", { items })); // agent's plan → the strip under the composer
seedExamples(); // first run: put a few worked examples on the Flows page
seedReflectTask(); // first run: schedule the daily reflect pass

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
  transcript: TranscriptEntry[];
  seen: number;
};
type TranscriptEntry =
  | { type: "user"; text: string }
  | { type: "assistant"; html: string }
  | { type: "ui"; spec: Spec; carries: boolean }
  | { type: "sub"; line: string };
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
  return { id, agent: built.newAgent(), clients: new Set(), todos: [], transcript: [], seen: Date.now() };
}
function rememberTranscript(s: Session, entry: TranscriptEntry) {
  s.transcript.push(entry);
  if (s.transcript.length > 200) s.transcript.splice(0, s.transcript.length - 200);
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
// token → the live turn's grant Set, captured BY REFERENCE at prompt-creation
// time. /confirm arrives as a fresh HTTP request with no ambient AsyncLocalStorage
// context, so this is what lets "allow for this task" reach back into the turn
// that's still awaiting this very prompt.
const pendingTurnGrant = new Map<string, Set<string>>();

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
  pendingTurnGrant.delete(token);
  broadcast("info", { message: note });
}

setBashConfirm(({ command, explain, allowKey, dangerReason }) => {
  const token = crypto.randomUUID();
  // Captured now, while we're still nested inside the live turn's
  // withTurnGrants scope (approve() → confirmBash() → here, all synchronous
  // down to this callback) — see pendingTurnGrant's comment above for why.
  const grantSet = currentTurnGrants();
  const answered = new Promise<boolean>((resolve) => {
    pending.set(token, (v) => resolve(!!v));
    if (allowKey) {
      pendingAllowKey.set(token, allowKey);
      if (grantSet) pendingTurnGrant.set(token, grantSet);
    }
    broadcast("confirm", { token, command, explain, allowKey, dangerReason });
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
// Persisted (not just broadcast live) so a subagent's progress survives a
// reconnect mid-run or a scheduled/background trigger nobody was watching —
// without this, only the activity FAB (which re-reads fresh server state on
// load) shows anything; the transcript replay had nothing to show.
setSubagentSink((line) => {
  if (active) rememberTranscript(active, { type: "sub", line });
  broadcast("sub", { line });
});
setRunsSink(() => broadcastActivity());
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
  const carries = carriesAnswer(spec);
  if (active) rememberTranscript(active, { type: "ui", spec: structuredClone(spec), carries });
  broadcast("render_ui", { spec, carries });
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
// What the current `busy` episode actually is, and how it started — "something
// is running" alone doesn't say whether it's the chat turn someone's watching,
// a flow, or a scheduled task nobody's looking at right now. Read by the
// activity indicator (see activitySnapshot below).
let busyKind: "chat" | "flow" | null = null;
let scheduledLabel: string | null = null; // the schedule's task id, while it's driving the current busy episode
function activitySnapshot() {
  return {
    busy,
    kind: busy ? busyKind : null,
    scheduled: busy ? scheduledLabel : null,
    jobs: runningJobs(),
    subagents: activeAgentRuns(),
  };
}
function broadcastActivity() {
  broadcastAll("activity", activitySnapshot());
}
async function runTurn(message: string, s: Session) {
  busy = true;
  busyKind = "chat";
  active = s; // routes every tool sink at this session for the whole turn
  loadTodos(s.todos); // its checklist, not whoever ran last
  broadcastAll("busy", { busy: true });
  broadcastActivity();
  let assistant = "";
  rememberTranscript(s, { type: "user", text: message });
  const turn = logUser(s.id, message);
  setTurnKey(`${s.id}:${turn}`);
  try {
    // Root of this turn's lineage — spawn_agent/loop_task read it (via
    // toollog's currentAgentContext) to stamp their own subagent's tool calls
    // with agentId/parentAgentId/rootAgentId back to this turn.
    await runInAgentContext({ session: s.id, turn, agentId: null, parentAgentId: null, rootAgentId: null }, () =>
      s.agent.send(message, (e) => {
      switch (e.type) {
        case "text":
          assistant += e.delta;
          broadcast("text", { delta: e.delta });
          break;
        case "tool-call":
          broadcast("tool-call", { id: e.id, name: e.name, summary: summarize(e.args) });
          logToolCall(s.id, turn, e.id, e.name, e.args);
          break;
        case "tool-result":
          broadcast("tool-result", { id: e.id });
          logToolResult(e.id, e.result);
          break;
        case "usage":
          broadcast("usage", { total: e.total });
          logUsage(s.id, turn, e.total);
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
          logInfo(s.id, turn, e.message);
          break;
        case "error":
          broadcast("error", { message: e.message });
          logError(s.id, turn, e.message);
          break;
      }
      }),
    );
    const html = sanitize(await marked.parse(assistant));
    if (html.trim()) rememberTranscript(s, { type: "assistant", html });
    logAssistant(s.id, turn, assistant);
    broadcast("done", { html });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    broadcast("error", { message });
    logError(s.id, turn, message);
    broadcast("done", { html: "" });
  } finally {
    s.todos = todoItems(); // hand the checklist back before another session's turn
    active = null;
    busy = false;
    busyKind = null;
    scheduledLabel = null;
    broadcastAll("busy", { busy: false });
    broadcastActivity();
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
    broadcastActivity();
    scheduleDrain();
  },
  (id, label) => {
    broadcast("info", { message: `[${id}] ${label} — still running, continuing in the background` }, ownerSession());
    broadcastActivity();
  },
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
  busyKind = "flow";
  // The Flows page is one shared canvas, so its progress goes to everyone — but
  // a flow still runs tools, and those sinks need a transcript to land in.
  active = ownerSession();
  currentRun = new RunControl();
  broadcastAll("busy", { busy: true });
  broadcastActivity();
  broadcastAll("flow", { type: "run-start", name: flow.name });
  try {
    await built.runFlow(flow, (e) => broadcastAll("flow", e), currentRun);
  } catch (err) {
    broadcastAll("flow", { type: "node-error", id: "", ms: 0, message: (err as Error)?.message ?? String(err) });
  } finally {
    currentRun = null;
    active = null;
    busy = false;
    busyKind = null;
    scheduledLabel = null;
    broadcastAll("busy", { busy: false });
    broadcastActivity();
    scheduleDrain();
  }
}

// --- scheduler tick (moved from the Ink UI) ---------------------------------
const lastRun: Record<string, number> = {};
const schedulerTimer = setInterval(() => {
  if (busy || !built.hasKey()) return;
  const now = new Date();
  for (const t of loadSchedule()) {
    if (!isDue(t, now, lastRun[t.id])) continue;
    lastRun[t.id] = now.getTime();
    // Nobody asked for this, so it lands in the transcript most recently in use
    // rather than in every open window at once.
    const owner = ownerSession();
    // The seeded daily "reflect" task is a plain function call, not a chat turn —
    // it never touches the agent or `busy`, so scanning the log costs no tokens.
    if (t.prompt === "reflect") {
      if (capabilities(loadConfig()).reflect) {
        const added = runReflection(4);
        if (added.length)
          broadcast(
            "notify",
            { title: "Reflect", body: `${added.length} new suggestion(s) — review in Settings → Reflect` },
            owner,
          );
      }
      break;
    }
    broadcast("info", { message: `[scheduled] ${t.id}` }, owner);
    broadcast("notify", { title: `Scheduled: ${t.id}`, body: t.prompt }, owner);
    // Set before the dispatch below: both runTurn and runFlowById set busy/busyKind
    // synchronously before their first await, so activitySnapshot() sees this
    // the instant `busy` flips true.
    scheduledLabel = t.id;
    // A prompt of "flow:<id>" runs a saved flow instead of a chat turn — reuses
    // the existing schedule format, so no migration and no extra UI.
    if (t.prompt.startsWith("flow:")) void runFlowById(t.prompt.slice(5).trim());
    else void runTurn(t.prompt, owner);
    break; // one at a time
  }
}, 30_000);

// --- HTML fragments (HTMX targets) ------------------------------------------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// hx-vals must be a JSON blob (htmx JSON.parses the attribute), so a value is
// never safe to hand-splice into `{"key":"${esc(value)}"}` — esc() only
// HTML-escapes, it doesn't JSON-escape. A raw backslash (e.g. a Windows path
// like C:\Users\...) survives esc() untouched and then breaks htmx's
// JSON.parse (`\U` isn't a valid JSON escape). JSON.stringify does that
// escaping correctly; esc() then HTML-escapes the result's quotes so the
// blob survives being embedded in a single-quoted HTML attribute (the
// browser decodes &quot; back to " before htmx ever sees it).
const hxVals = (v: Record<string, unknown>) => esc(JSON.stringify(v));

// Every section is rendered INLINE, not as a nested `hx-trigger="load"` div that
// fetches itself. Those self-loading children raced the parent: re-swapping
// #settings (saving a key returns a fresh fragment) detached them while their
// own request was still in flight, and htmx then threw on the null target —
// which aborted processing, leaving the sections BELOW it permanently empty.
// These are all cheap local file reads, so inlining costs nothing and removes
// five round-trips along with the race. The /memory, /schedule, /roots,
// /allowed and /failures endpoints still exist — the forms POST to them and
// swap the result into #mem, #sched, etc.
function settingsFragment(error?: string): string {
  const ks = keyStatus();
  const errorBanner = error ? `<p class="muted" style="color:var(--danger,#c33)">${esc(error)}</p>` : "";
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
  // Keep related controls on focused tab panels instead of one long accordion.
  // app.js restores the active tab after HTMX replaces this fragment.
  const tab = (id: string, title: string, note: string, body: string): string =>
    `<section id="settings-panel-${id}" class="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-${id}" data-settings-panel="${id}" hidden>
      <div class="settings-tab-heading"><h1>${title}</h1><p class="muted">${note}</p></div>
      ${body}
    </section>`;

  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  return `<div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" id="settings-tab-general" data-settings-tab="general" aria-controls="settings-panel-general">General</button>
      <button type="button" role="tab" id="settings-tab-models" data-settings-tab="models" aria-controls="settings-panel-models">Models</button>
      <button type="button" role="tab" id="settings-tab-tools" data-settings-tab="tools" aria-controls="settings-panel-tools">Tools</button>
      <button type="button" role="tab" id="settings-tab-mcp" data-settings-tab="mcp" aria-controls="settings-panel-mcp">MCP</button>
      <button type="button" role="tab" id="settings-tab-access" data-settings-tab="access" aria-controls="settings-panel-access">Access</button>
      <button type="button" role="tab" id="settings-tab-memory" data-settings-tab="memory" aria-controls="settings-panel-memory">Memory</button>
      <button type="button" role="tab" id="settings-tab-reflect" data-settings-tab="reflect" aria-controls="settings-panel-reflect">Reflect</button>
    </div>
    <div class="settings-panels">` +
    tab(
      "general",
      "General",
      "Appearance, notifications, and browser state.",
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
    ) +
    tab(
      "models",
      "Keys",
      "Connect model providers and choose a custom endpoint.",
      `${errorBanner}<p class="muted">Stored in <span class="mono">~/.adhd/secrets.json</span> (chmod 600). Keys never leave this machine.
       You only need a key for the provider you actually use — a model is named <span class="mono">provider:id</span>
       (<span class="mono">anthropic:claude-sonnet-5</span>), and a bare id means DeepSeek. A <span class="mono">custom:</span>
       model (OpenRouter, Ollama, LM Studio…) needs the base URL below; local servers like Ollama usually need no key at all.</p>
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
    ) +
    tab(
      "tools",
      "Capabilities",
      `${built.toolNames.length} of ${built.allToolNames.length} tools are active.`,
      `<p class="muted">Everything switched on here is sent to the model on every message, whether you use it or not.
       Switch off what this chat doesn't need and the context goes further.</p>
      <div class="settings-section">${capsFragment()}</div>`,
    ) +
    tab(
      "mcp",
      "MCP",
      `${n(Object.keys(mcpServers()).length, "server")} connected.`,
      `<div class="settings-section"><div id="mcp">${mcpFragment()}</div></div>`,
    ) +
    tab(
      "access",
      "Access",
      `Permission mode: ${MODE_LABEL[permissionMode()][0].toLowerCase()}.`,
      `<p class="muted">When adhd should stop and ask before doing something to your machine.</p>
      <div class="settings-section">${permissionsFragment()}</div>
      <h2>Local folders <span class="muted">(${n(allowedRoots().length, "folder")})</span></h2>
      <div class="settings-section"><div id="roots">${rootsFragment()}</div></div>
      <h2>Always-allowed commands <span class="muted">(${n(allowedCommands().length, "command")})</span></h2>
      <div class="settings-section"><div id="allowed">${allowedFragment()}</div></div>
      <h2>Never-allowed commands <span class="muted">(${n(deniedCommands().length, "command")})</span></h2>
      <div class="settings-section"><div id="denied">${deniedFragment()}</div></div>`,
    ) +
    tab(
      "memory",
      "Memory",
      `${n(built.memoryIds.length, "memory", "memories")} and ${n(loadSchedule().length, "scheduled task")}.`,
      `<h2>Memory</h2>
      <div class="settings-section"><div id="mem">${memoryFragment()}</div></div>
      <h2>Schedule</h2>
      <div class="settings-section"><div id="sched">${scheduleFragment()}</div></div>`,
    ) +
    tab(
      "reflect",
      "Reflect",
      `${n(loadProposals().length, "suggestion")} waiting for review.`,
      `<p class="muted">Once a day, adhd scans its own activity log for things that keep repeating — the same
       few tool calls in a row, or the same kind of request — and drafts a memory or a flow for it here.
       Nothing is saved until you approve it.</p>
      <div class="settings-section"><div id="reflect">${reflectFragment()}</div></div>`,
    ) + `</div>`;
}

function rootsFragment(): string {
  const rows = allowedRoots()
    .map(
      (r) => `<div class="row">
        <span class="mono">${esc(r)}</span>
        <button class="btn ghost" hx-post="/roots/delete" hx-vals='${hxVals({ root: r })}' hx-target="#roots" hx-swap="innerHTML">Remove</button>
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
        <button class="btn ghost" hx-post="/allowed/delete" hx-vals='${hxVals({ key: k })}' hx-target="#allowed" hx-swap="innerHTML">Revoke</button>
      </div>`;
    })
    .join("");
  return rows || '<p class="muted">None. Approving a command with “Always allow” adds it here.</p>';
}

function deniedFragment(): string {
  const rows = deniedCommands()
    .map((k) => {
      const [runner, prog] = k.split(":");
      return `<div class="row">
        <span class="mono">${esc(prog ?? k)} <span class="muted">(${esc(runner ?? "")})</span></span>
        <button class="btn ghost" hx-post="/denied/delete" hx-vals='${hxVals({ key: k })}' hx-target="#denied" hx-swap="innerHTML">Revoke</button>
      </div>`;
    })
    .join("");
  return rows || '<p class="muted">None. Declining a command with “Never” adds it here.</p>';
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
          hx-post="${post}" hx-trigger="change" hx-vals='${hxVals({ ...vals, on: !on })}'
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
  reflect: ["Reflect", "daily scan for repeats worth turning into memory or a flow"],
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
        <button class="btn ghost" hx-post="/mcp/delete" hx-vals='${hxVals({ name })}' hx-target="#mcp" hx-swap="innerHTML" hx-confirm="Remove ${esc(name)}?">Remove</button>
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
        <button class="btn ghost" hx-post="/failures/delete" hx-vals='${hxVals({ domain: f.domain })}' hx-target="#fails" hx-swap="innerHTML">Unblock</button>
      </div>`,
    )
    .join("");
  return `${rows || '<p class="muted">No failed fetches. Domains that fail twice get dropped from search.</p>'}
    ${listFailures().length ? `<button class="btn ghost" hx-post="/failures/clear" hx-target="#fails" hx-swap="innerHTML">Clear all</button>` : ""}`;
}

function memoryFragment(notice?: string): string {
  const rows = loadMemories()
    .map(
      (m) => `<div class="row">
        <div><span class="mono">${esc(m.id)}</span> <span class="muted">${esc(m.description)}</span></div>
        <button class="btn ghost" hx-post="/memory/delete" hx-vals='${hxVals({ id: m.id })}' hx-target="#mem" hx-swap="innerHTML" hx-confirm="Delete ${esc(m.id)}?">Delete</button>
      </div>`,
    )
    .join("");
  return `${notice ? `<p class="muted">${esc(notice)}</p>` : ""}${rows || '<p class="muted">No memories.</p>'}
    <form hx-post="/memory" hx-target="#mem" hx-swap="innerHTML" class="stack">
      <input name="id" placeholder="id, e.g. preferences/style" required />
      <input name="description" placeholder="one-line summary" required />
      <textarea name="body" placeholder="the fact / detail" required></textarea>
      <label class="muted"><input type="checkbox" name="overrideTombstone" value="true" /> Save anyway if this matches a deleted memory</label>
      <button class="btn">Add memory</button>
    </form>`;
}

function scheduleFragment(): string {
  const rows = loadSchedule()
    .map(
      (t) => `<div class="row">
        <div><span class="mono">${esc(t.id)}</span> <span class="badge">${esc(t.at)}</span> <span class="muted">${esc(t.prompt)}</span></div>
        <button class="btn ghost" hx-post="/schedule/delete" hx-vals='${hxVals({ id: t.id })}' hx-target="#sched" hx-swap="innerHTML">Delete</button>
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

// Nothing here was written by you — every row is a draft reflection proposed
// after a pattern repeated at least 4 times. Nothing lands in memory/flows
// until you hit Approve.
function reflectFragment(): string {
  const rows = loadProposals()
    .map(
      (p) => `<div class="row">
        <div><span class="badge">${esc(p.kind)}</span> <span class="muted">${esc(p.summary)}</span></div>
        <span class="inline">
          <button class="btn ghost" hx-post="/reflect/reject" hx-vals='${hxVals({ id: p.id })}' hx-target="#reflect" hx-swap="innerHTML">Dismiss</button>
          <button class="btn" hx-post="/reflect/approve" hx-vals='${hxVals({ id: p.id })}' hx-target="#reflect" hx-swap="innerHTML">Approve</button>
        </span>
      </div>`,
    )
    .join("");
  return `${rows || '<p class="muted">No suggestions yet — checks once a day, or run it now.</p>'}
    <button class="btn ghost" hx-post="/reflect/run" hx-target="#reflect" hx-swap="innerHTML">Reflect now</button>`;
}

// A real page at its own URL (GET /log), not a fragment bolted into the SPA —
// so it can be opened, bookmarked, and read on its own, separate from the chat.
// Shows the whole activity timeline: prompts, tool calls/results, the assistant's
// reply, and anything that errored — grouped by turn, oldest first within a turn.
function logPage(): string {
  const toolStats = toolTotals();
  const totals = toolStats
    .map((t) => `<span class="tool-pill"><span class="status-dot"></span>${esc(t.tool)} <b>${t.calls}×</b><span>${t.tokens.toLocaleString()} tok</span></span>`)
    .join("");

  const rowHtml = (r: LogRow): string => {
    const time = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const head = (icon: string, label: string, extra = "") => `<div class="ev-head"><span class="ev-icon" aria-hidden="true">${icon}</span><b>${label}</b>${extra}<time>${time}</time></div>`;
    if (r.kind === "user") return `<div class="ev ev-user">${head("↑", "You")}<p>${esc(r.content ?? "")}</p></div>`;
    if (r.kind === "assistant") return `<div class="ev ev-assistant">${head("✦", "Assistant")}<p>${esc(r.content ?? "")}</p></div>`;
    if (r.kind === "usage") return `<div class="ev ev-usage">${head("◫", "Step usage", `<span class="token-badge">${(r.tokens ?? 0).toLocaleString()} tokens</span>`)}</div>`;
    if (r.kind === "error") return `<div class="ev ev-error">${head("!", "Error")}<p>${esc(r.content ?? "")}</p></div>`;
    if (r.kind === "info") return `<div class="ev ev-info">${head("i", "Info")}<p>${esc(r.content ?? "")}</p></div>`;
    // agent_id is only set on a row logged from inside spawn_agent/loop_task —
    // the main turn's own tool calls have it null — so its presence alone is
    // "this ran inside a subagent", worth a visual break from the main thread.
    const lineageBadge = r.agent_id
      ? `<span class="name-badge" title="parent: ${esc(r.parent_agent_id ?? "main turn")}">↳ subagent ${esc(r.agent_id)}</span>`
      : "";
    return `<div class="ev ev-tool${r.agent_id ? " ev-sub" : ""}">
      ${head("⌘", "Tool call", `<span class="name-badge">${esc(r.name ?? "")}</span>${lineageBadge}${r.tokens != null ? `<span class="token-badge">${r.tokens.toLocaleString()} tokens</span>` : ""}`)}
      <div class="payloads">
        <details><summary><span>Arguments</span><span class="chevron">⌄</span></summary><pre>${esc(r.content ?? "")}</pre></details>
        <details><summary><span>Result</span><span class="chevron">⌄</span></summary><pre>${esc(r.result ?? "(pending)")}</pre></details>
      </div>
    </div>`;
  };

  const all = recentLogs();
  const tokenTotal = all.filter((r) => r.kind === "usage").reduce((sum, r) => sum + (r.tokens ?? 0), 0);
  const toolCallCount = all.filter((r) => r.kind === "tool").length;
  const errorCount = all.filter((r) => r.kind === "error").length;
  const sessionCount = new Set(all.map((r) => r.session)).size;
  const rowsByTurn = Object.values(
    all.reduce<Record<string, LogRow[]>>((acc, r) => {
      (acc[`${r.session}:${r.turn}`] ??= []).push(r);
      return acc;
    }, {}),
  ).sort((a, b) => b[0].ts - a[0].ts); // newest turn first; rows within a turn are already id-desc, so reverse them
  const turns = rowsByTurn
    .map((rows) => {
      const ordered = [...rows].reverse();
      const when = new Date(ordered[0].ts).toLocaleString();
      const session = esc(ordered[0].session);
      const prompt = ordered.find((r) => r.kind === "user")?.content ?? "Agent activity";
      const tools = ordered.filter((r) => r.kind === "tool").length;
      const tokens = ordered.filter((r) => r.kind === "usage").reduce((sum, r) => sum + (r.tokens ?? 0), 0);
      const subCount = new Set(ordered.filter((r) => r.agent_id).map((r) => r.agent_id)).size;
      // "sub" is a synthetic kind, not one toollog actually writes — it makes a
      // turn that delegated to spawn_agent/loop_task show up under the
      // Subagents filter alongside its real kinds (still shows under "All").
      const kinds: string[] = ordered.map((r) => r.kind);
      if (subCount) kinds.push("sub");
      return `<section class="turn" data-kinds="${kinds.join(" ")}">
        <header class="turn-head">
          <div class="turn-index">${String(ordered[0].turn).padStart(2, "0")}</div>
          <div class="turn-title"><h2>${esc(prompt)}</h2><p><time>${when}</time><span>${session.slice(0, 12)}</span></p></div>
          <div class="turn-meta">${tools ? `<span>${tools} tool${tools === 1 ? "" : "s"}</span>` : ""}${subCount ? `<span>${subCount} subagent${subCount === 1 ? "" : "s"}</span>` : ""}${tokens ? `<span>${tokens.toLocaleString()} tok</span>` : ""}</div>
        </header>
        <div class="timeline">${ordered.map(rowHtml).join("")}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>adhd — activity log</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script>(function(){var t=localStorage.getItem('theme')||'system';if(t==='light'||t==='dark')document.documentElement.dataset.theme=t})();</script>
<style>
  :root { color-scheme: dark; --bg: #111315; --panel: #181b1e; --panel-2: #202428; --line: #2b3035; --text: #f0f1f2; --muted: #8d959d; --blue: #70a7ff; --green: #51d5a4; --red: #ff737f; --amber: #f7bd68; --shadow: 0 18px 55px rgb(0 0 0 / .24); }
  :root[data-theme="light"] { color-scheme: light; --bg: #eef0f2; --panel: #f8f9fa; --panel-2: #e9ecef; --line: #d6dadd; --text: #202326; --muted: #697078; --blue: #2767da; --green: #16885d; --red: #d83246; --amber: #a86400; --shadow: 0 18px 55px rgb(35 40 45 / .09); }
  @media (prefers-color-scheme: light) { :root:not([data-theme]) { color-scheme: light; --bg: #eef0f2; --panel: #f8f9fa; --panel-2: #e9ecef; --line: #d6dadd; --text: #202326; --muted: #697078; --blue: #2767da; --green: #16885d; --red: #d83246; --amber: #a86400; --shadow: 0 18px 55px rgb(35 40 45 / .09); } }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: "Instrument Sans", sans-serif; }
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background: radial-gradient(circle at 12% -10%, rgb(112 167 255 / .13), transparent 30rem), linear-gradient(90deg, rgb(255 255 255 / .018) 1px, transparent 1px); background-size: auto, 44px 44px; mask-image: linear-gradient(to bottom, black, transparent 42rem); }
  a { color: inherit; }
  button, input { font: inherit; }
  .shell { position: relative; width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 5rem; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; padding: 1.25rem 0 2rem; }
  .brand { display: inline-flex; align-items: center; gap: .6rem; margin-bottom: 2.2rem; color: var(--muted); font: 500 11px/1 "DM Mono", monospace; letter-spacing: .14em; text-transform: uppercase; text-decoration: none; }
  .brand-mark { display: grid; place-items: center; width: 27px; height: 27px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--blue); font-size: 17px; }
  .eyebrow { margin: 0 0 .65rem; color: var(--blue); font: 500 10px/1 "DM Mono", monospace; letter-spacing: .16em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(2.25rem, 6vw, 4.65rem); font-weight: 600; line-height: .98; letter-spacing: -.055em; }
  .lede { max-width: 37rem; margin: 1rem 0 0; color: var(--muted); font-size: .92rem; line-height: 1.6; }
  .clear { display: inline-flex; align-items: center; gap: .5rem; padding: .62rem .9rem; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); cursor: pointer; font-size: .78rem; transition: .18s ease; }
  .clear:hover { border-color: color-mix(in srgb, var(--red) 55%, var(--line)); color: var(--red); transform: translateY(-1px); }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--panel) 88%, transparent); box-shadow: var(--shadow); overflow: hidden; }
  .metric { min-height: 100px; padding: 1.15rem 1.25rem; border-right: 1px solid var(--line); }
  .metric:last-child { border-right: 0; }
  .metric span { display: block; margin-bottom: .8rem; color: var(--muted); font: 500 9px/1 "DM Mono", monospace; letter-spacing: .12em; text-transform: uppercase; }
  .metric strong { font-size: 1.65rem; font-weight: 600; letter-spacing: -.04em; }
  .tools { display: flex; align-items: center; gap: .45rem; min-height: 48px; margin: 1rem 0 2.4rem; overflow-x: auto; scrollbar-width: none; }
  .tools::-webkit-scrollbar { display: none; }
  .tools-label { flex: 0 0 auto; margin-right: .25rem; color: var(--muted); font: 500 9px/1 "DM Mono", monospace; letter-spacing: .12em; text-transform: uppercase; }
  .tool-pill { display: inline-flex; align-items: center; gap: .45rem; flex: 0 0 auto; padding: .38rem .62rem; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); font: 400 10px/1 "DM Mono", monospace; }
  .tool-pill b { color: var(--text); font-weight: 500; }
  .status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 14%, transparent); }
  .controls { position: sticky; top: .75rem; z-index: 10; display: flex; align-items: center; gap: .45rem; width: fit-content; max-width: 100%; margin: 0 0 1rem auto; padding: .35rem; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--panel) 90%, transparent); backdrop-filter: blur(18px); box-shadow: 0 8px 24px rgb(0 0 0 / .12); overflow-x: auto; }
  .filter { padding: .42rem .68rem; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; font: 500 10px/1 "DM Mono", monospace; text-transform: uppercase; letter-spacing: .06em; }
  .filter:hover { color: var(--text); }
  .filter.active { background: var(--text); color: var(--bg); }
  .turns { display: grid; gap: 1rem; }
  .turn { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 1px 0 rgb(255 255 255 / .025); overflow: hidden; animation: arrive .35s both; }
  .turn:nth-child(2) { animation-delay: .04s; } .turn:nth-child(3) { animation-delay: .08s; }
  @keyframes arrive { from { opacity: 0; transform: translateY(8px); } }
  .turn-head { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 1rem; min-height: 76px; padding: .9rem 1.1rem; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel-2) 35%, var(--panel)); }
  .turn-index { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: 10px; color: var(--blue); font: 500 11px/1 "DM Mono", monospace; }
  .turn-title { min-width: 0; }
  .turn-title h2 { margin: 0 0 .35rem; overflow: hidden; color: var(--text); font-size: .92rem; font-weight: 600; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
  .turn-title p { display: flex; gap: .75rem; margin: 0; color: var(--muted); font: 400 9px/1.25 "DM Mono", monospace; }
  .turn-title p span { overflow: hidden; max-width: 12rem; text-overflow: ellipsis; white-space: nowrap; }
  .turn-meta { display: flex; gap: .4rem; }
  .turn-meta span, .token-badge, .name-badge { padding: .28rem .48rem; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); background: var(--panel); font: 500 9px/1 "DM Mono", monospace; white-space: nowrap; }
  .timeline { position: relative; padding: .45rem 1.1rem .65rem 4.35rem; }
  .timeline::before { content: ""; position: absolute; top: 1.5rem; bottom: 1.5rem; left: 2.4rem; width: 1px; background: var(--line); }
  .ev { position: relative; padding: .8rem 0; font-size: .84rem; }
  .ev-icon { position: absolute; left: -2.48rem; top: .66rem; display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--muted); font: 500 11px/1 "DM Mono", monospace; }
  .ev-user .ev-icon { color: var(--blue); } .ev-assistant .ev-icon { color: var(--green); } .ev-error .ev-icon { border-color: color-mix(in srgb, var(--red) 45%, var(--line)); color: var(--red); } .ev-info .ev-icon { color: var(--amber); }
  /* A subagent's own tool calls (agent_id set) are a step removed from the main
     turn's thread — a left border + slight indent reads as "nested" at a glance. */
  .ev-sub { padding-left: .65rem; border-left: 2px solid var(--line); }
  .ev-head { display: flex; align-items: center; gap: .45rem; min-height: 22px; }
  .ev-head b { font-size: .74rem; font-weight: 600; }
  .ev-head time { margin-left: auto; color: var(--muted); font: 400 9px/1 "DM Mono", monospace; }
  .ev p { margin: .38rem 0 0; color: color-mix(in srgb, var(--text) 88%, var(--muted)); line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .ev-error p { color: var(--red); }
  .ev-usage { min-height: 42px; }
  .payloads { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: .55rem; }
  details { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: color-mix(in srgb, var(--panel-2) 45%, transparent); overflow: hidden; }
  summary { display: flex; align-items: center; justify-content: space-between; padding: .55rem .65rem; color: var(--muted); cursor: pointer; list-style: none; font: 500 9px/1 "DM Mono", monospace; text-transform: uppercase; letter-spacing: .08em; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--text); }
  .chevron { transition: transform .15s; } details[open] .chevron { transform: rotate(180deg); }
  pre { max-height: 320px; margin: 0; padding: .75rem; border-top: 1px solid var(--line); overflow: auto; color: color-mix(in srgb, var(--text) 82%, var(--muted)); font: 400 10px/1.55 "DM Mono", monospace; white-space: pre-wrap; word-break: break-word; }
  .empty { padding: 4rem 2rem; border: 1px dashed var(--line); border-radius: 14px; color: var(--muted); text-align: center; }
  .empty strong { display: block; margin-bottom: .45rem; color: var(--text); font-size: 1rem; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  @media (max-width: 700px) { .shell { width: min(100% - 1.25rem, 1120px); padding-top: .75rem; } .top { padding-top: .5rem; } h1 { font-size: 2.7rem; } .summary { grid-template-columns: 1fr 1fr; } .metric { min-height: 82px; border-bottom: 1px solid var(--line); } .metric:nth-child(2) { border-right: 0; } .metric:nth-child(3), .metric:nth-child(4) { border-bottom: 0; } .payloads { grid-template-columns: 1fr; } .turn-head { grid-template-columns: 38px minmax(0, 1fr); gap: .7rem; } .turn-index { width: 36px; height: 36px; } .turn-meta { display: none; } .timeline { padding-left: 3.75rem; } .timeline::before { left: 2.15rem; } .ev-icon { left: -2.2rem; } }
  @media (max-width: 430px) { .top { gap: 1rem; } .clear span { display: none; } .brand { margin-bottom: 1.4rem; } .turn-title p span { display: none; } .controls { margin-left: 0; width: 100%; } }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } .turn { animation: none; } * { transition: none !important; } }
</style>
</head>
<body>
  <main class="shell">
    <a class="brand" href="/"><span class="brand-mark">←</span> adhd / operations</a>
    <div class="top">
      <div><p class="eyebrow">System journal</p><h1>Activity log</h1><p class="lede">A chronological record of prompts, agent decisions, tool calls, results, and their token cost.</p></div>
      <form method="post" action="/log/clear" onsubmit="return confirm('Clear the activity log? This cannot be undone.')"><button class="clear" type="submit"><span>Clear log</span> ×</button></form>
    </div>
    <section class="summary" aria-label="Log summary">
      <div class="metric"><span>Recorded turns</span><strong>${rowsByTurn.length.toLocaleString()}</strong></div>
      <div class="metric"><span>Tool calls</span><strong>${toolCallCount.toLocaleString()}</strong></div>
      <div class="metric"><span>Total usage</span><strong>${tokenTotal.toLocaleString()}<small> tok</small></strong></div>
      <div class="metric"><span>Sessions / errors</span><strong>${sessionCount}<small> / ${errorCount}</small></strong></div>
    </section>
    <div class="tools"><span class="tools-label">Tool footprint</span>${totals || '<span class="tool-pill">No calls yet</span>'}</div>
    ${turns ? `<nav class="controls" aria-label="Filter activity"><button class="filter active" data-filter="all">All</button><button class="filter" data-filter="tool">Tools</button><button class="filter" data-filter="sub">Subagents</button><button class="filter" data-filter="error">Errors</button></nav>` : ""}
    <div class="turns">${turns || '<div class="empty"><strong>The journal is quiet.</strong>Send a message in chat and activity will appear here.</div>'}</div>
  </main>
  <script>
    document.querySelectorAll('.filter').forEach(function (button) {
      button.addEventListener('click', function () {
        document.querySelectorAll('.filter').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        var filter = button.dataset.filter;
        document.querySelectorAll('.turn').forEach(function (turn) {
          turn.hidden = filter !== 'all' && !turn.dataset.kinds.split(' ').includes(filter);
        });
      });
    });
  </script>
</body>
</html>`;
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

let server: ReturnType<typeof Bun.serve>;
try {
server = Bun.serve({
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
        // index.html references THIS build's hashed asset filenames — a stale
        // cached copy points at JS/CSS that a later `vite build` deleted, so a
        // fix that's genuinely deployed can still look unchanged (or half-broken)
        // in a tab that never re-fetched it. No implicit browser heuristic gets
        // the chance to decide that's "fresh enough": always revalidate.
        headers: {
          "cache-control": "no-cache",
          "set-cookie": `${SID_COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
        },
      });
    }
    // Vite build output: /assets/<name>-<hash>.js|css. The regex is the traversal
    // guard — no slashes, no dots-dots, so join() can't escape PUBLIC. The hash
    // IS the cache key (a rebuild always mints a new filename), so unlike
    // index.html above, these are safe to cache forever.
    if (/^\/assets\/[\w.-]+\.(js|css|map|svg|png|jpe?g|gif|webp|woff2?)$/.test(p))
      return new Response(Bun.file(join(PUBLIC, p)), { headers: { "cache-control": "public, max-age=31536000, immutable" } });

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
        // Abort the in-flight turn, if there is one. `active` is whichever
        // session's turn is running — same one runTurn() and every tool sink
        // route through — so this reaches it regardless of which browser tab
        // posted here. A no-op (not an error) once nothing is running: the
        // button that calls this hides itself the moment `busy` flips false,
        // but a click already in flight when that happens must not 409.
        case "/chat/stop":
          if (busy && active) active.agent.stop();
          return noContent();
        case "/confirm": {
          // Back-compat: an old client (or a stale open tab) may still post the
          // original {ok, always} shape — read it as allow-once/allow-always so
          // neither breaks mid-upgrade.
          const legacy = typeof b.resolution !== "string";
          const resolution: ConfirmResolution | undefined = legacy
            ? (b.ok === true || b.ok === "true"
                ? b.always === true || b.always === "true"
                  ? "allow-always"
                  : "allow-once"
                : undefined)
            : (b.resolution as ConfirmResolution);
          const key = pendingAllowKey.get(b.token);
          const ok = resolution === "allow-once" || resolution === "allow-turn" || resolution === "allow-always";
          if (key && resolution === "allow-always") {
            setAllowedCommands([...new Set([...allowedCommands(), key])]);
            setDeniedCommands(deniedCommands().filter((k) => k !== key));
          }
          if (key && resolution === "allow-turn") pendingTurnGrant.get(b.token)?.add(key);
          if (key && resolution === "deny-always") {
            setDeniedCommands([...new Set([...deniedCommands(), key])]);
            setAllowedCommands(allowedCommands().filter((k) => k !== key));
          }
          pending.get(b.token)?.(ok);
          pending.delete(b.token);
          pendingAllowKey.delete(b.token);
          pendingTurnGrant.delete(b.token);
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
          s.transcript = [];
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
            try {
              built.setModel(b.id);
              // Machine-level: one model, every session. Announce it to all of them.
              broadcastAll("model", { model: b.id });
            } catch (err) {
              // A bad id or a still-missing key must not 500 the settings panel —
              // that reads as "nothing happened" instead of naming the problem.
              return html(settingsFragment((err as Error).message));
            }
          }
          return html(settingsFragment());
        case "/keys": {
          for (const k of KEY_NAMES) if (b[k]) writeSecret(k as KeyName, b[k].trim());
          try {
            built.refreshModels();
          } catch (err) {
            return html(settingsFragment((err as Error).message));
          }
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
            try {
              built.refreshModels();
            } catch (err) {
              return html(settingsFragment((err as Error).message));
            }
          }
          return html(settingsFragment());
        case "/memory": {
          // A human editing memory through the web UI is the strongest
          // "explicit" signal there is. overrideTombstone is deliberately only
          // reachable here — never from the model-facing remember tool — so a
          // deleted fact can only be un-deleted by a person, not by output the
          // model produced (including output an injected instruction produced).
          const r = saveMemory({
            id: b.id,
            type: b.type || "note",
            description: b.description,
            body: b.body,
            origin: "explicit",
            overrideTombstone: b.overrideTombstone === true || b.overrideTombstone === "true",
          });
          return html(memoryFragment(r.ok ? undefined : r.message));
        }
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
        case "/reflect/approve":
          approveProposal(String(b.id));
          return html(reflectFragment());
        case "/reflect/reject":
          rejectProposal(String(b.id));
          return html(reflectFragment());
        case "/reflect/run":
          runReflection(4);
          return html(reflectFragment());
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
        case "/denied/delete":
          setDeniedCommands(deniedCommands().filter((k) => k !== b.key));
          return html(deniedFragment());
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
        case "/log/clear":
          clearLogs();
          return Response.redirect("/log", 303);
      }
    }

    if (req.method === "GET") {
      if (p === "/flows") return Response.json(loadFlows());
      if (p === "/settings") return html(settingsFragment());
      if (p === "/memory") return html(memoryFragment());
      if (p === "/schedule") return html(scheduleFragment());
      if (p === "/reflect") return html(reflectFragment());
      if (p === "/failures") return html(failuresFragment());
      if (p === "/roots") return html(rootsFragment());
      if (p === "/allowed") return html(allowedFragment());
      if (p === "/mcp") return html(mcpFragment());
      if (p === "/log") return html(logPage());
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
          mcpConnections: Object.entries(mcpServers()).map(([name, spec]) => {
            const catalog = mcpCatalog();
            return {
              name,
              connected: Object.prototype.hasOwnProperty.call(catalog, name),
              trust: spec.trust ?? "ask",
              tools: (catalog[name] ?? []).map((t) => t.full).filter((t) => built.toolNames.includes(t)),
            };
          }),
          // Both seed the page on load, so they must describe the CALLER's
          // conversation — reading the live todo module here would hand a
          // reloading tab whatever another session is mid-way through.
          context: sessionFor(req).agent.stats(),
          todos: sessionFor(req).todos,
          transcript: sessionFor(req).transcript,
          maptilerKey: process.env.MAPTILER_KEY ?? "",
          // Seeds the activity indicator on load/reload — live updates after that
          // come from the "activity" SSE event, shared across every open tab.
          activity: activitySnapshot(),
        });
    }

    return new Response("not found", { status: 404 });
  },
});
} catch (e) {
  const link = `http://127.0.0.1:${PORT}`;
  if ((e as { code?: string }).code === "EADDRINUSE") {
    console.error(`adhd is already running at ${link} — open that in your browser, or set ADHD_PORT to run a second instance.`);
  } else {
    console.error(`adhd failed to start: ${(e as Error).message ?? e}`);
  }
  process.exit(1);
}

const link = `http://127.0.0.1:${PORT}`;
console.log(`adhd web UI → ${link}${built.hasKey() ? "" : "   (add your DeepSeek key in Settings to start)"}`);
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
try {
  Bun.spawn([opener, link]);
} catch {
  /* headless / no browser */
}

// Node/Bun exit immediately on SIGINT/SIGTERM by default — but registering a
// handler (as below) opts OUT of that default, so we must call process.exit()
// ourselves once cleanup is done. Skipping that step is exactly what leaves a
// stdio MCP server's child process running after Ctrl+C: on Windows that
// orphan keeps the console's process group alive, so the shell never gets
// control back (the "Terminate batch job (Y/N)?" hang).
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(schedulerTimer);
  server.stop(true); // true: drop open connections (SSE) instead of waiting on them
  await closeMcpClients();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
