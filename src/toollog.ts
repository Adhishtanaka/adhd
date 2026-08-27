import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { HOME_ROOT } from "./config.js";

// A full activity log, not just tool calls: every user prompt, every tool the
// agent ran (with its args, result, and the token cost of that step), the
// assistant's own reply, and anything that went wrong — one place to answer
// "what did it actually do, and what did that cost". ponytail: bun:sqlite is
// stdlib for a Bun binary, so no dependency to add.
mkdirSync(HOME_ROOT, { recursive: true });
const db = new Database(join(HOME_ROOT, "logs.db"));
db.exec(`CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session TEXT NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,     -- user | tool | assistant | usage | error | info
  name TEXT,              -- tool name, kind='tool' only
  content TEXT,           -- prompt / assistant text / tool args (JSON) / message
  result TEXT,            -- tool result, kind='tool' only
  tokens INTEGER
)`);

// Nullable lineage columns, added after the table already existed for current
// installs — CREATE TABLE IF NOT EXISTS above never reaches them, so this is
// the migration. SQLite errors on a duplicate column; swallow it.
for (const col of ["agent_id TEXT", "parent_agent_id TEXT"]) {
  try {
    db.exec(`ALTER TABLE event_log ADD COLUMN ${col}`);
  } catch {
    /* column already there */
  }
}

// Which (sub)agent is currently running, so a tool call it makes can be traced
// back to its parent turn/agent in the log. Same ALS pattern as tools.ts's
// autoApprove: per-call-stack, not a module flag, since a subagent's send()
// can run while other activity is in flight. `null` (no context) means "not
// inside a lineage-tracked call" — logging just no-ops on the two new columns,
// same as headless/test invocations of logToolCall today.
export type AgentLineage = {
  session: string;
  turn: number;
  agentId: string | null;
  parentAgentId: string | null;
  rootAgentId: string | null;
};
const agentCtx = new AsyncLocalStorage<AgentLineage>();
export function runInAgentContext<T>(lineage: AgentLineage | null, fn: () => Promise<T>): Promise<T> {
  return lineage ? agentCtx.run(lineage, fn) : fn();
}
export function currentAgentContext(): AgentLineage | null {
  return agentCtx.getStore() ?? null;
}

const insertRowStmt = db.query(
  `INSERT INTO event_log (ts, session, turn, kind, name, content, agent_id, parent_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
// One place that fills the two lineage columns from whatever agent context is
// ambient right now — every row (not just tool calls) picks up lineage this
// way, so a subagent's own text/errors are traceable too, not only its tools.
function insertRow(ts: number, session: string, turn: number, kind: string, name: string | null, content: string | null) {
  const ctx = agentCtx.getStore();
  return insertRowStmt.run(ts, session, turn, kind, name, content, ctx?.agentId ?? null, ctx?.parentAgentId ?? null);
}
const setResult = db.query(`UPDATE event_log SET result = ? WHERE id = ?`);
const setTokens = db.query(`UPDATE event_log SET tokens = ? WHERE id IN (SELECT value FROM json_each(?))`);
const recent = db.query(`SELECT * FROM event_log ORDER BY id DESC LIMIT ?`);
const since = db.query(`SELECT * FROM event_log WHERE id > ? ORDER BY id ASC`);
const totals = db.query(
  `SELECT name as tool, COUNT(*) as calls, COALESCE(SUM(tokens), 0) as tokens
   FROM event_log WHERE kind = 'tool' GROUP BY name ORDER BY tokens DESC`,
);

// Cap what lands in the DB — a file dump or a full page scrape shouldn't turn
// the log into a second copy of the conversation. Same idea as tools.ts's cap().
const MAX_FIELD = 1500;
function clip(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= MAX_FIELD ? s : s.slice(0, MAX_FIELD) + `…[${s.length - MAX_FIELD} more chars]`;
}

// One turn = one user message through one reply. adhd runs a single turn at a
// time. Seed the counter from SQLite so turn ids stay unique across restarts;
// otherwise historical rows from separate runs collapse into one log card.
const lastTurn = db.query(`SELECT COALESCE(MAX(turn), 0) AS turn FROM event_log`).get() as { turn: number };
let turnSeq = lastTurn.turn;

export function logUser(session: string, text: string): number {
  const turn = ++turnSeq;
  insertRow(Date.now(), session, turn, "user", null, clip(text));
  return turn;
}

export function logAssistant(session: string, turn: number, text: string): void {
  if (!text.trim()) return;
  insertRow(Date.now(), session, turn, "assistant", null, clip(text));
}

export function logInfo(session: string, turn: number, message: string): void {
  insertRow(Date.now(), session, turn, "info", null, clip(message));
}

export function logError(session: string, turn: number, message: string): void {
  insertRow(Date.now(), session, turn, "error", null, clip(message));
}

// tool-call id -> row id, live only until that call's result/usage lands.
// adhd runs one turn at a time, so a plain module map is enough.
const openCalls = new Map<string, number>();
let pendingRowIds: number[] = []; // tool rows waiting on the next usage total

export function logToolCall(session: string, turn: number, callId: string, tool: string, args: unknown): void {
  const { lastInsertRowid } = insertRow(Date.now(), session, turn, "tool", tool, clip(args));
  const rowId = Number(lastInsertRowid);
  openCalls.set(callId, rowId);
  pendingRowIds.push(rowId);
}

export function logToolResult(callId: string, result: unknown): void {
  const rowId = openCalls.get(callId);
  if (rowId == null) return;
  setResult.run(clip(result), rowId);
  openCalls.delete(callId);
}

// `total` is cumulative-looking but isn't a running sum we keep — it's what the
// AI SDK reports fresh for the step that just finished, and it grows step to
// step only because each step resends the whole conversation so far. Tagging
// tool rows with the raw total would make whichever tool happens to run late
// in a turn look most expensive regardless of what it actually did, so instead
// tag them with the delta since this session's last usage event: how much MORE
// this step cost than the previous one. The step itself still gets its own row
// (with the raw total, not the delta) so a step with no tool calls — often the
// priciest one, the final answer — still shows its true cost.
const lastTotal = new Map<string, number>(); // session -> last usage total seen
export function logUsage(session: string, turn: number, total: number): void {
  const prev = lastTotal.get(session) ?? 0;
  const delta = Math.max(0, total - prev);
  lastTotal.set(session, total);
  if (pendingRowIds.length) {
    setTokens.run(delta, JSON.stringify(pendingRowIds));
    pendingRowIds = [];
  }
  const { lastInsertRowid } = insertRow(Date.now(), session, turn, "usage", null, null);
  setTokens.run(total, JSON.stringify([Number(lastInsertRowid)]));
}

export type LogRow = {
  id: number;
  ts: number;
  session: string;
  turn: number;
  kind: "user" | "tool" | "assistant" | "usage" | "error" | "info";
  name: string | null;
  content: string | null;
  result: string | null;
  tokens: number | null;
  agent_id: string | null;
  parent_agent_id: string | null;
};
export const recentLogs = (limit = 500): LogRow[] => recent.all(limit) as LogRow[];
// Rows added since a watermark id — what reflect.ts scans on each pass, so it
// never re-mines the same activity twice.
export const logsSince = (id: number): LogRow[] => since.all(id) as LogRow[];
export const toolTotals = (): { tool: string; calls: number; tokens: number }[] => totals.all() as any;
export const clearLogs = (): void => void db.exec("DELETE FROM event_log");
