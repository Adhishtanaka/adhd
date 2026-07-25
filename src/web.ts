import { join } from "node:path";
import { existsSync } from "node:fs";
import { marked } from "marked";
import { buildAgent } from "./setup.js";
import { setBashConfirm, setAskUser, orAfter } from "./tools.js";
import { setSubagentSink } from "./subagent.js";
import { setRenderSink } from "./render.js";
import { sanitize } from "./sanitize.js";
import { listFailures, clearFailures, removeDomain } from "./failcache.js";
import { KNOWN_MODELS, KEY_NAMES, keyStatus, writeSecret, loadSecretsIntoEnv, isUnderRoots, allowedRoots, setLocalRoots, allowedCommands, setAllowedCommands, type KeyName } from "./config.js";
import { setJobSinks, type FinishedJob } from "./jobs.js";
import { loadMemories, saveMemory, deleteMemory } from "./memory.js";
import { loadSchedule, saveSchedule, isDue, parseAt, type Task } from "./scheduler.js";
import { loadFlows, saveFlows, seedExamples, toolArgSpecs, RunControl, type Flow } from "./flows.js";

// The AI SDK leaves some internal promises unawaited on error; swallow the stray
// rejections so they don't crash the server (real errors reach the client).
process.on("unhandledRejection", () => {});

loadSecretsIntoEnv(); // hydrate API keys from ~/.adhd/secrets.json before building
const built = await buildAgent();
seedExamples(); // first run: put a few worked examples on the Flows page

// Prefer public/ next to the source; fall back to cwd/public (compiled binary,
// where import.meta.dir isn't a real directory).
const PUBLIC = existsSync(join(import.meta.dir, "..", "public", "index.html"))
  ? join(import.meta.dir, "..", "public")
  : join(process.cwd(), "public");
const PORT = Number(process.env.ADHD_PORT ?? 8787);
const enc = new TextEncoder();

// --- SSE broadcast ----------------------------------------------------------
const clients = new Set<ReadableStreamDefaultController>();
function broadcast(event: string, data: unknown) {
  const chunk = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      /* dropped client */
    }
  }
}

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
setRenderSink((spec) => {
  for (const el of Object.values(spec.elements ?? {})) {
    if (el.type === "Text" && el.props) {
      // props.html is ALWAYS server-derived from content and sanitized — never
      // trust a model-supplied html field (the client drops props.html into
      // innerHTML, so a raw html value here would be a straight XSS bypass).
      if (typeof el.props.content === "string") el.props.html = sanitize(marked.parse(el.props.content) as string);
      else delete el.props.html;
    }
  }
  broadcast("render_ui", { spec });
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
let busy = false;
async function runTurn(message: string) {
  busy = true;
  broadcast("busy", { busy: true });
  let assistant = "";
  try {
    await built.agent.send(message, (e) => {
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
    busy = false;
    broadcast("busy", { busy: false });
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
setJobSinks(
  (j) => {
    finishedJobs.push(j);
    broadcast("info", { message: `[${j.id}] ${j.label} — finished after ${j.seconds}s` });
    scheduleDrain();
  },
  (id, label) => broadcast("info", { message: `[${id}] ${label} — still running, continuing in the background` }),
);
function drainJobs() {
  if (busy || !finishedJobs.length || !built.hasKey()) return;
  const jobs = finishedJobs.splice(0); // take every finished job — one turn, not one each
  broadcast("notify", { title: "Background task finished", body: jobs.map((j) => j.label).join(", ") });
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
  currentRun = new RunControl();
  broadcast("busy", { busy: true });
  broadcast("flow", { type: "run-start", name: flow.name });
  try {
    await built.runFlow(flow, (e) => broadcast("flow", e), currentRun);
  } catch (err) {
    broadcast("flow", { type: "node-error", id: "", ms: 0, message: (err as Error)?.message ?? String(err) });
  } finally {
    currentRun = null;
    busy = false;
    broadcast("busy", { busy: false });
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
      broadcast("info", { message: `[scheduled] ${t.id}` });
      broadcast("notify", { title: `Scheduled: ${t.id}`, body: t.prompt });
      // A prompt of "flow:<id>" runs a saved flow instead of a chat turn — reuses
      // the existing schedule format, so no migration and no extra UI.
      if (t.prompt.startsWith("flow:")) void runFlowById(t.prompt.slice(5).trim());
      else void runTurn(t.prompt);
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
  return `
    <h2>Appearance</h2>
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
    <h2>API keys</h2>
    <p class="muted">Stored in <span class="mono">~/.adhd/secrets.json</span> (chmod 600). Keys never leave this machine.</p>
    <div class="settings-section">${keyRows}</div>
    <h2>Memory <span class="muted">(${built.memoryIds.length ? "" : "none yet"})</span></h2>
    <div class="settings-section"><div id="mem">${memoryFragment()}</div></div>
    <h2>Schedule</h2>
    <div class="settings-section"><div id="sched">${scheduleFragment()}</div></div>
    <h2>Local folders <span class="muted">(files adhd may read)</span></h2>
    <div class="settings-section"><div id="roots">${rootsFragment()}</div></div>
    <h2>Always-allowed commands <span class="muted">(run without asking)</span></h2>
    <div class="settings-section"><div id="allowed">${allowedFragment()}</div></div>
    <h2>Notifications</h2>
    <div class="settings-section">
      <div class="row">
        <span>Notify when a scheduled task runs</span>
        <label class="switch"><input type="checkbox" id="notif-toggle" /><span class="track"></span></label>
      </div>
    </div>
    <h2>Blocked pages <span class="muted">(fetch failures)</span></h2>
    <div class="settings-section"><div id="fails">${failuresFragment()}</div></div>`;
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

    // static
    if (p === "/") return new Response(Bun.file(join(PUBLIC, "index.html")));
    if (p === "/app.js" || p === "/app.css" || p === "/htmx.min.js" || p === "/flow.js")
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
      let ref: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ref = c;
          clients.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() {
          clients.delete(ref);
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
          void runTurn(message);
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
          broadcast("flow", { type: "state", state });
          return Response.json({ state });
        }
        case "/new":
          built.agent.reset();
          return noContent();
        case "/model":
          if (b.id) {
            built.setModel(b.id);
            broadcast("model", { model: b.id });
          }
          return html(settingsFragment());
        case "/keys": {
          for (const k of KEY_NAMES) if (b[k]) writeSecret(k as KeyName, b[k].trim());
          built.refreshModels();
          return html(settingsFragment());
        }
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
      if (p === "/state")
        // maptilerKey is a client-side map-tile key (public by design, kept in .env
        // not source) — the browser needs it to load MapTiler tiles.
        return Response.json({
          model: built.config.model,
          models: KNOWN_MODELS,
          hasKey: built.hasKey(),
          tools: built.toolNames.length,
          // for the Flows page tool-node picker: the tools a flow node may call
          // directly (the agent-control ones aren't usable without a model turn)
          toolNames: built.toolNames.filter((t) => !["spawn_agent", "loop_task", "run_flow", "render_ui", "ask_user"].includes(t)),
          toolArgs: built.toolArgs, // arg fields per tool, read off each tool's schema
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
