import { tool, type Tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createAgent } from "./agent.js";
import { cap, MUTATING_TOOLS } from "./tools.js";
import { MUTATING as BROWSER_MUTATING } from "./browser.js";
import { mcpCatalog, readOnlyMcpTools } from "./mcp.js";
import { currentAgentContext, runInAgentContext, logToolCall, logToolResult, type AgentLineage } from "./toollog.js";

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

// A tool full-name belongs to an MCP server if it shows up in some server's
// catalog — the catalog is filled at connect time regardless of whether that
// tool made it past the disabledTools filter into the live tool set.
function isMcpToolName(name: string): boolean {
  return Object.values(mcpCatalog()).some((infos) => infos.some((t) => t.full === name));
}

// Strip everything that writes to disk, runs code, or otherwise mutates state
// from a subagent's tool set — for a research/analysis subtask that must not
// touch anything. Foreign (MCP) tools can't be inspected for safety, so they're
// kept only when their whole SERVER is configured trust:"read"; adhd's own
// browser tool is kept but has its mutating actions (fill/click/type/press/eval)
// blocked at the action level instead of losing the tool entirely.
function readonlyTools(tools: Record<string, Tool>): Record<string, Tool> {
  const readOnlyMcp = readOnlyMcpTools();
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (MUTATING_TOOLS.has(name)) continue;
    if (name === "browser") {
      out[name] = {
        ...t,
        execute: async (args: any, execOpts: any) =>
          BROWSER_MUTATING.has(args?.action)
            ? "This subagent is read-only — browser actions that change the page (fill/click/type/press/eval) aren't permitted."
            : t.execute!(args, execOpts),
      } as Tool;
      continue;
    }
    if (isMcpToolName(name) && !readOnlyMcp.has(name)) continue;
    out[name] = t;
  }
  return out;
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
      "Delegate a complex, independent subtask to a subagent that runs to completion and returns its result. Use sparingly — only when the subtask is large and self-contained. Subagents cannot spawn further subagents. Set readonly:true for a research/analysis subtask that must not write files, run commands/scripts, install packages, or change a web page.",
    inputSchema: z.object({
      task: z.string().describe("the self-contained subtask to complete"),
      context: z.string().optional().describe("any context the subagent needs"),
      readonly: z.boolean().optional().describe("true for a read-only/research subtask — strips write/exec tools from what the subagent can call"),
    }),
    execute: async ({ task, context, readonly }) => {
      const subTools = readonly ? readonlyTools(opts.tools) : opts.tools;
      const sub = createAgent({
        models: opts.models,
        tools: subTools,
        system:
          opts.system +
          "\n\nYou are a subagent. Complete the task, then report back." +
          (readonly ? " You are READ-ONLY: you cannot write files, run commands/scripts, install packages, or change a web page — only read, search, and look things up." : "") +
          SUMMARY_DIRECTIVE,
        historyBudget: opts.historyBudget,
      });
      sink(`↳ subagent ▸ running: ${task.slice(0, 70)}`);
      let text = "";
      const prompt = context ? `${task}\n\nContext:\n${context}` : task;
      // Lineage: trace this subagent's tool calls back to the parent turn (or
      // parent subagent, if this is called from within one — depth is capped
      // at 1 today, but rootAgentId is filled in either way so a future
      // relaxation of that cap doesn't need another migration).
      const parent = currentAgentContext();
      const agentId = crypto.randomUUID().slice(0, 8);
      const lineage: AgentLineage | null = parent
        ? { session: parent.session, turn: parent.turn, agentId, parentAgentId: parent.agentId, rootAgentId: parent.rootAgentId ?? parent.agentId ?? agentId }
        : null;
      await runInAgentContext(lineage, () =>
        sub.send(prompt, (e) => {
          if (e.type === "text") text += e.delta;
          else if (e.type === "tool-call") {
            sink(`↳ subagent ▸ ⚙ ${e.name} ${summarize(e.args)}`);
            if (lineage) logToolCall(lineage.session, lineage.turn, e.id, e.name, e.args);
          } else if (e.type === "tool-result") {
            if (lineage) logToolResult(e.id, e.result);
          } else if (e.type === "error") sink(`↳ subagent ▸ error: ${e.message}`);
        }),
      );
      sink("↳ subagent ▸ done, returning result");
      return cap(text.trim()) || "(subagent produced no output)";
    },
  });
}
