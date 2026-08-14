import { streamText, generateText, stepCountIs, type Tool, type ModelMessage } from "ai";
import type { LanguageModel } from "ai";
import { cap } from "./tools.js";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; result: unknown }
  | { type: "usage"; total: number }
  | { type: "context"; stats: ContextStats }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

// What's actually occupying the context right now, so the chat window can show
// it instead of leaving the user to guess. Sizes are CHARS — the same unit the
// budget is in, because there's no tokenizer here (see HISTORY_BUDGET).
export type ContextSeg = {
  kind: "system" | "schemas" | "summary" | "user" | "assistant" | "tool";
  name?: string; // tool name, for colouring the strip by tool
  size: number;
};
export type ContextStats = {
  used: number; // chars in play right now (system + summary + history)
  budget: number; // compaction fires past this
  window: number; // the model's real context, in chars — the strip's denominator
  model: string;
  compactions: number;
  pruned: number; // chars reclaimed by tool-result pruning, cumulative
  segments: ContextSeg[];
};

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
  setTools(tools: Record<string, Tool>): void; // hot-swap the tool set (capability toggles)
  setContext(budget: number, window: number, model: string): void; // re-size after a model swap
  stats(): ContextStats; // current occupancy, for the strip + /state
  compact(onEvent: (e: AgentEvent) => void): Promise<void>; // force a pass now (/compact)
  reset(): void; // clear conversation history (new chat)
};

// Keep requests small — raw tool output (web pages, file dumps) piles up fast,
// and history is re-sent every turn, so this is a cost lever as much as a limit.
// Budget is in characters (~4 per token) and is normally sized from the model's
// real context window (config.autoBudget); this is only the floor when nothing
// told us better. ponytail: char budget, not a real tokenizer.
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

// Tool output is both the biggest thing in a context window and the cheapest to
// shrink: keep the head and tail of an over-long result, replace the middle with
// a marker saying what went. Deterministic and model-free, so it runs BEFORE the
// summarizer and often makes that call unnecessary. Head > tail because tool
// output front-loads the useful part (a file's imports, a search's best hits)
// while the tail is usually the truncation notice or the last few rows.
// Lifted from deepseek-harness's compaction-tool-result-pruner, same shape.
const PRUNE_THRESHOLD = 4000;
const PRUNE_HEAD = 2000;
const PRUNE_TAIL = 800;

// Returns null when `t` is already within budget — the caller uses that to skip
// rewriting the message at all. Slices by code point, not UTF-16 unit, so a cut
// can't land inside a surrogate pair and produce a lone half of an emoji.
export function pruneText(t: string): string | null {
  const pts = Array.from(t);
  if (pts.length <= PRUNE_THRESHOLD) return null;
  const gone = pts.length - PRUNE_HEAD - PRUNE_TAIL;
  return (
    pts.slice(0, PRUNE_HEAD).join("") +
    `\n\n[... ${gone} chars of tool output pruned ...]\n\n` +
    pts.slice(-PRUNE_TAIL).join("")
  );
}

// Prune every over-long tool result in h[0..protect). Mutates in place (the
// history array is the agent's own) and returns the chars reclaimed. `protect`
// is normally the index of the newest user message: the current turn's tool
// output is what the model is actively reasoning about, so it's left whole.
export function pruneToolResults(h: ModelMessage[], protect: number): number {
  let saved = 0;
  for (let i = 0; i < Math.min(protect, h.length); i++) {
    const m = h[i];
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as any[]) {
      if (part?.type !== "tool-result") continue;
      // Output is {type:"text"|"error-text", value:string} or {type:"json", value:any}.
      // JSON blobs are the fat ones, so stringify and prune those too — what's
      // left is a marker-bearing excerpt either way, not something to re-parse.
      const v = part.output?.value;
      if (v === undefined) continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      const short = pruneText(text);
      if (short === null) continue;
      saved += text.length - short.length;
      part.output = { type: "text", value: short };
    }
  }
  return saved;
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

// One history message → one strip segment. Tool results ride in "tool" messages;
// an assistant message carrying tool calls is labelled by the first one so the
// strip shows which tool cost the space rather than a nameless block.
// Tool schemas are re-sent on EVERY request, so with a few dozen tools they can
// outweigh the whole conversation — and they were invisible, which made the
// context look like it filled itself. Counting them is what makes the capability
// switches in Settings show their worth.
//
// ponytail: an approximation. The SDK serialises zod to JSON Schema at call time
// and we don't want to do that work per keystroke, so this measures the
// description plus a best-effort stringify of the schema. Off by a constant
// factor, not by an order of magnitude; swap in the real conversion if the
// number ever needs to be exact.
function schemaSize(tools: Record<string, Tool>): number {
  let n = 0;
  for (const [name, t] of Object.entries(tools)) {
    n += name.length + String((t as any).description ?? "").length;
    try {
      const s = (t as any).inputSchema;
      n += JSON.stringify(s?.jsonSchema ?? s?._def ?? s ?? {})?.length ?? 0;
    } catch {
      n += 200; // circular or exotic schema — a flat guess beats crashing stats()
    }
  }
  return n;
}

function segment(m: ModelMessage): ContextSeg {
  const size = msgSize(m);
  if (m.role === "user") return { kind: "user", size };
  const parts = Array.isArray(m.content) ? (m.content as any[]) : [];
  const call = parts.find((p) => p?.type === "tool-call" || p?.type === "tool-result");
  if (m.role === "tool" || call) return { kind: "tool", name: call?.toolName, size };
  return { kind: "assistant", size };
}

export function createAgent(opts: {
  models: LanguageModel[]; // primary first; later entries are rate-limit fallbacks
  tools: Record<string, Tool>;
  system: string;
  historyBudget?: number;
  contextWindow?: number; // model's real window in CHARS; strip denominator only
}): Agent {
  // Mutable: a model swap re-sizes both (setContext), since a 200k model and a
  // 1M model should not be held to the same budget.
  let budget = opts.historyBudget ?? HISTORY_BUDGET;
  let window = opts.contextWindow ?? budget * 4;
  let modelId = "";
  let compactions = 0;
  let pruned = 0; // chars reclaimed by tool-result pruning, for the strip readout
  const history: ModelMessage[] = [];
  // Running summary of everything trimmed out of `history`, folded into the system
  // prompt so the model still "remembers" the gist instead of forgetting it. Grows
  // and gets re-summarized as more history is compacted; cleared on reset().
  let summary = "";
  // Persists across turns: once a model is rate-limited we stay on the next one
  // instead of hammering the dead one every turn.
  let modelIdx = 0;
  let models = opts.models; // mutable so /model can hot-swap without losing history
  let tools = opts.tools; // mutable so capability toggles apply on the next turn

  // System prompt + tool schemas: paid on every request and not something
  // compaction can touch. It only shrinks by switching capabilities off.
  const overhead = (): number => opts.system.length + schemaSize(tools);

  // What history is actually allowed, once the fixed overhead has taken its cut
  // of the budget. Without this the bar and the compaction trigger disagreed —
  // the strip could sit at 90% while compact() never fired, because one counted
  // the overhead and the other didn't. The floor keeps a huge tool set from
  // squeezing history to nothing.
  const historyBudget = (): number => Math.max(budget - overhead(), Math.round(budget * 0.2));

  function stats(): ContextStats {
    const segments: ContextSeg[] = [
      { kind: "system", size: opts.system.length },
      { kind: "schemas", size: schemaSize(tools), name: `${Object.keys(tools).length} tools` },
    ];
    if (summary) segments.push({ kind: "summary", size: summary.length });
    for (const m of history) segments.push(segment(m));
    return {
      used: segments.reduce((s, g) => s + g.size, 0),
      budget,
      window,
      model: modelId,
      compactions,
      pruned,
      segments,
    };
  }

  // Two passes, cheapest first. Pruning old tool output is deterministic and
  // free, so it runs before the summarizer and usually recovers enough on its
  // own — the model call only happens when the conversation itself is the bulk.
  // On any summarizer failure (e.g. the compaction call is itself rate-limited)
  // the messages stay dropped — no worse than before.
  async function compact(onEvent: (e: AgentEvent) => void, force = false): Promise<void> {
    const room = historyBudget();
    const size = () => summary.length + history.reduce((s, m) => s + msgSize(m), 0);
    if (!force && size() <= room) return;

    // Everything before the newest user message is fair game; the current turn's
    // tool output is what the model is reasoning about right now, so it stays whole.
    const saved = pruneToolResults(history, Math.max(0, history.findLastIndex((m) => m.role === "user")));
    if (saved) {
      pruned += saved;
      onEvent({ type: "info", message: `pruned ${saved} chars of earlier tool output` });
    }
    if (!force && size() <= room) {
      onEvent({ type: "context", stats: stats() });
      return;
    }

    const dropped = splitOldest(history, room * KEEP_RATIO);
    if (!dropped.length) {
      if (saved) onEvent({ type: "context", stats: stats() });
      return;
    }
    try {
      summary = cap(await summarizeMessages(summary, dropped, models[modelIdx], budget), 4000);
      compactions++;
      onEvent({ type: "info", message: `compacted ${dropped.length} earlier message${dropped.length > 1 ? "s" : ""} into a summary` });
    } catch {
      // Dropped stays dropped — same outcome as the old hard-trim. Run continues.
    }
    onEvent({ type: "context", stats: stats() });
  }

  return {
    setModels(m) {
      models = m;
      modelIdx = 0;
    },
    setTools(t) {
      tools = t;
    },
    setContext(b, w, model) {
      budget = b;
      window = w;
      modelId = model;
    },
    stats,
    compact: (onEvent) => compact(onEvent, true),
    reset() {
      history.length = 0;
      summary = "";
      compactions = 0;
      pruned = 0;
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
            tools,
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
          onEvent({ type: "context", stats: stats() });
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
          onEvent({ type: "context", stats: stats() });
          return;
        }
      }
    },
  };
}
