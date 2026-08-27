import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME_ROOT } from "../src/config.js";
import { logUser, logToolCall, logToolResult, logAssistant } from "../src/toollog.js";
import { runReflection, approveProposal, rejectProposal, loadProposals } from "../src/reflect.js";
import { loadFlows, saveFlows, type Flow } from "../src/flows.js";
import { loadMemories, saveMemory, deleteMemory } from "../src/memory.js";

// Real ~/.adhd state, like toollog.test.ts's own "real logs.db" convention —
// every key below is tagged with a random run id so it can never collide with
// real usage, another test file, or a previous run's leftover state.
const rid = crypto.randomUUID().slice(0, 8);
const session = "__reflect_test__";

function logTurn(prompt: string, tools: string[]): void {
  const turn = logUser(session, prompt);
  for (const name of tools) {
    const callId = crypto.randomUUID();
    logToolCall(session, turn, callId, name, { q: `arg-${name}` });
    logToolResult(callId, "ok");
  }
  logAssistant(session, turn, "done");
}

// A filler word that's different on every call (rid + tag + i) — tag keeps
// tests from colliding with each other, i keeps a test's own loop iterations
// from colliding with themselves — so word-mining never sees the same
// non-keyword word repeat 4x and draft an incidental proposal. runReflection()
// mines every real word in these prompts, not just the ones a test cares about.
const noise = (tag: string, i: number): string => `w${rid}${tag}${i}`;

test("a tool sequence repeated 4x proposes a flow, not before", () => {
  const a = `__seqA_${rid}__`;
  const b = `__seqB_${rid}__`;
  const id = `flow:${a}>${b}`;
  for (let i = 0; i < 3; i++) logTurn(noise("seq", i), [a, b]);
  expect(runReflection(4).some((x) => x.id === id)).toBe(false);

  logTurn(noise("seq", 3), [a, b]);
  const p = runReflection(4).find((x) => x.id === id);
  expect(p).toBeDefined();
  if (p?.kind === "flow") {
    expect(p.draft.flow.nodes.filter((n) => n.type === "tool").map((n) => n.data.tool)).toEqual([a, b]);
  }
  rejectProposal(id); // cleanup: don't leave it pending in real state
});

test("a request keyword repeated 4x proposes a memory, not before", () => {
  const kw = `zzzflarn${rid}`;
  const id = `memory:${kw}`;
  for (let i = 0; i < 3; i++) logTurn(`${noise("flarn", i)} ${kw} ${noise("flarn", i)}z`, []);
  expect(runReflection(4).some((x) => x.id === id)).toBe(false);

  logTurn(`${noise("flarn", 3)} ${kw} ${noise("flarn", 3)}z`, []);
  const p = runReflection(4).find((x) => x.id === id);
  expect(p).toBeDefined();
  if (p?.kind === "memory") expect(p.draft.memory.description).toContain(kw);

  rejectProposal(id); // cleanup: don't leave it pending in real state
});

test("an existing memory covering the keyword suppresses a duplicate proposal", () => {
  const kw = `zzzcovered${rid}`;
  // body must be unique per run, same as every other value in this file — memory.ts
  // now refuses to save a body whose content fingerprint already exists on disk
  // (or was recently deleted), and a literal "x" would collide across runs.
  saveMemory({ id: `reflect-test/${rid}`, type: "note", description: `already about ${kw}`, body: `covering note ${rid}`, origin: "explicit" });
  for (let i = 0; i < 4; i++) logTurn(`${noise("covmem", i)} ${kw} ${noise("covmem", i)}z`, []);
  expect(runReflection(4).some((x) => x.id === `memory:${kw}`)).toBe(false);
  deleteMemory(`reflect-test/${rid}`);
  rmSync(join(HOME_ROOT, "memory", "reflect-test"), { recursive: true, force: true });
  // Counters are permanent history, but runReflection() only re-evaluates them
  // when there's at least one new row to scan — so removing the covering
  // memory alone doesn't resurrect the proposal. It's the NEXT run with fresh
  // activity (even unrelated) that would. Force that now, deliberately, and
  // dismiss it — so this test doesn't leave a resurrectable counter behind for
  // some later, unrelated test to trip over.
  logTurn(`${noise("covmem", 4)} ${kw} ${noise("covmem", 4)}z`, []);
  runReflection(4);
  rejectProposal(`memory:${kw}`);
});

test("an existing flow covering the sequence suppresses a duplicate proposal", () => {
  const a = `__covA_${rid}__`;
  const b = `__covB_${rid}__`;
  const flow: Flow = {
    id: `reflect-test-cov-${rid}`,
    name: "existing",
    nodes: [
      { id: "s", type: "start", data: {} },
      { id: "t0", type: "tool", data: { tool: a } },
      { id: "t1", type: "tool", data: { tool: b } },
      { id: "e", type: "end", data: {} },
    ],
    edges: [
      { source: "s", target: "t0" },
      { source: "t0", target: "t1" },
      { source: "t1", target: "e" },
    ],
  };
  saveFlows([...loadFlows(), flow]);
  for (let i = 0; i < 4; i++) logTurn(noise("covflow", i), [a, b]);
  expect(runReflection(4).some((x) => x.id === `flow:${a}>${b}`)).toBe(false);
  saveFlows(loadFlows().filter((f) => f.id !== flow.id));
  // Same reasoning as the memory case above: force one more scan with the
  // covering flow gone, then dismiss it rather than leaving a resurrectable
  // counter behind.
  logTurn(noise("covflow", 4), [a, b]);
  runReflection(4);
  rejectProposal(`flow:${a}>${b}`);
});

test("approve applies a memory proposal and clears it from pending", () => {
  const kw = `zzzapprove${rid}`;
  const id = `memory:${kw}`;
  for (let i = 0; i < 4; i++) logTurn(`${noise("apmem", i)} ${kw} ${noise("apmem", i)}z`, []);
  const p = runReflection(4).find((x) => x.id === id);
  expect(p).toBeDefined();

  const res = approveProposal(id);
  expect(res.ok).toBe(true);
  expect(loadProposals().some((x) => x.id === id)).toBe(false);

  if (p?.kind === "memory") {
    const mem = loadMemories().find((m) => m.id === p.draft.memory.id);
    expect(mem).toBeDefined();
    if (mem) deleteMemory(mem.id);
    rmSync(join(HOME_ROOT, "memory", "reflect"), { recursive: true, force: true });
    // Deleting the just-approved memory un-covers the pattern again — force
    // one more scan and dismiss it rather than leaving a resurrectable counter.
    logTurn(`${noise("apmem", 4)} ${kw} ${noise("apmem", 4)}z`, []);
    runReflection(4);
    rejectProposal(id);
  }
});

test("approve applies a flow proposal, writes it, and writes a matching skill file", () => {
  const a = `__apA_${rid}__`;
  const b = `__apB_${rid}__`;
  const id = `flow:${a}>${b}`;
  for (let i = 0; i < 4; i++) logTurn(noise("apflow", i), [a, b]);
  const p = runReflection(4).find((x) => x.id === id);
  expect(p).toBeDefined();

  const res = approveProposal(id);
  expect(res.ok).toBe(true);

  if (p?.kind === "flow") {
    expect(loadFlows().some((f) => f.id === p.draft.flow.id)).toBe(true);
    const skillDir = join(HOME_ROOT, "skills", p.draft.skill.name);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain(`name: ${p.draft.skill.name}`);
    saveFlows(loadFlows().filter((f) => f.id !== p.draft.flow.id));
    rmSync(skillDir, { recursive: true, force: true }); // approveProposal writes it; nothing else cleans it up
    // Deleting the just-approved flow un-covers the pattern again — force one
    // more scan and dismiss it rather than leaving a resurrectable counter.
    logTurn(noise("apflow", 4), [a, b]);
    runReflection(4);
    rejectProposal(id);
  }
});

test("reject clears a proposal and prevents it from being re-proposed", () => {
  const kw = `zzzreject${rid}`;
  const id = `memory:${kw}`;
  for (let i = 0; i < 4; i++) logTurn(`${noise("reject", i)} ${kw} ${noise("reject", i)}z`, []);
  expect(runReflection(4).some((x) => x.id === id)).toBe(true);

  const res = rejectProposal(id);
  expect(res.ok).toBe(true);
  expect(loadProposals().some((x) => x.id === id)).toBe(false);

  logTurn(`${noise("reject", 4)} ${kw} ${noise("reject", 4)}z`, []);
  expect(runReflection(4).some((x) => x.id === id)).toBe(false);
  expect(loadProposals().some((x) => x.id === id)).toBe(false);
});

test("re-running with no new activity returns nothing new", () => {
  runReflection(4);
  expect(runReflection(4)).toEqual([]);
});
