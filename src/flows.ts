import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateText, tool, type Tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { HOME_ROOT } from "./config.js";
import { cap } from "./tools.js";
import { loadMemories } from "./memory.js";

// A flow is a saved graph the user drew on the canvas. Nodes/edges are stored in
// React Flow's OWN shape so the page round-trips them with no mapping code —
// position and any extra canvas fields ride along untouched.
export const FLOWS_FILE = join(HOME_ROOT, "flows.json");

export type NodeKind = "start" | "prompt" | "if" | "switch" | "tool" | "merge" | "end";
export type FlowNode = {
  id: string;
  type: NodeKind;
  position?: { x: number; y: number };
  // useMemory (prompt nodes only): fold the user's saved memories into the step
  // so it can answer with what adhd knows about them. Off by default.
  // cases (switch nodes only): the labels the model routes the input into; the
  // matching edge's sourceHandle is the label, with "else" as the catch-all.
  data: {
    prompt?: string;
    question?: string;
    cases?: string[];
    tool?: string;
    args?: Record<string, string>;
    useMemory?: boolean;
    // key (any node): the name later nodes read this node's output by, as
    // {{key}}. Unset = the node's id, so every output is addressable whether or
    // not anyone named it — `key` only buys a name a human can type.
    key?: string;
    // model (prompt/if/switch): run THIS step on a different LLM — a cheap one
    // to classify a switch, the strong one for the reviewer node. Unset = the
    // flow's default, which follows whatever /model is set to.
    model?: string;
  };
};
export type FlowEdge = { id?: string; source: string; target: string; sourceHandle?: string | null };
export type Flow = { id: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] };

export function loadFlows(): Flow[] {
  if (!existsSync(FLOWS_FILE)) return [];
  try {
    const v = JSON.parse(readFileSync(FLOWS_FILE, "utf8"));
    return Array.isArray(v) ? v.filter((f) => f?.id && Array.isArray(f?.nodes)) : [];
  } catch {
    return [];
  }
}

export function saveFlows(flows: Flow[]): void {
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(FLOWS_FILE, JSON.stringify(flows, null, 2));
}

// --- examples ---------------------------------------------------------------
// Seeded on first run so the canvas isn't a blank page: three shapes that cover
// most of what people build — fan out from a tool, branch on a check, and a
// plain multi-step write-up.
const at = (x: number, y: number) => ({ x, y });
export const EXAMPLE_FLOWS: Flow[] = [
  {
    id: "example-morning-brief",
    name: "Example · Morning brief",
    nodes: [
      { id: "s", type: "start", position: at(40, 160), data: {} },
      { id: "search", type: "tool", position: at(200, 140), data: { tool: "web_search", args: { q: "top news today" } } },
      { id: "sum", type: "prompt", position: at(430, 140), data: { prompt: "Summarize this into 5 short bullets. No preamble." } },
      { id: "save", type: "tool", position: at(660, 140), data: { tool: "write_file", args: { path: "~/brief.md", content: "{{prev}}" } } },
      { id: "e", type: "end", position: at(890, 160), data: {} },
    ],
    edges: [
      { source: "s", target: "search" },
      { source: "search", target: "sum" },
      { source: "sum", target: "save" },
      { source: "save", target: "e" },
    ],
  },
  {
    id: "example-umbrella",
    name: "Example · Umbrella check",
    nodes: [
      { id: "s", type: "start", position: at(40, 200), data: {} },
      { id: "w", type: "tool", position: at(190, 180), data: { tool: "web_search", args: { q: "weather forecast tomorrow Colombo" } } },
      { id: "q", type: "if", position: at(430, 180), data: { question: "Does this forecast mention rain or showers?" } },
      { id: "y", type: "prompt", position: at(680, 100), data: { prompt: "Write one line telling me to take an umbrella, with the expected rain time." } },
      { id: "n", type: "prompt", position: at(680, 300), data: { prompt: "Write one line saying no umbrella needed, with the expected high temperature." } },
      { id: "e", type: "end", position: at(920, 200), data: {} },
    ],
    edges: [
      { source: "s", target: "w" },
      { source: "w", target: "q" },
      { source: "q", target: "y", sourceHandle: "yes" },
      { source: "q", target: "n", sourceHandle: "no" },
      { source: "y", target: "e" },
      { source: "n", target: "e" },
    ],
  },
  {
    id: "example-notes",
    name: "Example · File to todo list",
    nodes: [
      { id: "s", type: "start", position: at(40, 160), data: {} },
      { id: "read", type: "tool", position: at(200, 140), data: { tool: "read_file", args: { path: "~/notes.md" } } },
      { id: "todo", type: "prompt", position: at(430, 140), data: { prompt: "Pull every action item out of these notes. Return a markdown checklist, nothing else." } },
      { id: "write", type: "tool", position: at(660, 140), data: { tool: "write_file", args: { path: "~/todos.md", content: "{{prev}}" } } },
      { id: "e", type: "end", position: at(890, 160), data: {} },
    ],
    edges: [
      { source: "s", target: "read" },
      { source: "read", target: "todo" },
      { source: "todo", target: "write" },
      { source: "write", target: "e" },
    ],
  },
];

// A one-time marker so examples seed on the very first run only. Without it,
// re-adding "missing" examples every launch means a deleted example keeps
// coming back — which is exactly what we don't want.
const SEEDED_MARK = join(HOME_ROOT, ".flows-seeded");

/** Seed the example flows once, ever. After that, deletions stick. */
export function seedExamples(): void {
  if (existsSync(SEEDED_MARK)) return;
  mkdirSync(HOME_ROOT, { recursive: true });
  if (!existsSync(FLOWS_FILE)) saveFlows(EXAMPLE_FLOWS);
  writeFileSync(SEEDED_MARK, new Date().toISOString());
}

// --- what a node is ---------------------------------------------------------
// A node is a FUNCTION, not an agent: input in, output out, nothing else. A
// prompt node is one plain model call with NO tools — it can't wander off doing
// its own web research. If you want a tool run, that's a tool node, wired in.
// Data moves along the edges: each node's output becomes the next node's input,
// substituted for {{prev}} or appended when there's no placeholder.
// Cycle guard, counted in NODE RUNS rather than rounds — otherwise a five-wide
// fan-out would quietly buy itself 30 rounds of five model calls each.
const MAX_STEPS = 30;

export const CANCELLED = "flow-cancelled";

/** Pause/resume/stop for one run. Checked between nodes; aborts model calls. */
export class RunControl {
  private paused = false;
  private cancelled = false;
  readonly ac = new AbortController();
  get signal(): AbortSignal {
    return this.ac.signal;
  }
  get state(): "running" | "paused" | "stopped" {
    return this.cancelled ? "stopped" : this.paused ? "paused" : "running";
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  stop(): void {
    this.cancelled = true;
    this.paused = false;
    this.ac.abort();
  }
  /** Per-node checkpoint: blocks while paused, throws once stopped. Awaited as
   *  the first thing in every node, so a pause lands before any node-start. */
  async gate(): Promise<void> {
    while (this.paused && !this.cancelled) await new Promise((r) => setTimeout(r, 150));
    if (this.cancelled) throw new Error(CANCELLED);
  }
}

export type FlowEvent =
  // branch is the edge handle taken out of an if/switch node ("yes"/"no" or a case label).
  | { type: "node-start"; id: string; kind: NodeKind; label: string }
  | { type: "node-done"; id: string; ms: number; output: string; branch?: string }
  | { type: "node-error"; id: string; ms: number; message: string }
  | { type: "run-done"; output: string }
  | { type: "run-stopped" };

/** Every output the run has produced, keyed by data.key (or the node id). */
export type FlowState = Record<string, string>;

/** Everything a node hands its executor besides the text it was given. */
export type NodeOpts = {
  signal: AbortSignal;
  // A snapshot as of the start of this superstep — a node cannot see a sibling
  // running beside it right now. Readonly because it belongs to runFlow.
  state: Readonly<FlowState>;
  model?: string; // node.data.model
  useMemory?: boolean; // node.data.useMemory
};

// One options object rather than four positional args: useMemory was already
// the fourth, and state + model would have made it six.
export type FlowExec = {
  runPrompt: (prompt: string, input: string, o: NodeOpts) => Promise<string>;
  runIf: (question: string, input: string, o: NodeOpts) => Promise<boolean>;
  // Returns the chosen case label — one of `cases`, or "else" if none fit.
  runSwitch: (cases: string[], input: string, o: NodeOpts) => Promise<string>;
  runTool: (name: string, args: Record<string, string>, input: string, o: NodeOpts) => Promise<string>;
};

/**
 * Just the placeholder swap — used for tool args, which must NOT grow silently.
 * {{prev}} is the input on the edge; {{anythingElse}} is another node's output
 * by key. An unknown key is left alone on purpose: blanking it hides the typo,
 * and a flow that writes a mustache template to a file has every right to a
 * literal {{name}} in its content. (Function replacer, not a string one: `$&`
 * and `$'` in a model's output would otherwise be read as capture syntax.)
 */
export function subst(text: string, input: string, state: Readonly<FlowState> = {}): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
    k === "prev" ? input : k in state ? state[k]! : m,
  );
}

/**
 * Prompt/if text: a placeholder is substituted, and if the text had none the
 * input is appended so the step still sees it. Tool ARGS use subst() instead —
 * auto-appending there turned a `path: "hi.txt"` into "hi.txt\n\nInput:\n…" and
 * blew up with ENAMETOOLONG. "Had none" is now "substitution changed nothing",
 * which covers {{prev}} and {{key}} in one test: a node that composes its own
 * inputs by key does not want the last arrival stapled on the end as well.
 */
export function fill(text: string, input: string, state: Readonly<FlowState> = {}): string {
  const out = subst(text, input, state);
  return out === text && input ? `${text}\n\nInput:\n${input}` : out;
}

/** Canvas fields are text; tool schemas want real types. "5" → 5, "true" → true. */
export function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

// The tools don't expand ~ (the agent passes absolute paths), but a person typing
// a path on the canvas writes "~/notes.md". Expand a leading ~/ so it just works.
const HOME = homedir();
export function expandHome(v: string): string {
  if (v === "~") return HOME;
  if (v.startsWith("~/")) return join(HOME, v.slice(2));
  return v;
}

export type ArgSpec = { key: string; required: boolean; description?: string; options?: string[] };

/**
 * The argument list for each tool, read off its zod schema, so the canvas can
 * show real fields instead of asking the user to guess key names.
 */
export function toolArgSpecs(tools: Record<string, Tool>): Record<string, ArgSpec[]> {
  const out: Record<string, ArgSpec[]> = {};
  for (const [name, t] of Object.entries(tools)) {
    const shape = (t.inputSchema as any)?._def?.shape?.();
    if (!shape) continue;
    out[name] = Object.entries(shape).map(([key, f]: [string, any]) => {
      // unwrap optional/default/nullable to reach the real type
      let inner = f;
      for (let i = 0; i < 5 && inner?._def?.innerType; i++) inner = inner._def.innerType;
      const values = inner?._def?.values ?? inner?._def?.options;
      return {
        key,
        required: typeof f.isOptional === "function" ? !f.isOptional() : true,
        description: f.description ?? inner?.description,
        options: Array.isArray(values) ? values.map(String) : undefined,
      };
    });
  }
  return out;
}

/** Entry = the Start node; failing that, whatever node nothing points at. */
function entryNode(flow: Flow): FlowNode | undefined {
  const targets = new Set(flow.edges.map((e) => e.target));
  return (
    flow.nodes.find((n) => n.type === "start") ?? flow.nodes.find((n) => !targets.has(n.id)) ?? flow.nodes[0]
  );
}

const label = (n: FlowNode): string => {
  if (n.type === "tool") return n.data.tool || "(no tool)";
  if (n.type === "start") return "start";
  if (n.type === "end") return "end";
  if (n.type === "if") return n.data.question || "(empty)";
  if (n.type === "switch") return n.data.question || `switch: ${(n.data.cases ?? []).join(" / ") || "(no cases)"}`;
  if (n.type === "merge") return "merge";
  return n.data.prompt || "(empty)";
};

/**
 * Walk the graph one SUPERSTEP at a time: every node currently queued runs at
 * once, then their results are applied in queue order. Pure traversal —
 * executors are injected, so tests drive it without a model. Emits an event per
 * node so the UI can show what actually happened instead of a wall of tool names.
 */
export async function runFlow(
  flow: Flow,
  ex: FlowExec,
  emit: (e: FlowEvent) => void = () => {},
  ctl: RunControl = new RunControl(),
): Promise<string> {
  const entry = entryNode(flow);
  if (!entry) return "(empty flow)";
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));

  // Incoming-edge count per node. A merge waits for ALL of its incoming edges
  // before firing; every other node fires on the first input that reaches it
  // (which is what keeps if/switch branches converging on one node working).
  const inCount = new Map<string, number>();
  for (const e of flow.edges) inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1);

  // Inputs that have arrived on a node's incoming edges but not yet consumed.
  const received = new Map<string, { label: string; output: string }[]>();
  const queue: FlowNode[] = [entry];
  // Every output so far, so node 5 can read node 1. The lone `out` on an edge
  // only ever reached the next node, and a non-merge node keeps just the LAST
  // arrival — everything earlier went on the floor.
  //
  // ponytail: a flat string→string bag, last write wins, and it dies with the
  // run. No typed schema, no per-key reducers, no checkpoints, no time-travel.
  // Upgrade path in order of likely need: (1) a reducer table keyed by state key
  // so a node can append instead of clobber — it slots into the one line in the
  // apply pass that assigns state[...]; (2) checkpointing = snapshot
  // {state, received, queue, steps} per superstep, a persistence feature bolted
  // onto that same loop rather than a rewrite of it.
  const state: FlowState = {};
  let result = "";

  const deliver = (targetId: string, srcLabel: string, output: string) => {
    const arr = received.get(targetId) ?? [];
    arr.push({ label: srcLabel, output });
    received.set(targetId, arr);
    const target = nodeById.get(targetId);
    if (!target) return;
    const need = target.type === "merge" ? inCount.get(targetId) ?? 1 : 1;
    if (arr.length >= need) queue.push(target);
  };

  // One node run, with its failure TAGGED rather than thrown: a sibling blowing
  // up must not reject the batch out from under the nodes that succeeded, and
  // must not decide the run's outcome just by failing first on the wire.
  type Ran = { node: FlowNode; ms: number } & (
    | { ok: true; out: string; branch?: string }
    | { ok: false; message: string }
  );
  const run = async (node: FlowNode, input: string): Promise<Ran> => {
    // The edge handle to leave by. undefined = fan out to every out-edge;
    // set = a branch (if → "yes"/"no", switch → a case label).
    let branch: string | undefined;
    let out = input;
    const started = Date.now();
    const o: NodeOpts = {
      signal: ctl.signal,
      state,
      model: node.data.model,
      useMemory: !!node.data.useMemory,
    };
    try {
      await ctl.gate();
      emit({ type: "node-start", id: node.id, kind: node.type, label: label(node) });
      switch (node.type) {
        case "start":
        case "merge":
        case "end":
          break; // start marks the entry; merge's output IS the joined input; end carries it out
        case "prompt":
          out = await ex.runPrompt(node.data.prompt ?? "", input, o);
          break;
        case "if":
          branch = (await ex.runIf(node.data.question ?? "", input, o)) ? "yes" : "no";
          break;
        case "switch":
          branch = await ex.runSwitch(node.data.cases ?? [], input, o);
          break;
        case "tool":
          out = await ex.runTool(node.data.tool ?? "", node.data.args ?? {}, input, o);
          break;
        default:
          throw new Error(`unknown node type "${(node as FlowNode).type}"`);
      }
      return { node, ms: Date.now() - started, ok: true, out, branch };
    } catch (e) {
      return { node, ms: Date.now() - started, ok: false, message: (e as Error)?.message ?? String(e) };
    }
  };

  let steps = 0;
  while (steps < MAX_STEPS) {
    if (!queue.length) {
      // Queue drained. A merge behind a pruned if/switch branch may be holding
      // partial inputs that will never complete — fire it with what it has so
      // the run finishes instead of silently dropping them.
      const stuck = flow.nodes.find(
        (n) => n.type === "merge" && (received.get(n.id)?.length ?? 0) > 0,
      );
      if (!stuck) {
        emit({ type: "run-done", output: result });
        return result;
      }
      queue.push(stuck);
    }
    // splice, not shift: the whole queue is one superstep. Clamped to what's
    // left of the budget so a wide batch can't overshoot the cap.
    const batch = queue.splice(0, MAX_STEPS - steps);
    steps += batch.length;

    // Inputs are consumed HERE — synchronously, in queue order — so two nodes in
    // one batch can't race for the same `received` list. Only the executor call
    // is concurrent. A merge joins its inputs into labeled sections so a
    // downstream prompt can tell the sources apart; any other node takes the
    // most recent input, as before.
    const runs = batch.map((node) => {
      const ins = received.get(node.id) ?? [];
      received.set(node.id, []);
      return run(
        node,
        node.type === "merge"
          ? ins.map((r, i) => `## ${i + 1} · ${r.label}\n${r.output}`).join("\n\n")
          : ins[ins.length - 1]?.output ?? "",
      );
    });

    let failure: string | undefined;
    let ended: string | undefined;
    for (const r of await Promise.all(runs)) {
      if (!r.ok) {
        if (r.message === CANCELLED || ctl.state === "stopped") {
          emit({ type: "run-stopped" });
          return result;
        }
        // One bad node ends the run — continuing would feed garbage downstream.
        // Its siblings already ran (nothing un-calls a model), so they keep their
        // events; the earliest failure IN QUEUE ORDER is the one reported, so a
        // rerun blames the same node instead of whichever timed out first.
        emit({ type: "node-error", id: r.node.id, ms: r.ms, message: r.message });
        failure ??= `${r.node.id} failed: ${r.message}`;
        continue;
      }
      emit({ type: "node-done", id: r.node.id, ms: r.ms, output: r.out, branch: r.branch });
      // Writes land here, in queue order, NOT inside the node — so "last writer
      // wins" is a property of the graph, not of whose HTTP response came back
      // first. Everything in this batch read `state` as it was before the batch.
      state[r.node.data.key || r.node.id] = r.out;
      // ponytail: a fan-out that ends without a merge/end reports the LAST
      // branch. Wire a Merge node if you want them joined — every branch is
      // still in `state` under its key, it just isn't the return value.
      result = r.out;
      if (r.node.type === "end") {
        ended ??= r.out;
        continue; // end terminates: nothing leaves it
      }
      const from = flow.edges.filter((e) => e.source === r.node.id);
      // Plain node: every out-edge (fan-out). Branch node: the edges whose handle
      // matches the chosen label ("yes"/"no" or a case), falling back to "else".
      const matched =
        r.branch === undefined ? from : from.filter((e) => (e.sourceHandle ?? "yes") === r.branch);
      const live =
        r.branch !== undefined && !matched.length ? from.filter((e) => e.sourceHandle === "else") : matched;
      const lbl = label(r.node);
      for (const e of live) deliver(e.target, lbl, r.out);
    }
    if (failure) {
      emit({ type: "run-done", output: result });
      return failure;
    }
    if (ended !== undefined) {
      emit({ type: "run-done", output: ended });
      return ended;
    }
  }
  const capped = `${result}\n\n(stopped at the ${MAX_STEPS}-step cap — check for a cycle)`;
  emit({ type: "run-done", output: capped });
  return capped;
}

// --- the real executors -----------------------------------------------------
const NODE_SYSTEM =
  "You are one step in an automated workflow. Do exactly what the step says with the input given. " +
  "Return only the result — no preamble, no commentary, no offers to help.";

// Full memory bodies inline (capped) — a prompt node can't call recall, so the
// content has to be in the prompt to be usable.
function memoryBlock(): string {
  const mems = loadMemories();
  if (!mems.length) return "";
  const body = mems.map((m) => `## ${m.id} (${m.type})\n${m.description}\n${m.body}`).join("\n\n");
  return `\n\nWhat you know about the user (their saved memories):\n${cap(body, 4000)}`;
}

export type FlowRunner = (
  flow: Flow,
  emit?: (e: FlowEvent) => void,
  ctl?: RunControl,
) => Promise<string>;

/**
 * `tools` is what tool NODES may call. Prompt nodes get no tools at all — they
 * are a single generateText call, which is what keeps a flow deterministic and
 * stops a step from running off on its own research spree.
 */
export function flowRunner(opts: {
  models: LanguageModel[];
  tools: Record<string, Tool>;
  // Per-node model lookup, injected rather than resolved here so flows.ts never
  // reaches for config (and so tests stay model-free). Only called for a node
  // that actually names a model.
  modelFor?: (id: string) => LanguageModel | undefined;
}): FlowRunner {
  const ask = async (prompt: string, o: NodeOpts, system = NODE_SYSTEM): Promise<string> => {
    // opts.models is the shared array setup.ts mutates IN PLACE on a /model
    // swap, so read [0] per call — the flow's default keeps following the app's
    // current model. A node with data.model is pinned and ignores the swap on
    // purpose: "the cheap one classifies, the strong one reviews" is the point.
    // A pinned node also skips config.fallbackModel — no rate-limit hop, which
    // is right when the whole reason to pin was "use exactly this one".
    const model = o.model && opts.modelFor ? opts.modelFor(o.model) : opts.models[0];
    if (!model)
      throw new Error(
        o.model ? `unknown model "${o.model}"` : "no model configured — add your API key in Settings",
      );
    const { text } = await generateText({ model, system, prompt, abortSignal: o.signal, maxRetries: 1 });
    return text.trim();
  };

  return (flow, emit, ctl) =>
    runFlow(
      flow,
      {
        runPrompt: (prompt, input, o) =>
          // Prompt nodes have no `recall` tool, so when memory is toggled on we
          // fold the saved memories straight into the system prompt (loaded fresh
          // per node so an earlier step's `remember` is visible to a later one).
          ask(fill(prompt, input, o.state), o, o.useMemory ? NODE_SYSTEM + memoryBlock() : NODE_SYSTEM),
        runIf: async (question, input, o) => {
          const a = await ask(
            fill(`${question}\n\nAnswer with exactly "yes" or "no" and nothing else.`, input, o.state),
            o,
          );
          return /^\W*yes/i.test(a);
        },
        runSwitch: async (cases, input, o) => {
          const list = cases.length ? cases : ["else"];
          const a = await ask(
            fill(
              `Classify the input into exactly one of these categories: ${list.join(", ")}. ` +
                `Reply with only the category name, exactly as written. If none fit, reply "else".`,
              input,
              o.state,
            ),
            o,
          );
          // Take the model's answer if it names a real case; otherwise "else".
          const clean = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          return list.find((c) => clean.includes(c.toLowerCase())) ?? "else";
        },
        runTool: async (name, args, input, o) => {
          const t = opts.tools[name] as Tool & { execute?: (a: unknown, o: unknown) => Promise<unknown> };
          if (!t?.execute) throw new Error(`no such tool: ${name}`);
          const filled = Object.fromEntries(
            Object.entries(args)
              .filter(([k]) => k)
              .map(([k, v]) => [k, coerce(expandHome(subst(String(v), input, o.state)))]),
          );
          // Run the args through the tool's own schema — that's what applies
          // defaults (skipping it is why web_search once fired with type
          // undefined) and what turns a bad argument into a readable error.
          const parsed = (t.inputSchema as any)?.safeParse?.(filled);
          if (parsed && !parsed.success)
            throw new Error(`bad arguments for ${name}: ${parsed.error.issues.map((i: any) => `${i.path.join(".") || "?"} ${i.message}`).join("; ")}`);
          return cap(String(await t.execute(parsed ? parsed.data : filled, {} as any)));
        },
      },
      emit,
      ctl,
    );
}

export function runFlowTool(runner: FlowRunner, report: (line: string) => void): Tool {
  return tool({
    description:
      "Run a saved workflow (built on the Flows page) by name and return its final output. Call this when the user asks to run one of their flows.",
    inputSchema: z.object({ name: z.string().describe("the flow's name, as shown on the Flows page") }),
    execute: async ({ name }) => {
      const flows = loadFlows();
      const flow =
        flows.find((f) => f.name.toLowerCase() === name.toLowerCase()) ??
        flows.find((f) => f.name.toLowerCase().includes(name.toLowerCase())) ??
        flows.find((f) => f.id === name);
      if (!flow) return `no flow named "${name}". Saved flows: ${flows.map((f) => f.name).join(", ") || "(none)"}`;
      report(`↳ flow ▸ ${flow.name}`);
      return cap(
        await runner(flow, (e) => {
          if (e.type === "node-start") report(`↳ flow ▸ ${e.kind}: ${e.label.slice(0, 60)}`);
          else if (e.type === "node-error") report(`↳ flow ▸ error: ${e.message}`);
        }),
      );
    },
  });
}
