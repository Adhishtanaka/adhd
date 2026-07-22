import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateText, tool, type Tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { HOME_ROOT } from "./config.js";
import { cap } from "./tools.js";

// A flow is a saved graph the user drew on the canvas. Nodes/edges are stored in
// React Flow's OWN shape so the page round-trips them with no mapping code —
// position and any extra canvas fields ride along untouched.
export const FLOWS_FILE = join(HOME_ROOT, "flows.json");

export type NodeKind = "start" | "prompt" | "if" | "tool" | "end";
export type FlowNode = {
  id: string;
  type: NodeKind;
  position?: { x: number; y: number };
  data: { prompt?: string; question?: string; tool?: string; args?: Record<string, string> };
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

/** First run only — never overwrites a file the user already has. */
export function seedExamples(): void {
  if (!existsSync(FLOWS_FILE)) saveFlows(EXAMPLE_FLOWS);
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
  | { type: "node-start"; id: string; kind: NodeKind; label: string }
  | { type: "node-done"; id: string; ms: number; output: string; branch?: "yes" | "no" }
  | { type: "node-error"; id: string; ms: number; message: string }
  | { type: "run-done"; output: string }
  | { type: "run-stopped" };

export type FlowExec = {
  runPrompt: (prompt: string, input: string, signal: AbortSignal) => Promise<string>;
  runIf: (question: string, input: string, signal: AbortSignal) => Promise<boolean>;
  runTool: (name: string, args: Record<string, string>, input: string) => Promise<string>;
};

/** {{prev}} anywhere → the previous node's output; otherwise append it. */
export function fill(text: string, input: string): string {
  if (text.includes("{{prev}}")) return text.replaceAll("{{prev}}", input);
  return input ? `${text}\n\nInput:\n${input}` : text;
}

/** Canvas fields are text; tool schemas want real types. "5" → 5, "true" → true. */
export function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
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
  return (n.type === "if" ? n.data.question : n.data.prompt) || "(empty)";
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
    let branch: "yes" | "no" | undefined;
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
          out = await ex.runPrompt(node.data.prompt ?? "", out, ctl.signal);
          break;
        case "if":
          branch = (await ex.runIf(node.data.question ?? "", out, ctl.signal)) ? "yes" : "no";
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

    const next = flow.edges.find(
      (e) => e.source === node!.id && (branch === undefined || (e.sourceHandle ?? "yes") === branch),
    );
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
  const ask = async (prompt: string, signal: AbortSignal): Promise<string> => {
    const model = opts.models[0];
    if (!model) throw new Error("no model configured — add your API key in Settings");
    const { text } = await generateText({ model, system: NODE_SYSTEM, prompt, abortSignal: signal, maxRetries: 1 });
    return text.trim();
  };

  return (flow, emit, ctl) =>
    runFlow(
      flow,
      {
        runPrompt: (prompt, input, signal) => ask(fill(prompt, input), signal),
        runIf: async (question, input, signal) => {
          const a = await ask(fill(`${question}\n\nAnswer with exactly "yes" or "no" and nothing else.`, input), signal);
          return /^\W*yes/i.test(a);
        },
        runTool: async (name, args, input) => {
          const t = opts.tools[name] as Tool & { execute?: (a: unknown, o: unknown) => Promise<unknown> };
          if (!t?.execute) throw new Error(`no such tool: ${name}`);
          const filled = Object.fromEntries(
            Object.entries(args)
              .filter(([k]) => k)
              .map(([k, v]) => [k, coerce(fill(String(v), input))]),
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
