import { test, expect } from "bun:test";
import { CAPABILITIES, splitSpec, PROVIDER_KEY, KNOWN_MODELS, tableContext, autoBudget } from "../src/config.js";

// The capability filter itself lives in setup.ts (not exported — it closes over
// buildAgent's tool map), so this pins the table it reads and the rules around
// it. The filter is one Object.fromEntries; the parts that can silently rot are
// the mappings.

test("every capability defaults to on", () => {
  for (const [k, v] of Object.entries(CAPABILITIES)) expect(v, `${k} should default on`).toBe(true);
});

test("a model spec routes to the provider whose key it needs", () => {
  expect(splitSpec("deepseek-v4-flash")).toEqual(["deepseek", "deepseek-v4-flash"]);
  expect(splitSpec("anthropic:claude-sonnet-5")).toEqual(["anthropic", "claude-sonnet-5"]);
  expect(splitSpec("google:gemini-3.1-pro")).toEqual(["google", "gemini-3.1-pro"]);
  // An unknown prefix isn't a provider — treat the whole thing as a DeepSeek id
  // rather than inventing a provider that has no key and no client.
  expect(splitSpec("weird:thing")).toEqual(["deepseek", "weird:thing"]);
  // Only the FIRST colon splits, so an id containing one survives.
  expect(splitSpec("custom:org/model:v2")).toEqual(["custom", "org/model:v2"]);
});

test("every suggested model names a provider that has a key entry", () => {
  // The /state filter hides a model when its key is unset; that only works if
  // every suggestion maps to a real key name.
  for (const m of KNOWN_MODELS) {
    const [provider] = splitSpec(m);
    expect(PROVIDER_KEY[provider], `${m} has no key mapping`).toBeTruthy();
  }
});

test("context windows resolve by longest prefix, not first match", () => {
  // "claude-" would match haiku too; the longer, more specific prefix must win
  // or a 200k model gets budgeted like a 1M one.
  expect(tableContext("anthropic:claude-haiku-4-5")).toBe(200_000);
  expect(tableContext("anthropic:claude-sonnet-5")).toBe(1_000_000);
  expect(tableContext("deepseek-v4-flash")).toBe(1_000_000);
  // Dated snapshots still resolve, since it's a prefix test.
  expect(tableContext("anthropic:claude-haiku-4-5-20251001")).toBe(200_000);
  // Unknown model: the conservative default, never the biggest guess.
  expect(tableContext("custom:some-local-llama")).toBe(128_000);
});

test("the auto budget is capped, so a 1M model can't 10x the per-turn bill", () => {
  expect(autoBudget(1_000_000)).toBe(400_000); // 25% would be 1M chars; capped
  expect(autoBudget(200_000)).toBe(200_000);
  expect(autoBudget(8_000)).toBe(40_000); // floor: a tiny model still gets a usable thread
});
