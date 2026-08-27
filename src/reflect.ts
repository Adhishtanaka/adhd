import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_ROOT } from "./config.js";
import { logsSince, type LogRow } from "./toollog.js";
import { loadFlows, saveFlows, type Flow, type FlowNode, type FlowEdge } from "./flows.js";
import { loadMemories, saveMemory, memoryFingerprint } from "./memory.js";
import { loadSchedule, saveSchedule } from "./scheduler.js";

// Reflection mines the activity log (toollog.ts) for things that keep
// repeating and turns them into DRAFTS a person reviews — never a write on
// its own. The whole point is saving tokens, so mining is pure code (word/
// sequence frequency counting), never a model call: scanning the log for
// patterns costs nothing, and an approved flow later runs its tool nodes
// with zero model calls too (see flows.ts), which is strictly cheaper than
// redoing the same steps by chat every time.

export const REFLECT_STATE_FILE = join(HOME_ROOT, "reflect-state.json");
export const REFLECT_PROPOSALS_FILE = join(HOME_ROOT, "reflect-proposals.json");

// id: "flow:<tool>>...>...>" or "memory:<keyword>" — stable, doubles as the
// dedupe key. `kind` drives `draft`'s shape directly so a `p.kind === "flow"`
// check narrows `p.draft` without an extra type guard.
export type Proposal =
  | {
      id: string;
      kind: "memory";
      count: number;
      summary: string;
      createdAt: string;
      draft: { memory: Parameters<typeof saveMemory>[0] };
    }
  | {
      id: string;
      kind: "flow";
      count: number;
      summary: string;
      createdAt: string;
      draft: { flow: Flow; skill: { name: string; description: string; body: string } };
    };

type ReflectState = {
  lastLogId: number;
  sequenceCounts: Record<string, { count: number; argsByTool: Record<string, string> }>;
  wordCounts: Record<string, { count: number; examples: string[] }>;
  dismissed: string[]; // proposal ids the user rejected — never re-proposed
};

const emptyState = (): ReflectState => ({ lastLogId: 0, sequenceCounts: {}, wordCounts: {}, dismissed: [] });

function loadState(): ReflectState {
  if (!existsSync(REFLECT_STATE_FILE)) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(REFLECT_STATE_FILE, "utf8")) };
  } catch {
    return emptyState();
  }
}

function saveState(state: ReflectState): void {
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(REFLECT_STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadProposals(): Proposal[] {
  if (!existsSync(REFLECT_PROPOSALS_FILE)) return [];
  try {
    const v = JSON.parse(readFileSync(REFLECT_PROPOSALS_FILE, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals: Proposal[]): void {
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(REFLECT_PROPOSALS_FILE, JSON.stringify(proposals, null, 2));
}

// --- tool-sequence mining ("you keep doing these steps by hand") -----------

// Control-flow tools aren't "work" to fold into a flow — they're how the
// agent talks to the user or tracks itself.
const TRIVIAL_TOOLS = new Set(["ask_user", "todo_write"]);
const MAX_TOOLS_PER_TURN = 20; // bound the n-gram scan on a runaway turn

function toolSeq(f: Flow): string[] {
  return f.nodes.filter((n) => n.type === "tool").map((n) => n.data.tool || "");
}

function flowAlreadyCovers(key: string, flows: Flow[]): boolean {
  return flows.some((f) => toolSeq(f).join(">").includes(key));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseArgs(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [k, typeof val === "string" ? val : JSON.stringify(val)]),
      );
    }
  } catch {
    /* truncated (clip()) or non-JSON — leave blank, reviewable on the canvas */
  }
  return {};
}

function draftFlow(
  names: string[],
  argsByTool: Record<string, string>,
  count: number,
): { flow: Flow; skill: { name: string; description: string; body: string } } {
  const flowId = `reflect-${slugify(names.join("-"))}`;
  const flowName = `Reflect · ${names.join(" → ")}`;
  const toolIds = names.map((_, i) => `t${i}`);
  const nodes: FlowNode[] = [
    { id: "s", type: "start", data: {} },
    ...names.map((n, i) => ({ id: toolIds[i], type: "tool" as const, data: { tool: n, args: parseArgs(argsByTool[n]) } })),
    { id: "e", type: "end", data: {} },
  ];
  const chain = ["s", ...toolIds, "e"];
  const edges: FlowEdge[] = chain.slice(0, -1).map((source, i) => ({ source, target: chain[i + 1] }));
  const skill = {
    name: flowId,
    description:
      `Automates ${names.join(" → ")} (seen ${count}×). Call run_flow with name "${flowName}" instead of repeating these steps by hand.`.replace(
        /\n/g,
        " ",
      ),
    body:
      `This flow was proposed by reflection after the sequence ${names.join(" → ")} repeated ${count} times.\n\n` +
      `When a request matches this pattern, call run_flow with name "${flowName}" rather than running each tool ` +
      `yourself — it does the same steps with no model call per step.`,
  };
  return { flow: { id: flowId, name: flowName, nodes, edges }, skill };
}

// --- topic mining ("you keep asking about the same thing") -----------------

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "what", "when",
  "where", "which", "would", "could", "should", "about", "your", "just",
  "like", "need", "want", "please", "today", "tomorrow", "some", "them",
  "they", "there", "then", "than", "been", "also", "into", "over", "only",
  "more", "most", "much", "many", "does", "doing", "done", "will", "make",
]);

function extractKeys(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const keys = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    keys.add(words[i]);
    if (i + 1 < words.length) keys.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...keys];
}

// Substring check catches partial-overlap cases a hash never will (a memory
// that already mentions the keyword among other things); the fingerprint check
// added on top catches the case a substring check misses — a PREVIOUS reflect
// pass's draft for this exact same body, saved under a different keyword/id.
function memoryAlreadyCovers(key: string, memories: ReturnType<typeof loadMemories>, draftBody?: string): boolean {
  const substringHit = memories.some((m) => `${m.id} ${m.description} ${m.tags.join(" ")} ${m.body}`.toLowerCase().includes(key));
  if (substringHit) return true;
  if (!draftBody) return false;
  const fp = memoryFingerprint(draftBody);
  return memories.some((m) => memoryFingerprint(m.body) === fp);
}

function draftMemory(key: string, count: number, examples: string[]): Parameters<typeof saveMemory>[0] {
  return {
    id: `reflect/${slugify(key)}`,
    type: "pattern",
    description: `Asked about "${key}" ${count}×`,
    tags: ["reflect"],
    body: `Recurring theme in requests (seen ${count} times):\n\n${examples.map((e) => `- ${e}`).join("\n")}`,
    origin: "synthesized",
  };
}

// --- the scan ----------------------------------------------------------------

/**
 * Scan activity since the last run, update the running frequency counters,
 * and turn any counter that just crossed `threshold` into a pending proposal
 * (skipping anything already dismissed, already pending, or already covered
 * by an existing memory/flow). Returns only the NEWLY added proposals.
 */
export function runReflection(threshold = 4): Proposal[] {
  const state = loadState();
  const rows = logsSince(state.lastLogId);
  if (!rows.length) return [];

  const byTurn = new Map<number, LogRow[]>();
  for (const r of rows) {
    if (r.kind !== "tool" && r.kind !== "user") continue;
    const arr = byTurn.get(r.turn) ?? [];
    arr.push(r);
    byTurn.set(r.turn, arr);
  }

  for (const turnRows of byTurn.values()) {
    const toolRows = turnRows
      .filter((r) => r.kind === "tool" && r.name && !TRIVIAL_TOOLS.has(r.name))
      .slice(0, MAX_TOOLS_PER_TURN);
    const names = toolRows.map((r) => r.name!);
    const seenKeys = new Set<string>();
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= names.length; i++) {
        const seq = names.slice(i, i + len);
        const key = seq.join(">");
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const entry = state.sequenceCounts[key] ?? { count: 0, argsByTool: {} };
        entry.count++;
        for (let j = 0; j < seq.length; j++) {
          const row = toolRows[i + j];
          if (row.content) entry.argsByTool[seq[j]] = row.content;
        }
        state.sequenceCounts[key] = entry;
      }
    }

    const userRow = turnRows.find((r) => r.kind === "user");
    if (userRow?.content) {
      for (const key of extractKeys(userRow.content)) {
        const entry = state.wordCounts[key] ?? { count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 3) entry.examples.push(userRow.content.slice(0, 200));
        state.wordCounts[key] = entry;
      }
    }
  }

  const proposals = loadProposals();
  const pendingIds = new Set(proposals.map((p) => p.id));
  const dismissed = new Set(state.dismissed);
  const flows = loadFlows();
  const memories = loadMemories();
  const added: Proposal[] = [];

  // Longest sequence first, so "A>B>C" crossing threshold suppresses the
  // redundant "A>B" proposal in the same pass instead of proposing both.
  const seqKeys = Object.keys(state.sequenceCounts).sort((a, b) => b.split(">").length - a.split(">").length);
  const proposedThisRun: string[] = [];
  for (const key of seqKeys) {
    const id = `flow:${key}`;
    if (dismissed.has(id) || pendingIds.has(id)) continue;
    const { count, argsByTool } = state.sequenceCounts[key];
    if (count < threshold) continue;
    if (flowAlreadyCovers(key, flows)) continue;
    if (proposedThisRun.some((k) => k.includes(key))) continue;
    const names = key.split(">");
    const { flow, skill } = draftFlow(names, argsByTool, count);
    const p: Proposal = {
      id,
      kind: "flow",
      count,
      summary: `Repeats ${names.join(" → ")} (${count}×) — turn into a flow`,
      createdAt: new Date().toISOString(),
      draft: { flow, skill },
    };
    proposals.push(p);
    added.push(p);
    pendingIds.add(id);
    proposedThisRun.push(key);
  }

  for (const [key, { count, examples }] of Object.entries(state.wordCounts)) {
    const id = `memory:${key}`;
    if (dismissed.has(id) || pendingIds.has(id)) continue;
    if (count < threshold) continue;
    const draft = draftMemory(key, count, examples);
    if (memoryAlreadyCovers(key, memories, draft.body)) continue;
    const p: Proposal = {
      id,
      kind: "memory",
      count,
      summary: `Asked about "${key}" ${count}× — save as memory`,
      createdAt: new Date().toISOString(),
      draft: { memory: draft },
    };
    proposals.push(p);
    added.push(p);
    pendingIds.add(id);
  }

  state.lastLogId = rows[rows.length - 1].id;
  saveState(state);
  saveProposals(proposals);
  return added;
}

function serializeSkill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

export function approveProposal(id: string): { ok: boolean; message: string } {
  const proposals = loadProposals();
  const p = proposals.find((x) => x.id === id);
  if (!p) return { ok: false, message: `no pending proposal "${id}"` };
  if (p.kind === "memory") {
    const r = saveMemory(p.draft.memory);
    if (!r.ok) return { ok: false, message: r.message }; // leave it pending so the user sees why
  } else {
    saveFlows([...loadFlows(), p.draft.flow]);
    const dir = join(HOME_ROOT, "skills", p.draft.skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), serializeSkill(p.draft.skill.name, p.draft.skill.description, p.draft.skill.body));
  }
  saveProposals(proposals.filter((x) => x.id !== id));
  return { ok: true, message: `applied ${id}` };
}

export function rejectProposal(id: string): { ok: boolean; message: string } {
  const proposals = loadProposals();
  if (!proposals.some((x) => x.id === id)) return { ok: false, message: `no pending proposal "${id}"` };
  saveProposals(proposals.filter((x) => x.id !== id));
  const state = loadState();
  if (!state.dismissed.includes(id)) state.dismissed.push(id);
  saveState(state);
  return { ok: true, message: `dismissed ${id}` };
}

// A one-time marker, same trick as flows.ts's seedExamples: adds the daily
// reflect task to the schedule once, ever, so deleting or retuning it later
// sticks instead of coming back on the next launch.
const REFLECT_SEEDED_MARK = join(HOME_ROOT, ".reflect-seeded");

export function seedReflectTask(): void {
  if (existsSync(REFLECT_SEEDED_MARK)) return;
  mkdirSync(HOME_ROOT, { recursive: true });
  const tasks = loadSchedule();
  if (!tasks.some((t) => t.id === "reflect")) {
    saveSchedule([...tasks, { id: "reflect", at: "03:00", prompt: "reflect" }]);
  }
  writeFileSync(REFLECT_SEEDED_MARK, new Date().toISOString());
}
