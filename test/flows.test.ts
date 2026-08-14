import { test, expect } from "bun:test";
import { homedir } from "node:os";
import {
  runFlow,
  fill,
  subst,
  expandHome,
  coerce,
  toolArgSpecs,
  RunControl,
  flowRunner,
  type Flow,
  type FlowExec,
  type FlowEvent,
} from "../src/flows.js";
import { builtinTools, confirmAction, setBashConfirm } from "../src/tools.js";
import { tool } from "ai";
import { z } from "zod";

// Executors are stubbed — traversal is what's under test, no model involved.
function stub(over: Partial<FlowExec> = {}): FlowExec & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    runPrompt: async (p, input) => {
      seen.push(`prompt:${p}`);
      return input ? `${input}>${p}` : p;
    },
    runIf: async (q) => {
      seen.push(`if:${q}`);
      return true;
    },
    runSwitch: async (cases) => {
      seen.push(`switch:${cases.join(",")}`);
      return cases[0] ?? "else";
    },
    runTool: async (name, args, input) => {
      seen.push(`tool:${name}:${JSON.stringify(args)}:${input}`);
      return `ran ${name}`;
    },
    ...over,
  };
}

const node = (id: string, type: any, data: any = {}) => ({ id, type, data });
const edge = (source: string, target: string, sourceHandle?: string) => ({ source, target, sourceHandle });

test("runs a linear chain in order, threading output forward", async () => {
  const flow: Flow = {
    id: "f",
    name: "linear",
    nodes: [node("a", "prompt", { prompt: "A" }), node("b", "prompt", { prompt: "B" }), node("c", "prompt", { prompt: "C" })],
    edges: [edge("a", "b"), edge("b", "c")],
  };
  const ex = stub();
  expect(await runFlow(flow, ex)).toBe("A>B>C");
  expect(ex.seen).toEqual(["prompt:A", "prompt:B", "prompt:C"]);
});

test("if node takes the yes edge, then the no edge", async () => {
  const flow: Flow = {
    id: "f",
    name: "branch",
    nodes: [node("q", "if", { question: "rain?" }), node("y", "prompt", { prompt: "YES" }), node("n", "prompt", { prompt: "NO" })],
    edges: [edge("q", "y", "yes"), edge("q", "n", "no")],
  };
  expect(await runFlow(flow, stub())).toBe("YES");
  expect(await runFlow(flow, stub({ runIf: async () => false }))).toBe("NO");
});

test("switch node follows the chosen case, and falls back to else", async () => {
  const flow: Flow = {
    id: "f",
    name: "switch",
    nodes: [
      node("sw", "switch", { cases: ["billing", "technical"] }),
      node("b", "prompt", { prompt: "BILLING" }),
      node("t", "prompt", { prompt: "TECH" }),
      node("o", "prompt", { prompt: "OTHER" }),
    ],
    edges: [edge("sw", "b", "billing"), edge("sw", "t", "technical"), edge("sw", "o", "else")],
  };
  expect(await runFlow(flow, stub({ runSwitch: async () => "technical" }))).toBe("TECH");
  expect(await runFlow(flow, stub({ runSwitch: async () => "billing" }))).toBe("BILLING");
  // a case with no matching edge routes to else
  expect(await runFlow(flow, stub({ runSwitch: async () => "nonsense" }))).toBe("OTHER");
});

test("tool node gets its args and the previous output", async () => {
  const flow: Flow = {
    id: "f",
    name: "tool",
    nodes: [node("p", "prompt", { prompt: "hello" }), node("t", "tool", { tool: "write_file", args: { path: "/tmp/x" } })],
    edges: [edge("p", "t")],
  };
  const ex = stub();
  expect(await runFlow(flow, ex)).toBe("ran write_file");
  expect(ex.seen[1]).toBe('tool:write_file:{"path":"/tmp/x"}:hello');
});

test("{{prev}} substitutes, otherwise input is appended (prompt/if text)", () => {
  expect(fill("summarize {{prev}} now", "DATA")).toBe("summarize DATA now");
  expect(fill("summarize", "DATA")).toBe("summarize\n\nInput:\nDATA");
  expect(fill("summarize", "")).toBe("summarize");
});

test("subst only swaps the placeholder — a tool arg never grows silently (ENAMETOOLONG fix)", () => {
  expect(subst("hi.txt", "a very long previous output")).toBe("hi.txt");
  expect(subst("{{prev}}", "content here")).toBe("content here");
});

test("a leading ~/ in a tool arg expands to the home dir", () => {
  expect(expandHome("~/notes.md")).toBe(`${homedir()}/notes.md`);
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("/abs/path")).toBe("/abs/path");
  expect(expandHome("relative")).toBe("relative");
});

test("emits one event per node, with durations and the branch taken", async () => {
  const flow: Flow = {
    id: "f",
    name: "events",
    nodes: [node("q", "if", { question: "ok?" }), node("y", "prompt", { prompt: "YES" })],
    edges: [edge("q", "y", "yes")],
  };
  const events: FlowEvent[] = [];
  await runFlow(flow, stub(), (e) => events.push(e));
  expect(events.map((e) => e.type)).toEqual(["node-start", "node-done", "node-start", "node-done", "run-done"]);
  expect((events[1] as any).branch).toBe("yes");
  expect((events[3] as any).output).toBe("YES");
});

test("a failing node ends the run with an error event", async () => {
  const flow: Flow = {
    id: "f",
    name: "boom",
    nodes: [node("a", "tool", { tool: "nope" }), node("b", "prompt", { prompt: "never" })],
    edges: [edge("a", "b")],
  };
  const events: FlowEvent[] = [];
  const out = await runFlow(
    flow,
    stub({ runTool: async () => { throw new Error("no such tool: nope"); } }),
    (e) => events.push(e),
  );
  expect(out).toContain("no such tool");
  expect(events.some((e) => e.type === "node-error")).toBe(true);
  expect(events.some((e) => e.type === "node-start" && e.id === "b")).toBe(false);
});

test("stop halts the run at the next node boundary", async () => {
  const flow: Flow = {
    id: "f",
    name: "stoppable",
    nodes: [node("a", "prompt", { prompt: "A" }), node("b", "prompt", { prompt: "B" })],
    edges: [edge("a", "b")],
  };
  const ctl = new RunControl();
  const events: FlowEvent[] = [];
  const ex = stub({
    runPrompt: async (p) => {
      ctl.stop(); // stopped while the first node is in flight
      return p;
    },
  });
  await runFlow(flow, ex, (e) => events.push(e), ctl);
  expect(events.at(-1)!.type).toBe("run-stopped");
  expect(events.filter((e) => e.type === "node-start").length).toBe(1);
});

test("pause blocks, resume continues", async () => {
  const flow: Flow = {
    id: "f",
    name: "pausable",
    nodes: [node("a", "prompt", { prompt: "A" }), node("b", "prompt", { prompt: "B" })],
    edges: [edge("a", "b")],
  };
  const ctl = new RunControl();
  ctl.pause();
  const started: string[] = [];
  const done = runFlow(flow, stub(), (e) => e.type === "node-start" && started.push(e.id), ctl);
  await new Promise((r) => setTimeout(r, 60));
  expect(started).toEqual([]); // gated before the first node
  expect(ctl.state).toBe("paused");
  ctl.resume();
  expect(await done).toBe("A>B");
  expect(started).toEqual(["a", "b"]);
});

test("start begins the run and end terminates it", async () => {
  const flow: Flow = {
    id: "f",
    name: "bookends",
    nodes: [
      node("e", "end"),
      node("p", "prompt", { prompt: "WORK" }),
      node("s", "start"),
      node("after", "prompt", { prompt: "UNREACHABLE" }),
    ],
    edges: [edge("s", "p"), edge("p", "e"), edge("e", "after")],
  };
  const ex = stub();
  expect(await runFlow(flow, ex)).toBe("WORK"); // start is entry despite being 3rd
  expect(ex.seen).toEqual(["prompt:WORK"]); // end stops the walk
});

test("a prompt node's useMemory flag reaches the executor", async () => {
  const flow: Flow = {
    id: "f",
    name: "mem",
    nodes: [node("a", "prompt", { prompt: "A", useMemory: true }), node("b", "prompt", { prompt: "B" })],
    edges: [edge("a", "b")],
  };
  const flags: boolean[] = [];
  await runFlow(flow, stub({ runPrompt: async (p, _i, o) => (flags.push(!!o.useMemory), p) }));
  expect(flags).toEqual([true, false]); // on for A, off (default) for B
});

test("canvas text is coerced to the types tool schemas expect", () => {
  expect(coerce("5")).toBe(5);
  expect(coerce("true")).toBe(true);
  expect(coerce("hello")).toBe("hello");
  expect(coerce("")).toBe("");
});

test("tool arg specs are read off the real tool schemas", () => {
  const specs = toolArgSpecs(builtinTools());
  const search = specs.web_search;
  expect(search.find((a) => a.key === "q")!.required).toBe(true);
  const type = search.find((a) => a.key === "type")!;
  expect(type.required).toBe(false);
  expect(type.options).toContain("news"); // enum → dropdown in the inspector
});

test("a cycle stops at the step cap instead of hanging", async () => {
  const flow: Flow = {
    id: "f",
    name: "cycle",
    nodes: [node("a", "prompt", { prompt: "A" }), node("b", "prompt", { prompt: "B" })],
    edges: [edge("a", "b"), edge("b", "a")],
  };
  const ex = stub();
  expect(await runFlow(flow, ex)).toContain("step cap");
  expect(ex.seen.length).toBe(30);
});

test("fan-out runs every branch; a merge waits for all, then joins labeled sections", async () => {
  const flow: Flow = {
    id: "f",
    name: "merge",
    nodes: [
      node("s", "start"),
      node("a", "tool", { tool: "browser" }),
      node("b", "tool", { tool: "browser" }),
      node("m", "merge"),
      node("p", "prompt", { prompt: "report" }),
    ],
    edges: [edge("s", "a"), edge("s", "b"), edge("a", "m"), edge("b", "m"), edge("m", "p")],
  };
  const ex = stub();
  const out = await runFlow(flow, ex);
  expect(ex.seen.filter((x) => x.startsWith("tool:browser")).length).toBe(2); // both ran
  expect(out).toContain("## 1 · browser"); // merged into two labeled sections…
  expect(out).toContain("## 2 · browser");
  expect(out).toContain(">report"); // …and the prompt saw that merged input
});

test("a merge behind a pruned if branch still fires with the inputs it got", async () => {
  const flow: Flow = {
    id: "f",
    name: "partial-merge",
    nodes: [
      node("q", "if", { question: "?" }),
      node("y", "prompt", { prompt: "Y" }),
      node("n", "prompt", { prompt: "N" }),
      node("m", "merge"),
    ],
    edges: [edge("q", "y", "yes"), edge("q", "n", "no"), edge("y", "m"), edge("n", "m")],
  };
  const ex = stub(); // runIf → true, so only y feeds the merge; n is pruned
  const out = await runFlow(flow, ex);
  expect(out).toContain("## 1 · Y");
  expect(ex.seen).not.toContain("prompt:N");
});

test("entry is the node nothing points at, whatever the array order", async () => {
  const flow: Flow = {
    id: "f",
    name: "order",
    nodes: [node("second", "prompt", { prompt: "B" }), node("first", "prompt", { prompt: "A" })],
    edges: [edge("first", "second")],
  };
  expect(await runFlow(flow, stub())).toBe("A>B");
});

// --- shared state ({{key}}) -------------------------------------------------
// runFlow hands the executor the RAW template plus the state; it's flowRunner's
// executors that call fill(). These stubs do the same so the two halves are
// tested together.
const filling = (seen: string[]): Partial<FlowExec> => ({
  runPrompt: async (p, input, o) => {
    const text = fill(p, input, o.state);
    seen.push(`prompt:${text}`);
    return text;
  },
});

test("{{key}} reads a non-adjacent node's output", async () => {
  const flow: Flow = {
    id: "f",
    name: "state",
    nodes: [
      node("a", "prompt", { prompt: "FACT", key: "research" }),
      node("b", "prompt", { prompt: "MIDDLE" }),
      node("c", "prompt", { prompt: "cite {{research}}" }),
    ],
    edges: [edge("a", "b"), edge("b", "c")],
  };
  const seen: string[] = [];
  await runFlow(flow, stub(filling(seen)));
  // c sees node a's output even though b ran in between and clobbered the edge.
  expect(seen).toContain("prompt:cite FACT");
});

test("a node with no key is addressable by its id", async () => {
  const flow: Flow = {
    id: "f",
    name: "default-key",
    nodes: [node("a", "prompt", { prompt: "X" }), node("b", "prompt", { prompt: "got {{a}}" })],
    edges: [edge("a", "b")],
  };
  const seen: string[] = [];
  await runFlow(flow, stub(filling(seen)));
  expect(seen).toContain("prompt:got X");
});

test("an unknown placeholder is left literal, and still counts as no-substitution", () => {
  expect(subst("{{nope}}", "x", { a: "1" })).toBe("{{nope}}");
  // Nothing resolved, so the input is appended rather than silently dropped.
  expect(fill("write {{nope}}", "DATA")).toBe("write {{nope}}\n\nInput:\nDATA");
  // A key that DOES resolve suppresses the append.
  expect(fill("write {{a}}", "DATA", { a: "1" })).toBe("write 1");
});

test("a tool arg resolves {{key}} without growing (the ENAMETOOLONG guard)", () => {
  expect(subst("hi.txt", "a very long previous output", { k: "v" })).toBe("hi.txt");
  expect(subst("{{k}}.txt", "long", { k: "notes" })).toBe("notes.txt");
});

test("model output containing $& survives substitution", () => {
  // A string replacement would expand $& to the matched text; the function
  // replacer must not.
  expect(subst("{{prev}}", "cost $& up 10%")).toBe("cost $& up 10%");
});

test("same key written twice in one batch resolves to the later node in queue order", async () => {
  const flow: Flow = {
    id: "f",
    name: "collision",
    nodes: [
      node("s", "start"),
      node("a", "prompt", { prompt: "FIRST", key: "shared" }),
      node("b", "prompt", { prompt: "SECOND", key: "shared" }),
      node("m", "merge"),
      node("z", "prompt", { prompt: "saw {{shared}}" }),
    ],
    edges: [edge("s", "a"), edge("s", "b"), edge("a", "m"), edge("b", "m"), edge("m", "z")],
  };
  const seen: string[] = [];
  await runFlow(flow, stub(filling(seen)));
  expect(seen).toContain("prompt:saw SECOND");
});

// --- parallel supersteps ----------------------------------------------------

test("fan-out branches run concurrently, not one after another", async () => {
  // Both executors block until BOTH have entered. Under the old sequential
  // loop the first one waits forever and this test times out.
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  const flow: Flow = {
    id: "f",
    name: "parallel",
    nodes: [
      node("s", "start"),
      node("a", "prompt", { prompt: "A" }),
      node("b", "prompt", { prompt: "B" }),
      node("m", "merge"),
    ],
    edges: [edge("s", "a"), edge("s", "b"), edge("a", "m"), edge("b", "m")],
  };
  const ex = stub({
    runPrompt: async (p) => {
      if (++entered === 2) release();
      await both;
      return p;
    },
  });
  const out = await runFlow(flow, ex);
  expect(entered).toBe(2);
  expect(out).toContain("A");
  expect(out).toContain("B");
});

test("two failures in one batch: both reported, blame is the first in queue order", async () => {
  const flow: Flow = {
    id: "f",
    name: "double-fail",
    nodes: [node("s", "start"), node("a", "tool", { tool: "nope_a" }), node("b", "tool", { tool: "nope_b" })],
    edges: [edge("s", "a"), edge("s", "b")],
  };
  const events: FlowEvent[] = [];
  const ex = stub({
    runTool: async (name) => {
      throw new Error(`no such tool: ${name}`);
    },
  });
  const out = await runFlow(flow, ex, (e) => events.push(e));
  expect(events.filter((e) => e.type === "node-error").length).toBe(2);
  expect(events.filter((e) => e.type === "run-done").length).toBe(1);
  expect(out).toContain("a failed"); // 'a' is queued first, so 'a' is blamed
});

// --- per-node model ---------------------------------------------------------

test("data.model reaches the executor; unset stays undefined", async () => {
  const flow: Flow = {
    id: "f",
    name: "models",
    nodes: [
      node("a", "prompt", { prompt: "A", model: "anthropic:claude-sonnet-5" }),
      node("b", "prompt", { prompt: "B" }),
    ],
    edges: [edge("a", "b")],
  };
  const seenModels: (string | undefined)[] = [];
  await runFlow(flow, stub({ runPrompt: async (p, _i, o) => (seenModels.push(o.model), p) }));
  expect(seenModels).toEqual(["anthropic:claude-sonnet-5", undefined]);
});

// --- stored-flow hardening --------------------------------------------------

test("a node without a position gets one, so the canvas can't crash on it", async () => {
  const { normalize } = await import("../src/flows.js");
  // React Flow reads node.position.x directly: undefined here threw
  // "Cannot read properties of undefined (reading 'x')" and left the whole
  // Flows page blank — one API-created flow took down every other one.
  const flow: Flow = {
    id: "f",
    name: "no positions",
    nodes: [node("a", "prompt", { prompt: "A" }), node("b", "prompt", { prompt: "B" })],
    edges: [edge("a", "b")],
  };
  const out = normalize(flow);
  for (const n of out.nodes) {
    expect(typeof n.position?.x).toBe("number");
    expect(typeof n.position?.y).toBe("number");
  }
  // Two nodes must not land on top of each other.
  expect(out.nodes[0].position).not.toEqual(out.nodes[1].position!);
});

test("normalize leaves a hand-placed position alone and drops broken edges", async () => {
  const { normalize } = await import("../src/flows.js");
  const out = normalize({
    id: "f",
    name: "mixed",
    nodes: [
      { id: "a", type: "prompt", position: { x: 12, y: 34 }, data: {} },
      { id: "b", type: "prompt", data: {} } as any,
    ],
    edges: [edge("a", "b"), { source: "", target: "b" }, { source: "a", target: "" }],
  });
  expect(out.nodes[0].position).toEqual({ x: 12, y: 34 }); // untouched
  expect(typeof out.nodes[1].position?.x).toBe("number"); // filled in
  expect(out.edges).toHaveLength(1); // the two half-connected edges are gone
});

// The reported bug: a flow with a shell/script step stopped mid-run behind a
// permission card — including scheduled runs, where nobody is there to click it.
// Drawing the flow and hitting Run IS the approval.
test("a tool node runs without raising a permission card", async () => {
  let asked = 0;
  setBashConfirm(async () => {
    asked++;
    return false;
  });
  const flow: Flow = {
    id: "f",
    name: "f",
    nodes: [
      { id: "a", type: "start", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "tool", position: { x: 0, y: 1 }, data: { tool: "needs_ok", args: {} } },
    ],
    edges: [{ source: "a", target: "b" }],
  };
  const needs_ok = tool({
    description: "asks before doing anything",
    inputSchema: z.object({}),
    execute: async () => ((await confirmAction("dangerous")) ? "ran" : "denied"),
  });
  const out = await flowRunner({ models: [], tools: { needs_ok } })(flow);
  expect(out).toBe("ran");
  expect(asked).toBe(0);
});
