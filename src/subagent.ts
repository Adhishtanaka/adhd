import { tool, type Tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { cap } from "./tools.js";

// ponytail: subagents/loops hand back the shortest high-signal result, no
// narration — the caller only needs the point, not the play-by-play.
export const SUMMARY_DIRECTIVE =
  " Report only what the caller needs: the result/answer first, then at most a few short lines of " +
  "essential detail. No narration, no play-by-play, no restating the task. Shortest high-signal answer wins.";

// The subagent forwards short progress lines to the UI. App registers the sink
// once (like the bash confirm), so nested activity shows while the main agent
// waits on the awaited tool call.
let sink: (line: string) => void = () => {};
export function setSubagentSink(fn: (line: string) => void) {
  sink = fn;
}
// Shared so loop_task reports subagent activity through the same UI sink.
export function reportSubagent(line: string) {
  sink(line);
}

export function summarize(args: unknown): string {
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    const v = o.q ?? o.command ?? o.path ?? o.pattern ?? o.url ?? o.task ?? o.id ?? o.query;
    if (v != null) return String(v).slice(0, 50);
  }
  return "";
}

// `tools` MUST already exclude spawn_agent — that omission is what enforces
// depth 1 (a subagent has no way to spawn another). The main agent awaits this
// tool, so it naturally blocks until the subagent returns its result.
export function spawnAgentTool(opts: {
  models: LanguageModel[];
  tools: Record<string, Tool>;
  system: string;
  historyBudget?: number;
}): Tool {
  return tool({
    description:
      "Delegate a complex, independent subtask to a subagent that runs to completion and returns its result. Use sparingly — only when the subtask is large and self-contained. Subagents cannot spawn further subagents.",
    inputSchema: z.object({
      task: z.string().describe("the self-contained subtask to complete"),
      context: z.string().optional().describe("any context the subagent needs"),
    }),
    execute: async ({ task, context }) => {
      const sub = createAgent({
        models: opts.models,
        tools: opts.tools,
        system: opts.system + "\n\nYou are a subagent. Complete the task, then report back." + SUMMARY_DIRECTIVE,
        historyBudget: opts.historyBudget,
      });
      sink(`↳ subagent ▸ running: ${task.slice(0, 70)}`);
      let text = "";
      const prompt = context ? `${task}\n\nContext:\n${context}` : task;
      await sub.send(prompt, (e) => {
        if (e.type === "text") text += e.delta;
        else if (e.type === "tool-call") sink(`↳ subagent ▸ ⚙ ${e.name} ${summarize(e.args)}`);
        else if (e.type === "error") sink(`↳ subagent ▸ error: ${e.message}`);
      });
      sink("↳ subagent ▸ done, returning result");
      return cap(text.trim()) || "(subagent produced no output)";
    },
  });
}
