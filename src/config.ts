import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
// Type-only, so this doesn't create a runtime cycle with mcp.ts (which reads config).
import type { McpServer } from "./mcp.js";

export const HOME_ROOT = join(homedir(), ".adhd");
export const PROJECT_ROOT = join(process.cwd(), ".adhd");
export const ROOTS = [HOME_ROOT, PROJECT_ROOT]; // project overrides home

export type Config = {
  model: string; // "<provider>:<id>", or a bare id for DeepSeek (see splitSpec)
  fallbackModel?: string | string[]; // tried in order when a model is rate-limited; [] disables
  baseURL: string; // DeepSeek's OpenAI-compatible endpoint
  customBaseURL?: string; // the "custom:" provider's endpoint (OpenRouter, Ollama, LM Studio…)
  historyBudget?: number; // max chars of chat history per request; unset = auto-sized (autoBudget)
  systemPrompt?: string;
  localRoots?: string[]; // folders the local-file tools may read (default: home)
  allowedCommands?: string[]; // "always allow" keys, e.g. "bash:git" (see tools.allowKeyFor)
  mcpServers?: Record<string, McpServer>; // stdio MCP servers to load tools from (see mcp.ts)
  browserArgs?: string[]; // override the headless-Chrome launch args (see browser.ts)
  capabilities?: Partial<Capabilities>; // switch whole feature groups off (see below)
  permissionMode?: PermissionMode;
  disabledTools?: string[]; // individual tools switched off by name, MCP ones included
};

// --- capabilities -----------------------------------------------------------
// Every group here costs context whether or not you use it: each tool ships its
// schema and description on every single request, and skills/memory get listed
// in the system prompt. Switching a group off removes it from both, which is
// the point — a chat that only needs writing help shouldn't pay for a browser.
export type Capabilities = {
  files: boolean; // read_file, write_file, list_dir, grep, glob, search_files
  shell: boolean; // bash, powershell, run_script
  web: boolean; // web_search, browser
  memory: boolean; // remember/recall + the memory list in the system prompt
  skills: boolean; // use_skill + the skill list in the system prompt
  schedule: boolean; // schedule
  mcp: boolean; // every MCP server's tools
  subagents: boolean; // spawn_agent, loop_task
  flows: boolean; // run_flow (the Flows page still works)
  renderUi: boolean; // render_ui + its component catalog in the system prompt
  todo: boolean; // the task list the agent keeps while it works
};

export const CAPABILITIES: Capabilities = {
  files: true,
  shell: true,
  web: true,
  memory: true,
  skills: true,
  schedule: true,
  mcp: true,
  subagents: true,
  flows: true,
  renderUi: true,
  todo: true,
};

export function capabilities(config = loadConfig()): Capabilities {
  return { ...CAPABILITIES, ...(config.capabilities ?? {}) };
}

// --- permission mode --------------------------------------------------------
// "normal" is the shipped behaviour: the always-allow list and a server's
// trust:"read" skip the prompt. "ask" turns both off, so every side effect gets
// a card — the setting to reach for when you don't fully trust what you're
// pointing adhd at. "auto" approves everything without asking.
export type PermissionMode = "ask" | "normal" | "auto";

export function permissionMode(): PermissionMode {
  const m = loadConfig().permissionMode;
  return m === "ask" || m === "auto" ? m : "normal";
}

/** Tools switched off individually (as opposed to a whole capability group). */
export function disabledTools(config = loadConfig()): Set<string> {
  return new Set(config.disabledTools ?? []);
}

// --- providers --------------------------------------------------------------
// A model is named "<provider>:<id>". No prefix means deepseek, so every config
// written before this existed keeps working untouched.
//
// ponytail: routing by prefix, not by a table of known model ids. A table needs
// editing every time a vendor ships something; a prefix never goes stale, and
// the Settings box takes a free-typed id for exactly that reason.
export type Provider = "deepseek" | "anthropic" | "google" | "custom";

export const PROVIDER_KEY: Record<Provider, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  custom: "CUSTOM_API_KEY",
};

/** "anthropic:claude-sonnet-5" → ["anthropic", "claude-sonnet-5"]. Splits on the
 *  FIRST colon only, so an id containing one survives. */
export function splitSpec(spec: string): [Provider, string] {
  const i = spec.indexOf(":");
  if (i < 0) return ["deepseek", spec];
  const p = spec.slice(0, i);
  return p in PROVIDER_KEY ? [p as Provider, spec.slice(i + 1)] : ["deepseek", spec];
}

// Suggestions for the Settings dropdown, NOT a closed set — Settings also takes a
// free-typed id. Verified July 2026.
export const KNOWN_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "anthropic:claude-sonnet-5",
  "anthropic:claude-opus-5",
  "anthropic:claude-haiku-4-5",
  "google:gemini-3.1-pro",
  "google:gemini-3-flash",
] as const;

const DEFAULT: Config = {
  // v4-flash: fast, cheap, streams tool calls fine. v4-pro is the bigger model —
  // switch with /model. No fallback needed (DeepSeek has no tiny per-minute cap).
  model: "deepseek-v4-flash",
  fallbackModel: [],
  baseURL: "https://api.deepseek.com",
  // historyBudget deliberately unset: autoBudget() sizes it from the model's real
  // context window. Set it in config.json to pin it.
};

function readJson(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`adhd: ignoring bad config ${path}: ${(e as Error).message}`);
    return {};
  }
}

export function loadConfig(): Config {
  // home first, project last so project wins
  return {
    ...DEFAULT,
    ...readJson(join(HOME_ROOT, "config.json")),
    ...readJson(join(PROJECT_ROOT, "config.json")),
  };
}

/** One model from its "<provider>:<id>" spec. Throws naming the key it needs. */
export function resolveModel(spec: string, config: Config): LanguageModel {
  const [provider, id] = splitSpec(spec);
  const key = process.env[PROVIDER_KEY[provider]];
  if (!key)
    throw new Error(`missing ${PROVIDER_KEY[provider]} (add it in Settings, or put it in .env)`);
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: key })(id);
    case "google":
      return createGoogleGenerativeAI({ apiKey: key })(id);
    case "custom":
      // One slot covering every OpenAI-shaped endpoint — OpenRouter, Groq,
      // Ollama, LM Studio, OpenAI itself. The base URL is what picks which.
      return createOpenAICompatible({
        name: "custom",
        apiKey: key,
        baseURL: config.customBaseURL || "https://openrouter.ai/api/v1",
      })(id);
    default:
      return createDeepSeek({ apiKey: key, baseURL: config.baseURL })(id);
  }
}

// Primary first, then any fallback (deduped, blanks dropped). The agent walks
// this list when a model gets rate-limited. Mixed providers are fine — the
// fallback chain can hop vendors when one is throttling.
export function resolveModels(config: Config): LanguageModel[] {
  const fallbacks = Array.isArray(config.fallbackModel)
    ? config.fallbackModel
    : config.fallbackModel
      ? [config.fallbackModel]
      : [];
  const ids = [config.model, ...fallbacks].filter(
    (v, i, a): v is string => !!v && a.indexOf(v) === i,
  );
  return ids.map((id) => resolveModel(id, config));
}

// --- context windows --------------------------------------------------------
// How big the model's context actually is, in tokens. Drives both the meter in
// the chat window and the auto-sized history budget — a fixed budget is either
// wasteful on a 1M model or dangerous on a small one.

// Fallbacks for providers whose API won't tell us, longest prefix wins so
// "deepseek-v4-flash-0715" still resolves. Verified July 2026.
const CONTEXT_TABLE: [prefix: string, tokens: number][] = [
  ["deepseek-v4", 1_000_000],
  ["claude-haiku-4-5", 200_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-opus-4-5", 200_000],
  ["claude-opus-4-1", 200_000],
  ["claude-", 1_000_000], // fable/opus/sonnet 5, opus 4.6-4.8, sonnet 4.6
  ["gemini-3", 1_000_000],
  ["gpt-5", 400_000],
];
/** Unknown model: assume small. Over-filling a context costs money and errors;
 *  under-filling only costs a little memory. */
export const DEFAULT_CONTEXT = 128_000;

export function tableContext(spec: string): number {
  const [, id] = splitSpec(spec);
  let best = 0;
  let tokens = DEFAULT_CONTEXT;
  for (const [prefix, n] of CONTEXT_TABLE) {
    if (id.startsWith(prefix) && prefix.length > best) [best, tokens] = [prefix.length, n];
  }
  return tokens;
}

/**
 * Ask the provider how big the window is, falling back to the table. Anthropic
 * and Google both publish it; DeepSeek's OpenAI-shaped /models does not, and
 * neither does plain OpenAI — for those the table IS the answer.
 * Never throws: a probe failure just keeps the table value.
 */
export async function probeContext(spec: string, config: Config): Promise<number> {
  const [provider, id] = splitSpec(spec);
  const key = process.env[PROVIDER_KEY[provider]];
  const fallback = tableContext(spec);
  if (!key) return fallback;
  try {
    const json = async (url: string, headers: Record<string, string> = {}) => {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      return r.ok ? ((await r.json()) as any) : null;
    };
    if (provider === "anthropic") {
      const d = await json(`https://api.anthropic.com/v1/models/${encodeURIComponent(id)}`, {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      });
      return Number(d?.max_input_tokens) || fallback;
    }
    if (provider === "google") {
      const d = await json(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`,
      );
      return Number(d?.inputTokenLimit) || fallback;
    }
    if (provider === "custom") {
      // OpenRouter's shape. Endpoints without context_length just fall through.
      const base = (config.customBaseURL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
      const d = await json(`${base}/models`, { authorization: `Bearer ${key}` });
      const hit = (d?.data as any[])?.find((m) => m?.id === id);
      return Number(hit?.context_length) || fallback;
    }
  } catch {
    /* offline, throttled, or a provider that doesn't answer — table it is */
  }
  return fallback;
}

// ponytail: chars, not tokens, because there's no tokenizer here (see agent.ts).
// 4 chars/token is the usual rule of thumb; Claude Opus 4.7+ uses a tokenizer
// that yields ~30% more tokens for the same text, so this UNDER-estimates there.
// The 25% cap below absorbs that — swap in a real tokenizer if it ever bites.
export const CHARS_PER_TOKEN = 4;

/**
 * History budget in chars, from the model's real window. 25% leaves room for the
 * system prompt, tool schemas and the reply, and keeps the per-turn bill sane —
 * history is re-sent every single turn, so "fill the window" is not free.
 * Capped at 400k chars (~100k tokens) so a 1M model doesn't quietly 10x costs.
 */
export function autoBudget(contextTokens: number): number {
  return Math.min(Math.max(Math.round(contextTokens * CHARS_PER_TOKEN * 0.25), 40_000), 400_000);
}

/** Merge one field into the home config.json. Every setter below is this. */
function patchConfig(patch: Partial<Config>): void {
  const path = join(HOME_ROOT, "config.json");
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readJson(path), ...patch }, null, 2));
}

// Persist the chosen model to the home config so it survives restarts.
export const setUserModel = (model: string): void => patchConfig({ model });
export const setCustomBaseURL = (customBaseURL: string): void => patchConfig({ customBaseURL });

// --- API keys ---------------------------------------------------------------
// Stored in ~/.adhd/secrets.json with 0600 perms. On load they hydrate
// process.env (without overriding anything already set), so resolveModels and
// the Serper tools read process.env as before — no plumbing needed.
export const SECRETS_FILE = join(HOME_ROOT, "secrets.json");
// One row per entry in the Settings page — provider keys first, then tool keys.
// Adding a provider means adding it to PROVIDER_KEY and here, nothing else.
export const KEY_NAMES = [
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "CUSTOM_API_KEY",
  "SERPER_API_KEY",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

function readSecrets(): Record<string, string> {
  if (!existsSync(SECRETS_FILE)) return {};
  try {
    const v = JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Call once at startup: fill in any key not already in the environment.
export function loadSecretsIntoEnv(): void {
  const s = readSecrets();
  for (const [k, v] of Object.entries(s)) {
    if (v && !process.env[k]) process.env[k] = v;
  }
}

// Persist a key (0600) AND set it live so it takes effect without a restart.
export function writeSecret(name: KeyName, value: string): void {
  mkdirSync(HOME_ROOT, { recursive: true });
  const next = { ...readSecrets(), [name]: value };
  writeFileSync(SECRETS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  process.env[name] = value;
}

// Masked status only — the raw value never leaves the server.
export function keyStatus(): Record<KeyName, boolean> {
  return Object.fromEntries(KEY_NAMES.map((k) => [k, !!process.env[k]])) as Record<KeyName, boolean>;
}

// --- local file access (restricted) ----------------------------------------
// The local-file tools/route may only read under these roots. Never serve
// secrets even when they live under an allowed root.
const SENSITIVE =
  /(^|\/)\.(ssh|aws|gnupg|kube)(\/|$)|(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|keychain|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)\b/i;

const expandTilde = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

export function allowedRoots(): string[] {
  const roots = loadConfig().localRoots;
  return (roots?.length ? roots : [homedir()]).map(expandTilde);
}

// True only if `p` resolves (via realpath, defeating `../` and symlink escape)
// to a location inside an allowed root and isn't a sensitive file.
export function isUnderRoots(p: string): boolean {
  let real: string;
  try {
    real = realpathSync(expandTilde(p));
  } catch {
    return false;
  }
  if (SENSITIVE.test(real)) return false;
  return allowedRoots().some((root) => {
    try {
      const r = realpathSync(root);
      return real === r || real.startsWith(r + sep);
    } catch {
      return false;
    }
  });
}

export const setLocalRoots = (localRoots: string[]): void => patchConfig({ localRoots });

// --- "always allow" command list -------------------------------------------
// Keys are "<runner>:<program>" (see tools.allowKeyFor). Read fresh from disk
// each call so an approval takes effect on the very next command.
export function allowedCommands(): string[] {
  return loadConfig().allowedCommands ?? [];
}

export const setAllowedCommands = (allowedCommands: string[]): void => patchConfig({ allowedCommands });

// --- MCP servers ------------------------------------------------------------
export function mcpServers(): Record<string, McpServer> {
  return loadConfig().mcpServers ?? {};
}

export const setMcpServers = (mcpServers: Record<string, McpServer>): void => patchConfig({ mcpServers });
export const setCapabilities = (c: Partial<Capabilities>): void => patchConfig({ capabilities: c });
export const setPermissionMode = (permissionMode: PermissionMode): void => patchConfig({ permissionMode });
export const setDisabledTools = (disabledTools: string[]): void => patchConfig({ disabledTools });
