import { expect, test } from "bun:test";
import { rankChunks, extractImages } from "../src/extract.js";

test("extractImages keeps alt-bearing images, drops alt-less and icons, caps count", () => {
  const md = [
    "![Eiffel Tower at night](https://ex.com/eiffel.jpg)",
    "![](https://ex.com/no-alt.jpg)", // no alt → dropped
    "![logo](https://ex.com/logo.svg)", // icon-ish → dropped
    "![Seine river view](https://ex.com/seine.png)",
  ].join("\n\n");
  const imgs = extractImages(md, 8);
  expect(imgs.map((i) => i.src)).toEqual(["https://ex.com/eiffel.jpg", "https://ex.com/seine.png"]);
  expect(extractImages(md, 1).length).toBe(1); // limit respected
});

const doc = [
  "Welcome to our store. We sell shoes, hats, and bags for everyone.",
  "Our return policy allows refunds within 30 days of purchase with a receipt.",
  "Shipping is free on orders over fifty dollars and takes three to five days.",
  "Contact us on social media or visit any of our downtown locations.",
].join("\n\n");

test("returns the on-topic paragraph, not the intro", () => {
  const out = rankChunks(doc, "how do refunds and returns work", 10_000);
  expect(out).toContain("return policy");
  expect(out).toContain("30 days");
  expect(out).not.toContain("Welcome to our store");
});

test("respects the budget by dropping lower-ranked chunks", () => {
  const out = rankChunks(doc, "return policy shipping", 90);
  expect(out.length).toBeLessThanOrEqual(90);
  // the single best chunk (return policy) should win the tight budget
  expect(out).toContain("return policy");
});

test("keeps selected chunks in original document order", () => {
  const out = rankChunks(doc, "shipping refunds", 10_000);
  expect(out.indexOf("return policy")).toBeLessThan(out.indexOf("Shipping is free"));
});

test("empty query returns empty (caller falls back)", () => {
  expect(rankChunks(doc, "", 10_000)).toBe("");
});

test("query with no matching terms returns empty (caller falls back)", () => {
  expect(rankChunks(doc, "quantum astrophysics telescope", 10_000)).toBe("");
});
