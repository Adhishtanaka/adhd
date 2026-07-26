import os from "node:os";
import type { Tool } from "ai";
import type { LanguageModel } from "ai";
import {
  loadConfig,
  resolveModels,
  setUserModel,
  splitSpec,
  probeContext,
  tableContext,
  autoBudget,
  CHARS_PER_TOKEN,
  PROVIDER_KEY,
  type Config,
} from "./config.js";
import { builtinTools, loadUserTools } from "./tools.js";
import { loadMcpTools } from "./mcp.js";
import { loadSkills, skillsPromptSection, useSkillTool } from "./skills.js";
import { loadMemories, memoryPromptSection, memoryTools } from "./memory.js";
import { scheduleTools } from "./scheduler.js";
import { spawnAgentTool, reportSubagent } from "./subagent.js";
import { flowRunner, runFlowTool, toolArgSpecs, type FlowRunner, type ArgSpec } from "./flows.js";
import { loopTaskTool } from "./loop.js";
import { renderUiTool, catalogPromptSection } from "./render.js";
import { createAgent, type Agent } from "./agent.js";

export const BASE_SYSTEM =
  "You are adhd, a helpful assistant for everyday work — not a coding agent. Help with whatever " +
  "the person is doing: planning, writing, research, organizing files, reminders, quick lookups, and more. " +
  "You can read and write files, run shell/PowerShell commands, find files, search the web, and fetch " +
  "URLs through your tools. Use them when the task calls for it; " +
  "answer directly otherwise. If a URL or command fails, try an alternative (e.g. a different " +
  "API) rather than assuming you have no access. " +
  "Web research discipline: use web_search MINIMALLY. Default to a SINGLE web_search call — read the " +
  "snippets it returns, and only web_fetch a page (at most one, always with a `query`) when the snippets " +
  "don't already answer it. A second search is a last resort, not a habit. Do NOT keep re-searching, do NOT fetch many pages, and " +
  "NEVER web_fetch a search-engine results URL (that's what web_search is for). Then STOP and answer. " +
  "Always finish a turn by telling the user, in plain language, what you found — never end on a bare " +
  "sequence of tool calls with no answer. " +
  "Shell/diagnostic discipline: be economical here too. When inspecting the system (disk usage, processes, " +
  "config, files), plan ONE combined command that gets what you need — chain with '&&' or a single pipeline " +
  "rather than firing many small commands (each one also interrupts the user for approval). A couple of " +
  "commands is plenty; do NOT keep drilling deeper level by level. As soon as you can see what dominates, " +
  "STOP and give a short plain-language answer: name the top few space users with their sizes and one clear " +
  "takeaway — do not dump the raw output of every command you ran. " +
  "Never run commands with sudo or any command that prompts for a password — you cannot type one, so it just " +
  "hangs the terminal. Skip privileged/permission-denied paths and note you skipped them instead. " +
  "Knowledge priority: before assuming, use a relevant skill (use_skill) first, then check your " +
  "memory (recall), then use tools or run a quick script to find out — only guess as a last resort. " +
  "When the user states a durable personal fact about themselves — where they live, their name, " +
  "their tools/stack, a stable preference — or explicitly asks you to remember something, save it " +
  "immediately with remember (e.g. id 'user/location', type 'user'). Skip one-off conversation " +
  "trivia and anything derivable from the code. " +
  "For a large, self-contained subtask, delegate it with spawn_agent; otherwise do it inline. " +
  "For a complex task that genuinely needs several passes of building on prior work, use loop_task " +
  "(it asks the user to approve a max iteration count first); don't use it for ordinary one-shot tasks. " +
  "Be concise. Never use emojis in your responses, ever.";

// ponytail: startup snapshot of the environment, not live
function envSection(): string {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "unknown";
    }
  })();
  return (
    `\n\nEnvironment: ${os.type()} ${os.release()} (${os.arch()}), user ${user}, ` +
    `host ${os.hostname()}, shell ${process.env.SHELL ?? "unknown"}, ` +
    `cwd ${process.cwd()}, datetime ${new Date().toLocaleString()}.`
  );
}

export type Built = {
  agent: Agent;
  config: Config;
  toolNames: string[];
  skillNames: string[];
  memoryIds: string[];
  runFlow: FlowRunner; // execute a saved flow (Flows page / scheduler)
  toolArgs: Record<string, ArgSpec[]>; // per-tool argument fields, for the Flows canvas
  hasKey: () => boolean; // key for the CURRENT model's provider present?
  setModel: (id: string) => void; // switch + persist (keeps history)
  refreshModels: () => void; // re-resolve after a key was added
};

// Size the history budget from the model's real context window, then ask the
// provider for the true number and re-size if it differs. Synchronous first so
// startup never waits on a network call; the probe is fire-and-forget and a
// failure silently keeps the table value.
function applyContext(agent: Agent, config: Config): void {
  const spec = config.model;
  const set = (tokens: number) =>
    agent.setContext(
      config.historyBudget ?? autoBudget(tokens), // an explicit budget always wins
      tokens * CHARS_PER_TOKEN,
      spec,
    );
  set(tableContext(spec));
  void probeContext(spec, config).then((tokens) => {
    if (config.model === spec) set(tokens); // ignore a probe that lost a race with /model
  });
}

// Assemble the agent + tools + system prompt from config/skills/memory. Shared
// by every frontend. The `models` array is a single shared reference — mutating
// it in place (setModel/refreshModels) propagates to the agent AND to subagents,
// which read it at spawn time. Works with no API key yet (models stays empty);
// the caller gates chat on hasKey() and calls refreshModels() once a key is set.
export async function buildAgent(): Promise<Built> {
  const config = loadConfig();
  const skills = loadSkills();
  const memories = loadMemories();

  const baseTools: Record<string, Tool> = {
    ...builtinTools(),
    use_skill: useSkillTool(skills),
    ...memoryTools(),
    ...scheduleTools(),
    ...(await loadUserTools()),
    ...(await loadMcpTools()),
  };
  const system =
    (config.systemPrompt || BASE_SYSTEM) +
    catalogPromptSection() +
    envSection() +
    skillsPromptSection(skills) +
    memoryPromptSection(memories);

  // Subagents run autonomously — no ask_user. baseTools already omits
  // spawn_agent/loop_task, so depth-1 is preserved.
  const { ask_user, ...subagentTools } = baseTools;

  const models: LanguageModel[] = [];
  try {
    models.push(...resolveModels(config));
  } catch {
    /* no API key yet — models stays empty, chat gated on hasKey() */
  }

  // Tool nodes get subagentTools, so a flow can't call run_flow (depth 1).
  // Prompt nodes get no tools at all — see flows.ts.
  // modelFor resolves a node that pinned its own model; `models` (mutated in
  // place by swap) still supplies the default, so /model moves the whole flow.
  // ponytail: builds a provider client per call — it's one object; memoize if it
  // ever shows up in a profile.
  const runFlow = flowRunner({
    models,
    tools: subagentTools,
    modelFor: (id) => {
      try {
        return resolveModels({ ...config, model: id, fallbackModel: [] })[0];
      } catch {
        return undefined; // no key for that provider yet — ask() reports it
      }
    },
  });

  const tools: Record<string, Tool> = {
    ...baseTools,
    spawn_agent: spawnAgentTool({ models, tools: subagentTools, system, historyBudget: config.historyBudget }),
    loop_task: loopTaskTool({ models, tools: subagentTools, system, historyBudget: config.historyBudget }),
    run_flow: runFlowTool(runFlow, reportSubagent),
    render_ui: renderUiTool(), // main agent only — subagents return text, not UI
  };

  const agent = createAgent({ models, tools, system, historyBudget: config.historyBudget });

  const swap = (ids: string[]) => {
    models.length = 0;
    models.push(...resolveModels({ ...config, model: ids[0], fallbackModel: ids.slice(1) }));
    agent.setModels(models); // resets modelIdx; same shared reference
    applyContext(agent, config); // a 200k model and a 1M model get different budgets
  };

  applyContext(agent, config);

  return {
    agent,
    config,
    toolNames: Object.keys(tools),
    skillNames: Object.keys(skills),
    memoryIds: memories.map((m) => m.id),
    runFlow,
    toolArgs: toolArgSpecs(subagentTools),
    hasKey: () => !!process.env[PROVIDER_KEY[splitSpec(config.model)[0]]],
    setModel: (id) => {
      config.model = id; // before swap: applyContext reads config.model
      swap([id]);
      setUserModel(id);
    },
    refreshModels: () => swap([config.model]),
  };
}
