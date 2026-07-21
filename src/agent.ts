import { streamText, stepCountIs, type Tool, type ModelMessage } from "ai";
import type { LanguageModel } from "ai";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; result: unknown }
  | { type: "usage"; total: number }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

const MAX_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Detect a rate-limit / request-too-large error and how long to wait for it.
// Returns null when it isn't a rate-limit error. Wait is capped so we never hang.
function rateLimitWait(e: unknown): number | null {
  // The SDK wraps the real APICallError in a RetryError (.lastError / .errors[]),
  // so dig through those to find the one carrying the 429 and its retry-after.
  const err = e as any;
  const cand = err?.lastError ?? (Array.isArray(err?.errors) ? err.errors.at(-1) : null) ?? err;
  const status = cand?.statusCode ?? err?.statusCode;
  const msg = String(err?.message ?? "") + " " + String(cand?.message ?? "");
  const isRL = status === 429 || status === 413 || /rate.?limit|tokens per (minute|day)|request too large/i.test(msg);
  if (!isRL) return null;
  const ra = Number(cand?.responseHeaders?.["retry-after"] ?? err?.responseHeaders?.["retry-after"]);
  return Math.min(Number.isFinite(ra) && ra > 0 ? ra : 5, 90);
}

// A provider may intermittently reject a model's tool call (malformed name,
// unparseable arguments). It's nondeterministic, so simply re-rolling the
// request usually produces a valid call. Inert on providers that don't emit
// these messages; harmless to keep.
function isBadToolCall(e: unknown): boolean {
  const err = e as any;
  const msg = String(err?.message ?? "") + " " + String(err?.lastError?.message ?? "");
  return /tool call validation failed|failed to call a function|not in request\.tools/i.test(msg);
}

export type Agent = {
  send(userText: string, onEvent: (e: AgentEvent) => void): Promise<void>;
  setModels(models: LanguageModel[]): void; // hot-swap the model chain (/model)
  reset(): void; // clear conversation history (new chat)
};

// Keep requests small — some models/tiers have a tiny tokens-per-minute cap, and
// raw tool output (web pages, file dumps) piles up fast. Budget is in characters
// (~4 per token). ponytail: char budget, not a real tokenizer.
const HISTORY_BUDGET = 8000;

function msgSize(m: ModelMessage): number {
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
}

// Drop the oldest messages until the history fits, always leaving a window that
// starts at a user message so tool-call/tool-result pairs stay intact.
function trimHistory(h: ModelMessage[], budget: number): void {
  let total = h.reduce((s, m) => s + msgSize(m), 0);
  while (total > budget && h.length > 1) {
    total -= msgSize(h[0]);
    h.shift();
    while (h.length > 1 && h[0].role !== "user") {
      total -= msgSize(h[0]);
      h.shift();
    }
  }
}

const modelName = (m: LanguageModel): string =>
  typeof m === "string" ? m : ((m as any).modelId ?? "fallback model");

export function createAgent(opts: {
  models: LanguageModel[]; // primary first; later entries are rate-limit fallbacks
  tools: Record<string, Tool>;
  system: string;
  historyBudget?: number;
}): Agent {
  const budget = opts.historyBudget ?? HISTORY_BUDGET;
  const history: ModelMessage[] = [];
  // Persists across turns: once a model is rate-limited we stay on the next one
  // instead of hammering the dead one every turn.
  let modelIdx = 0;
  let models = opts.models; // mutable so /model can hot-swap without losing history

  return {
    setModels(m) {
      models = m;
      modelIdx = 0;
    },
    reset() {
      history.length = 0;
    },
    async send(userText, onEvent) {
      const mark = history.length; // roll back to here if the turn errors with no progress
      history.push({ role: "user", content: userText });
      trimHistory(history, budget);

      // Completed steps (assistant msgs + tool results) for THIS turn. onStepFinish
      // fills it as each step finishes, so it survives a mid-turn model switch or
      // retry — the next attempt replays it as context instead of re-running tools.
      const pendingTurn: ModelMessage[] = [];

      for (let attempt = 0; ; attempt++) {
        try {
          const result = streamText({
            model: models[modelIdx],
            system: opts.system,
            tools: opts.tools,
            stopWhen: stepCountIs(12),
            messages: [...history, ...pendingTurn],
            maxRetries: 0, // we handle rate-limit retries/fallback ourselves
            onError: () => {}, // errors reach the user via the stream; don't let the SDK's default dump them over the TUI
            onStepFinish: ({ response, usage }) => {
              pendingTurn.push(...response.messages);
              const total = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
              if (total) onEvent({ type: "usage", total });
            },
          });
          let streamError: unknown = null;
          for await (const part of result.fullStream) {
            switch (part.type) {
              case "text-delta":
                onEvent({ type: "text", delta: (part as any).text });
                break;
              case "tool-call":
                onEvent({ type: "tool-call", id: part.toolCallId, name: part.toolName, args: (part as any).input });
                break;
              case "tool-result":
                onEvent({ type: "tool-result", id: part.toolCallId, result: (part as any).output });
                break;
              case "error":
                // Route it through the catch below (rate-limit switch/retry).
                streamError = (part as any).error;
                break;
            }
          }
          void Promise.resolve(result.response).catch(() => {}); // avoid unhandled rejection
          if (streamError) throw streamError;
          history.push(...pendingTurn);
          return;
        } catch (e) {
          const wait = rateLimitWait(e);
          // A rate limit hits BETWEEN steps, so pendingTurn holds every completed
          // step — switching models or retrying loses no work and re-runs no tool.
          if (wait !== null && modelIdx < models.length - 1) {
            modelIdx++;
            onEvent({ type: "info", message: `rate limited — switching to ${modelName(models[modelIdx])}, continuing` });
            continue;
          }
          if (wait !== null && attempt < MAX_RETRIES) {
            onEvent({ type: "info", message: `rate limited — waiting ${wait}s then retrying (${attempt + 1}/${MAX_RETRIES})` });
            await sleep(wait * 1000);
            continue;
          }
          if (isBadToolCall(e) && attempt < MAX_RETRIES) {
            onEvent({ type: "info", message: `malformed tool call — retrying (${attempt + 1}/${MAX_RETRIES})` });
            continue;
          }
          // Out of options: keep whatever steps completed so context isn't lost;
          // if none did, roll back so no dangling user message is left behind.
          if (pendingTurn.length) history.push(...pendingTurn);
          else history.length = mark;
          onEvent({ type: "error", message: (e as Error).message });
          return;
        }
      }
    },
  };
}
