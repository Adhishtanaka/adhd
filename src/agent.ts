import { streamText, generateText, stepCountIs, type Tool, type ModelMessage } from "ai";
import type { LanguageModel } from "ai";
import { cap } from "./tools.js";

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
// Once history passes the budget, compaction trims it down to this fraction (not
// merely under budget) so the next turn has headroom and doesn't re-compact
// immediately. ponytail: fixed hysteresis, make it config only if it ever matters.
const KEEP_RATIO = 0.5;

function msgSize(m: ModelMessage): number {
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
}

function msgText(m: ModelMessage): string {
  return `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
}

// Remove the oldest messages until `h` fits `target`, always leaving a window that
// starts at a user message so tool-call/tool-result pairs stay intact. Returns the
// removed prefix (oldest-first) so the caller can summarize it instead of losing it.
export function splitOldest(h: ModelMessage[], target: number): ModelMessage[] {
  const dropped: ModelMessage[] = [];
  let total = h.reduce((s, m) => s + msgSize(m), 0);
  while (total > target && h.length > 1) {
    total -= msgSize(h[0]);
    dropped.push(h.shift()!);
    while (h.length > 1 && h[0].role !== "user") {
      total -= msgSize(h[0]);
      dropped.push(h.shift()!);
    }
  }
  return dropped;
}

const COMPACT_SYSTEM =
  "You compress an ongoing conversation between a user and their assistant into a compact " +
  "running summary, for the assistant to keep as memory of what came before. Preserve: the " +
  "user's goals, decisions made, facts established, and any specifics (names, file paths, " +
  "numbers, URLs) later turns may reference, plus the current state of any task in progress. " +
  "Fold the new messages into the prior summary. Output only the summary — no preamble.";

// One-off model call that turns dropped messages (merged with the prior summary)
// into the next running summary. Mirrors flows.ts's `ask` — a single generateText
// with no tools. Kept module-level so it's easy to reason about and test around.
async function summarizeMessages(
  prev: string,
  dropped: ModelMessage[],
  model: LanguageModel,
  budget: number,
): Promise<string> {
  const block = cap(dropped.map(msgText).join("\n\n"), budget);
  const prompt = (prev ? `Prior summary:\n${prev}\n\n` : "") + `New messages to fold in:\n${block}`;
  const { text } = await generateText({ model, system: COMPACT_SYSTEM, prompt, maxRetries: 1 });
  return text.trim();
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
  // Running summary of everything trimmed out of `history`, folded into the system
  // prompt so the model still "remembers" the gist instead of forgetting it. Grows
  // and gets re-summarized as more history is compacted; cleared on reset().
  let summary = "";
  // Persists across turns: once a model is rate-limited we stay on the next one
  // instead of hammering the dead one every turn.
  let modelIdx = 0;
  let models = opts.models; // mutable so /model can hot-swap without losing history

  // When history outgrows the budget, summarize the oldest messages into `summary`
  // rather than dropping them outright. On any summarizer failure (e.g. the compaction
  // call itself is rate-limited) the messages stay dropped — no worse than before.
  async function compact(onEvent: (e: AgentEvent) => void): Promise<void> {
    const total = summary.length + history.reduce((s, m) => s + msgSize(m), 0);
    if (total <= budget) return;
    const dropped = splitOldest(history, budget * KEEP_RATIO);
    if (!dropped.length) return;
    try {
      summary = cap(await summarizeMessages(summary, dropped, models[modelIdx], budget), 4000);
      onEvent({ type: "info", message: `compacted ${dropped.length} earlier message${dropped.length > 1 ? "s" : ""} into a summary` });
    } catch {
      // Dropped stays dropped — same outcome as the old hard-trim. Run continues.
    }
  }

  return {
    setModels(m) {
      models = m;
      modelIdx = 0;
    },
    reset() {
      history.length = 0;
      summary = "";
    },
    async send(userText, onEvent) {
      const mark = history.length; // roll back to here if the turn errors with no progress
      history.push({ role: "user", content: userText });
      await compact(onEvent);

      // Completed steps (assistant msgs + tool results) for THIS turn. onStepFinish
      // fills it as each step finishes, so it survives a mid-turn model switch or
      // retry — the next attempt replays it as context instead of re-running tools.
      const pendingTurn: ModelMessage[] = [];

      for (let attempt = 0; ; attempt++) {
        try {
          const result = streamText({
            model: models[modelIdx],
            system: opts.system + (summary ? `\n\nSummary of earlier conversation:\n${summary}` : ""),
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
