import { test, expect } from "bun:test";
import { splitOldest, pruneText, pruneToolResults } from "../src/agent.js";
import type { ModelMessage } from "ai";

// A tool message the way the AI SDK shapes one, so the pruner is exercised
// against the real structure rather than a convenient stand-in.
const toolMsg = (value: unknown, type = "text"): ModelMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type, value } }],
  }) as ModelMessage;
const outputOf = (m: ModelMessage) => (m.content as any)[0].output.value as string;

// Fixed-size messages so the char budget math is easy to reason about.
const msg = (role: ModelMessage["role"], n: number): ModelMessage => ({ role, content: role[0].repeat(n) } as ModelMessage);
const total = (h: ModelMessage[]) => h.reduce((s, m) => s + (m.content as string).length, 0);

test("splitOldest returns the removed prefix, trims to target, keeps a user boundary", () => {
  const h: ModelMessage[] = [msg("user", 100), msg("assistant", 100), msg("user", 100), msg("assistant", 100)];
  const dropped = splitOldest(h, 250);
  expect(dropped.length).toBe(2); // oldest user+assistant removed
  expect(dropped.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(h.map((m) => m.role)).toEqual(["user", "assistant"]); // window still starts at a user
  expect(total(h)).toBeLessThanOrEqual(250);
});

test("splitOldest never strands a tool result at the front of the window", () => {
  // A tool result must stay paired with the assistant that called it. When the
  // budget forces trimming mid-turn, the whole assistant+tool group goes together.
  const h: ModelMessage[] = [
    msg("user", 50),
    msg("assistant", 50),
    msg("user", 50),
    msg("assistant", 50),
    msg("tool", 50),
    msg("user", 50),
  ];
  const dropped = splitOldest(h, 120);
  expect(h[0].role).toBe("user"); // never a dangling assistant/tool at the head
  expect(h.some((m) => m.role === "tool")).toBe(false); // the stranded tool went with its assistant
  expect(dropped.length).toBe(5);
});

test("pruneText leaves short output alone and keeps head+tail of long output", () => {
  expect(pruneText("x".repeat(4000))).toBeNull(); // at the threshold, not over it

  const long = "H".repeat(3000) + "M".repeat(5000) + "T".repeat(2000);
  const out = pruneText(long)!;
  expect(out.startsWith("H".repeat(2000))).toBe(true);
  expect(out.endsWith("T".repeat(800))).toBe(true);
  expect(out).toContain("chars of tool output pruned");
  expect(out.length).toBeLessThan(long.length);
});

test("pruneText slices on code points, never splitting a surrogate pair", () => {
  // Emoji are two UTF-16 units each: a naive slice() would cut one in half and
  // leave a lone surrogate, which serialises as a replacement char.
  const out = pruneText("😀".repeat(5000))!;
  expect(out).not.toContain("�");
  expect([...out].every((c) => c === "😀" || !/[\uD800-\uDFFF]/.test(c))).toBe(true);
});

test("pruneToolResults shrinks old tool output and leaves the current turn whole", () => {
  const h: ModelMessage[] = [
    msg("user", 10),
    toolMsg("A".repeat(9000)), // older turn — prunable
    msg("user", 10), // newest user message: everything from here is protected
    toolMsg("B".repeat(9000)),
  ];
  const saved = pruneToolResults(h, h.findLastIndex((m) => m.role === "user"));

  expect(saved).toBeGreaterThan(6000);
  expect(outputOf(h[1]).length).toBeLessThan(3000);
  expect(outputOf(h[3])).toBe("B".repeat(9000)); // untouched
});

test("pruneToolResults folds an over-long json result down to pruned text", () => {
  const h = [toolMsg({ rows: Array.from({ length: 2000 }, (_, i) => `row-${i}`) }, "json"), msg("user", 10)];
  expect(pruneToolResults(h, 1)).toBeGreaterThan(0);
  expect((h[0].content as any)[0].output.type).toBe("text");
  expect(outputOf(h[0])).toContain("chars of tool output pruned");
});

test("pruneToolResults is idempotent — a second pass reclaims nothing", () => {
  const h = [toolMsg("A".repeat(9000)), msg("user", 10)];
  expect(pruneToolResults(h, 1)).toBeGreaterThan(0);
  expect(pruneToolResults(h, 1)).toBe(0);
});
