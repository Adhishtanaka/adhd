import { expect, test } from "bun:test";
import { parseAt, isDue, type Task } from "../src/scheduler.js";

test("parseAt reads daily and interval forms", () => {
  expect(parseAt("09:30")).toEqual({ kind: "daily", h: 9, m: 30 });
  expect(parseAt("every 30m")).toEqual({ kind: "interval", ms: 30 * 60_000 });
  expect(parseAt("every 2h")).toEqual({ kind: "interval", ms: 2 * 3600_000 });
  expect(parseAt("garbage")).toBeNull();
});

test("daily task is due only at its minute, once", () => {
  const t: Task = { id: "a", at: "09:30", prompt: "x" };
  const at930 = new Date(2026, 6, 18, 9, 30, 5);
  expect(isDue(t, at930)).toBe(true);
  expect(isDue(t, at930, at930.getTime())).toBe(false);
  expect(isDue(t, new Date(2026, 6, 18, 9, 31, 0))).toBe(false);
});

test("interval task fires first tick then waits its period", () => {
  const t: Task = { id: "b", at: "every 10m", prompt: "x" };
  const now = new Date(2026, 6, 18, 12, 0, 0);
  expect(isDue(t, now)).toBe(true);
  expect(isDue(t, now, now.getTime() - 5 * 60_000)).toBe(false);
  expect(isDue(t, now, now.getTime() - 11 * 60_000)).toBe(true);
});
