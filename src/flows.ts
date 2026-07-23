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

export type NodeKind = "start" | "prompt" | "if" | "switch" | "tool" | "end";
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
const MAX_STEPS = 30; // cycle guard: a loop in the graph stops here

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
  /** Between-nodes checkpoint: blocks while paused, throws once stopped. */
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

export type FlowExec = {
  runPrompt: (prompt: string, input: string, signal: AbortSignal, useMemory: boolean) => Promise<string>;
  runIf: (question: string, input: string, signal: AbortSignal) => Promise<boolean>;
  // Returns the chosen case label — one of `cases`, or "else" if none fit.
  runSwitch: (cases: string[], input: string, signal: AbortSignal) => Promise<string>;
  runTool: (name: string, args: Record<string, string>, input: string) => Promise<string>;
};

/** Just the placeholder swap — used for tool args, which must NOT grow silently. */
export function subst(text: string, input: string): string {
  return text.replaceAll("{{prev}}", input);
}

/**
 * Prompt/if text: {{prev}} → the previous output, else the input is appended so
 * the step sees it. Tool ARGS use subst() instead — auto-appending there turned
 * a `path: "hi.txt"` into "hi.txt\n\nInput:\n…" and blew up with ENAMETOOLONG.
 */
export function fill(text: string, input: string): string {
  if (text.includes("{{prev}}")) return subst(text, input);
  return input ? `${text}\n\nInput:\n${input}` : text;
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
  return n.data.prompt || "(empty)";
};

/**
 * Walk the graph, one node at a time. Pure traversal — executors are injected,
 * so tests drive it without a model. Emits an event per node so the UI can show
 * what actually happened instead of a wall of tool names.
 */
export async function runFlow(
  flow: Flow,
  ex: FlowExec,
  emit: (e: FlowEvent) => void = () => {},
  ctl: RunControl = new RunControl(),
): Promise<string> {
  let node = entryNode(flow);
  if (!node) return "(empty flow)";
  let out = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    // The edge handle to leave by. undefined = a plain node with one way out;
    // set = a branch (if → "yes"/"no", switch → a case label).
    let branch: string | undefined;
    const started = Date.now();
    try {
      await ctl.gate();
      emit({ type: "node-start", id: node.id, kind: node.type, label: label(node) });
      switch (node.type) {
        case "start":
          break; // marks the entry; carries no work
        case "end":
          emit({ type: "node-done", id: node.id, ms: Date.now() - started, output: out });
          emit({ type: "run-done", output: out });
          return out;
        case "prompt":
          out = await ex.runPrompt(node.data.prompt ?? "", out, ctl.signal, !!node.data.useMemory);
          break;
        case "if":
          branch = (await ex.runIf(node.data.question ?? "", out, ctl.signal)) ? "yes" : "no";
          break;
        case "switch":
          branch = await ex.runSwitch(node.data.cases ?? [], out, ctl.signal);
          break;
        case "tool":
          out = await ex.runTool(node.data.tool ?? "", node.data.args ?? {}, out);
          break;
        default:
          throw new Error(`unknown node type "${(node as FlowNode).type}"`);
      }
      emit({ type: "node-done", id: node.id, ms: Date.now() - started, output: out, branch });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (message === CANCELLED || ctl.state === "stopped") {
        emit({ type: "run-stopped" });
        return out;
      }
      // One bad node ends the run — continuing would feed garbage downstream.
      emit({ type: "node-error", id: node.id, ms: Date.now() - started, message });
      emit({ type: "run-done", output: out });
      return `${node.id} failed: ${message}`;
    }

    const from = flow.edges.filter((e) => e.source === node!.id);
    // Plain node: first edge out. Branch node: the edge whose handle matches the
    // chosen label ("yes"/"no" or a case), falling back to an "else" edge.
    const next =
      branch === undefined
        ? from.find((e) => (e.sourceHandle ?? "yes") === "yes") ?? from[0]
        : from.find((e) => (e.sourceHandle ?? "yes") === branch) ?? from.find((e) => e.sourceHandle === "else");
    const target = next && flow.nodes.find((n) => n.id === next.target);
    if (!target) {
      emit({ type: "run-done", output: out });
      return out;
    }
    node = target;
  }
  const capped = `${out}\n\n(stopped at the ${MAX_STEPS}-step cap — check for a cycle)`;
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
export function flowRunner(opts: { models: LanguageModel[]; tools: Record<string, Tool> }): FlowRunner {
  const ask = async (prompt: string, signal: AbortSignal, system = NODE_SYSTEM): Promise<string> => {
    const model = opts.models[0];
    if (!model) throw new Error("no model configured — add your API key in Settings");
    const { text } = await generateText({ model, system, prompt, abortSignal: signal, maxRetries: 1 });
    return text.trim();
  };

  return (flow, emit, ctl) =>
    runFlow(
      flow,
      {
        runPrompt: (prompt, input, signal, useMemory) =>
          // Prompt nodes have no `recall` tool, so when memory is toggled on we
          // fold the saved memories straight into the system prompt (loaded fresh
          // per node so an earlier step's `remember` is visible to a later one).
          ask(fill(prompt, input), signal, useMemory ? NODE_SYSTEM + memoryBlock() : NODE_SYSTEM),
        runIf: async (question, input, signal) => {
          const a = await ask(fill(`${question}\n\nAnswer with exactly "yes" or "no" and nothing else.`, input), signal);
          return /^\W*yes/i.test(a);
        },
        runSwitch: async (cases, input, signal) => {
          const list = cases.length ? cases : ["else"];
          const a = await ask(
            fill(
              `Classify the input into exactly one of these categories: ${list.join(", ")}. ` +
                `Reply with only the category name, exactly as written. If none fit, reply "else".`,
              input,
            ),
            signal,
          );
          // Take the model's answer if it names a real case; otherwise "else".
          const clean = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          return list.find((c) => clean.includes(c.toLowerCase())) ?? "else";
        },
        runTool: async (name, args, input) => {
          const t = opts.tools[name] as Tool & { execute?: (a: unknown, o: unknown) => Promise<unknown> };
          if (!t?.execute) throw new Error(`no such tool: ${name}`);
          const filled = Object.fromEntries(
            Object.entries(args)
              .filter(([k]) => k)
              .map(([k, v]) => [k, coerce(expandHome(subst(String(v), input)))]),
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
