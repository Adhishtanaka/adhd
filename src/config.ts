import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";

export const HOME_ROOT = join(homedir(), ".adhd");
export const PROJECT_ROOT = join(process.cwd(), ".adhd");
export const ROOTS = [HOME_ROOT, PROJECT_ROOT]; // project overrides home

export type Config = {
  model: string; // DeepSeek model id, e.g. "deepseek-chat"
  fallbackModel?: string | string[]; // tried in order when a model is rate-limited; [] disables
  baseURL: string; // DeepSeek's OpenAI-compatible endpoint
  historyBudget?: number; // max chars of chat history sent per request (~4 chars/token)
  systemPrompt?: string;
  localRoots?: string[]; // folders the local-file tools may read (default: home)
  allowedCommands?: string[]; // "always allow" keys, e.g. "bash:git" (see tools.allowKeyFor)
};

// Current DeepSeek API models (both 1M context, tool calls, thinking by default).
// deepseek-chat/deepseek-reasoner deprecate 2026-07-24; -chat mapped to v4-flash.
export const KNOWN_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

const DEFAULT: Config = {
  // v4-flash: fast, cheap, streams tool calls fine. v4-pro is the bigger model —
  // switch with /model. No fallback needed (DeepSeek has no tiny per-minute cap).
  model: "deepseek-v4-flash",
  fallbackModel: [],
  baseURL: "https://api.deepseek.com",
  // ~15k tokens of history — tiny slice of v4's 1M context window.
  historyBudget: 60000,
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

// Primary first, then any fallback (deduped, blanks dropped). The agent walks
// this list when a model gets rate-limited.
export function resolveModels(config: Config): LanguageModel[] {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key)
    throw new Error("missing DEEPSEEK_API_KEY (put it in .env or the environment)");
  const deepseek = createDeepSeek({ apiKey: key, baseURL: config.baseURL });
  const fallbacks = Array.isArray(config.fallbackModel)
    ? config.fallbackModel
    : config.fallbackModel
      ? [config.fallbackModel]
      : [];
  const ids = [config.model, ...fallbacks].filter(
    (v, i, a): v is string => !!v && a.indexOf(v) === i,
  );
  return ids.map((id) => deepseek(id));
}

// Persist the chosen model to the home config so it survives restarts.
export function setUserModel(model: string): void {
  const path = join(HOME_ROOT, "config.json");
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readJson(path), model }, null, 2));
}

// --- API keys ---------------------------------------------------------------
// Stored in ~/.adhd/secrets.json with 0600 perms. On load they hydrate
// process.env (without overriding anything already set), so resolveModels and
// the Serper tools read process.env as before — no plumbing needed.
export const SECRETS_FILE = join(HOME_ROOT, "secrets.json");
export const KEY_NAMES = ["DEEPSEEK_API_KEY", "SERPER_API_KEY"] as const;
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

export function setLocalRoots(roots: string[]): void {
  const path = join(HOME_ROOT, "config.json");
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readJson(path), localRoots: roots }, null, 2));
}

// --- "always allow" command list -------------------------------------------
// Keys are "<runner>:<program>" (see tools.allowKeyFor). Read fresh from disk
// each call so an approval takes effect on the very next command.
export function allowedCommands(): string[] {
  return loadConfig().allowedCommands ?? [];
}

export function setAllowedCommands(list: string[]): void {
  const path = join(HOME_ROOT, "config.json");
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...readJson(path), allowedCommands: list }, null, 2));
}
