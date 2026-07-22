import { expect, test, beforeEach } from "bun:test";
import { withDeadline, setJobSinks, runningJobs, _resetJobs, type FinishedJob } from "../src/jobs.js";

const after = (ms: number, v: string) => new Promise<string>((r) => setTimeout(() => r(v), ms));

let finished: FinishedJob[];
let started: string[];
beforeEach(() => {
  _resetJobs();
  finished = [];
  started = [];
  setJobSinks((j) => finished.push(j), (id, label) => started.push(`${id}:${label}`));
});

test("work that beats the deadline returns its real result", async () => {
  expect(await withDeadline("fast", 200, () => after(5, "the answer"))).toBe("the answer");
  expect(started).toEqual([]);
  expect(finished).toEqual([]);
});

test("work that blows the deadline is backgrounded, then delivered", async () => {
  const out = await withDeadline("slow thing", 20, () => after(60, "late answer"));
  // The model is told to end its turn, and must not be handed the result yet.
  expect(out).toContain("job1");
  expect(out).toContain("background");
  expect(out).not.toContain("late answer");
  expect(started).toEqual(["job1:slow thing"]);
  expect(runningJobs()).toEqual([{ id: "job1", label: "slow thing" }]);

  await after(80, "");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ id: "job1", label: "slow thing", result: "late answer" });
  expect(runningJobs()).toEqual([]); // no longer running once delivered
});

test("a rejection is delivered as text, never as an unhandled rejection", async () => {
  const out = await withDeadline("boom", 20, () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("nope")), 60)));
  expect(out).toContain("job1");
  await after(80, "");
  expect(finished[0].result).toBe("failed: nope");
});

test("a fast rejection returns the failure inline, without backgrounding", async () => {
  expect(await withDeadline("boom", 200, () => Promise.reject(new Error("nope")))).toBe("failed: nope");
  expect(started).toEqual([]);
});
