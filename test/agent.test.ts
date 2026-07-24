import { test, expect } from "bun:test";
import { splitOldest } from "../src/agent.js";
import type { ModelMessage } from "ai";

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
