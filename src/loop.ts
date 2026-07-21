import { tool, type Tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { confirmAction, cap } from "./tools.js";
import { reportSubagent, summarize, SUMMARY_DIRECTIVE } from "./subagent.js";

const LOOP_CAP = 15; // hard ceiling regardless of what the model asks for

// The loop's "spec" is a TODO checklist kept as a plain JS array in RAM for the
// duration of one loop_task call — NOT the durable ~/.adhd/memory store. The
// subagent builds and checks it off via spec_set / spec_check; the loop finishes
// when every item is verified.
export type SpecItem = { title: string; verify: string; done: boolean; note?: string };

function renderSpec(spec: SpecItem[]): string {
  return spec.map((s, i) => `${i + 1}. [${s.done ? "x" : " "}] ${s.title}${s.note ? ` — ${s.note}` : ""}`).join("\n");
}

// Two tools bound to one spec array (closure). Exported so a unit test can drive
// the RAM state without a model.
export function specTools(spec: SpecItem[], report: (line: string) => void): Record<string, Tool> {
  return {
    spec_set: tool({
      description:
        "Define the task checklist ONCE, on your first pass, before doing any work: the outcomes/use-cases the task must satisfy, each with how you'll verify it's done. Replaces any existing checklist.",
      inputSchema: z.object({
        items: z
          .array(z.object({ title: z.string(), verify: z.string() }))
          .min(1)
          .describe("checklist items; each needs a title and how to verify it"),
      }),
      execute: async ({ items }) => {
        spec.length = 0;
        for (const it of items) spec.push({ title: it.title, verify: it.verify, done: false });
        report(`↳ loop ▸ spec: ${spec.length} items`);
        return `spec set (${spec.length} items):\n${renderSpec(spec)}`;
      },
    }),
    spec_check: tool({
      description:
        "Mark a checklist item verified/done, by its 1-based index, once you've actually confirmed it passes. Only when all items are checked does the loop finish.",
      inputSchema: z.object({
        index: z.number().int().min(1).describe("1-based item number from the spec"),
        note: z.string().optional().describe("short note on how it was verified"),
      }),
      execute: async ({ index, note }) => {
        const it = spec[index - 1];
        if (!it) return `no item at index ${index} (spec has ${spec.length})`;
        it.done = true;
        if (note) it.note = note;
        const done = spec.filter((s) => s.done).length;
        report(`↳ loop ▸ spec: ${done}/${spec.length} verified`);
        return `checked ${index}. ${done}/${spec.length} verified.\n${renderSpec(spec)}`;
      },
    }),
  };
}

// "Ralph" as a tool: the agent calls it for a complex task that needs several
// passes. It ASKS the user to approve a max-iteration count, then drives ONE
// subagent across up to that many passes. `tools` MUST exclude spawn_agent and
// loop_task so a loop can't spawn another loop (depth 1). The main agent stays
// blocked on this awaited tool for the whole run — see subagent.ts.
export function loopTaskTool(opts: {
  models: LanguageModel[];
  tools: Record<string, Tool>;
  system: string;
  historyBudget?: number;
}): Tool {
  return tool({
    description:
      "Run a complex, iterative task across multiple passes. Use only when a task genuinely needs several rounds of building on prior work (not a normal one-shot task). The user approves the iteration count first. The subagent writes a checklist (spec_set) then works and verifies items (spec_check); the loop finishes when all are verified.",
    inputSchema: z.object({
      task: z.string().describe("the task to iterate on"),
      maxIterations: z.number().int().min(1).describe("how many passes at most (capped at 15)"),
    }),
    execute: async ({ task, maxIterations }) => {
      const max = Math.min(LOOP_CAP, Math.max(1, maxIterations));
      const ok = await confirmAction(`loop_task — run up to ${max} passes on: ${task.slice(0, 80)}`);
      if (!ok) return "user declined the loop";

      const spec: SpecItem[] = [];
      const sub = createAgent({
        models: opts.models,
        tools: { ...opts.tools, ...specTools(spec, reportSubagent) },
        system:
          opts.system +
          "\n\nYou are running in an iteration loop with a checklist held for you. On your FIRST pass, " +
          "call spec_set to define the checklist (the outcomes/use-cases the task must satisfy, each with " +
          "how to verify it) — do not start the work yet. On later passes, do the next unverified item(s), " +
          "then call spec_check once you've confirmed each passes. The loop ends automatically when every " +
          "item is verified, so keep going until then." +
          SUMMARY_DIRECTIVE,
        historyBudget: opts.historyBudget,
      });

      let last = "";
      for (let i = 1; i <= max; i++) {
        const prompt =
          i === 1
            ? `Task: ${task}\n\nFirst call spec_set to define the checklist (outcomes + how to verify each). Do not start the work yet.`
            : spec.length === 0
              ? `You haven't defined the checklist yet — call spec_set now with the outcomes and how to verify each.`
              : `Continue (pass ${i}/${max}). Do the next unverified item, verify it, and call spec_check. Current checklist:\n${renderSpec(spec)}`;
        let text = "";
        await sub.send(prompt, (e) => {
          if (e.type === "text") text += e.delta;
          else if (e.type === "tool-call") reportSubagent(`↳ loop ▸ ⚙ ${e.name} ${summarize(e.args)}`);
          else if (e.type === "error") reportSubagent(`↳ loop ▸ error: ${e.message}`);
        });
        last = cap(text.trim());
        if (spec.length > 0 && spec.every((s) => s.done)) {
          reportSubagent(`↳ loop ▸ complete: ${spec.length}/${spec.length} verified`);
          return `completed in ${i}/${max} passes.\n\nChecklist:\n${renderSpec(spec)}\n\n${last}`;
        }
      }
      const done = spec.filter((s) => s.done).length;
      return `hit the ${max}-pass cap (${done}/${spec.length} verified).\n\nChecklist:\n${renderSpec(spec)}\n\n${last}`;
    },
  });
}
