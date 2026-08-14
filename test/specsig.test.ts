import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// specSig lives in the browser bundle (app.js is a browser module with imports at the top, not
// a module), so lift it out by marker and eval it rather than duplicating it.
const src = readFileSync(join(import.meta.dir, "..", "web", "src", "app.js"), "utf8");
const body = src.slice(src.indexOf("// SPEC_SIG_START"), src.indexOf("// SPEC_SIG_END"));
const specSig = new Function(body + "\nreturn specSig;")() as (s: any) => string;

const card = (ids: [string, string], title: string) => ({
  root: ids[0],
  elements: {
    [ids[0]]: { type: "Card", props: { title }, children: [ids[1]] },
    [ids[1]]: { type: "Text", props: { content: "hello" } },
  },
});

test("same card with fresh element ids dedupes", () => {
  expect(specSig(card(["c1", "t1"], "Weather"))).toBe(specSig(card(["card9", "txt9"], "Weather")));
});

test("prop key order doesn't matter", () => {
  const a = { root: "m", elements: { m: { type: "Metric", props: { label: "x", value: 1 } } } };
  const b = { root: "m", elements: { m: { type: "Metric", props: { value: 1, label: "x" } } } };
  expect(specSig(a)).toBe(specSig(b));
});

test("server-derived props.html is ignored", () => {
  const a = { root: "t", elements: { t: { type: "Text", props: { content: "hi" } } } };
  const b = { root: "t", elements: { t: { type: "Text", props: { content: "hi", html: "<p>hi</p>" } } } };
  expect(specSig(a)).toBe(specSig(b));
});

test("genuinely different cards still render", () => {
  expect(specSig(card(["c1", "t1"], "Weather"))).not.toBe(specSig(card(["c1", "t1"], "Traffic")));
});

test("a cyclic spec terminates", () => {
  const cyc = {
    root: "a",
    elements: { a: { type: "Card", children: ["b"] }, b: { type: "Card", children: ["a"] } },
  };
  expect(specSig(cyc)).toContain("Card");
});
