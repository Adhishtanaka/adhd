import { test, expect } from "bun:test";
import { plan, formatRead, shotPath, unwrapScript, ACTIONS } from "../src/browser.js";
import { HOME_ROOT } from "../src/config.js";

// browser.ts is mostly wiring around a live Chrome, which a unit test can't
// have. The two parts that carry real logic are pure and exported: the
// action → MCP-call mapping, and the read pipeline that turns a scraped page
// into what the model sees.

test("every action maps to an MCP call", () => {
  const args: Record<string, any> = {
    read: { url: "https://example.com" },
    snapshot: {},
    screenshot: {},
    fill: { values: [{ uid: "1", value: "x" }] },
    click: { uid: "1" },
    type: { text: "hi" },
    press: { key: "Enter" },
    eval: { script: "() => 1" },
  };
  for (const action of ACTIONS) {
    const p = plan({ action, ...args[action] });
    expect(typeof p, `${action} should plan, not error`).not.toBe("string");
    expect((p as any).calls.length).toBeGreaterThan(0);
  }
});

test("read navigates then extracts, in that order", () => {
  const p = plan({ action: "read", url: "https://example.com" }) as any;
  expect(p.calls.map((c: any) => c.name)).toEqual(["navigate_page", "evaluate_script"]);
  expect(p.calls[0].args).toMatchObject({ type: "url", url: "https://example.com" });
});

test("fill batches every field into one fill_form call", () => {
  // One call, not one per field — the whole reason fill takes a list.
  const values = [
    { uid: "1", value: "ada" },
    { uid: "2", value: "secret" },
  ];
  const p = plan({ action: "fill", values }) as any;
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]).toEqual({ name: "fill_form", args: { elements: values } });
});

test("a missing required arg returns a message, never throws", () => {
  // The model gets told what to pass; an exception would just abort the turn.
  expect(plan({ action: "read" })).toContain("url");
  expect(plan({ action: "click" })).toContain("uid");
  expect(plan({ action: "fill" })).toContain("values");
  expect(plan({ action: "type" })).toContain("text");
  expect(plan({ action: "press" })).toContain("key");
  expect(plan({ action: "eval" })).toContain("script");
});

test("screenshots land under HOME_ROOT so /local can serve them", () => {
  // /local refuses anything outside the allowed roots, and ~/.adhd is inside the
  // default one. Put shots elsewhere and they silently stop rendering.
  expect(shotPath(123)).toBe(`${HOME_ROOT}/shots/123.png`);
});

test("evaluate_script's envelope is unwrapped back to the real value", () => {
  // Left wrapped, the page arrives as one escaped blob with literal \n and every
  // paragraph-based step downstream (BM25 ranking, image extraction) sees garbage.
  const wrapped = 'Script ran on page and returned:\n```json\n"# Title\\n\\nA paragraph."\n```';
  expect(unwrapScript(wrapped)).toBe("# Title\n\nA paragraph.");
  // Non-string values stay readable rather than becoming "[object Object]".
  expect(unwrapScript('x\n```json\n{"a":1}\n```')).toBe('{\n  "a": 1\n}');
  // No envelope, or a broken one: pass it through rather than lose the output.
  expect(unwrapScript("plain text")).toBe("plain text");
  expect(unwrapScript("```json\nnot json\n```")).toBe("not json");
});

const PAGE = `# Widgets

Our widgets are blue and ship on Tuesday.

The company was founded in 1994 by two people in a garage.

Pricing starts at $9 a month.`;

test("read keeps only the paragraphs matching the query", async () => {
  const out = await formatRead(PAGE, "when do widgets ship");
  expect(out).toContain("ship on Tuesday");
  expect(out).not.toContain("garage"); // irrelevant paragraph dropped to save context
});

test("read with no query returns the whole cleaned page", async () => {
  const out = await formatRead(PAGE);
  expect(out).toContain("garage");
  expect(out).toContain("$9 a month");
});

test("an empty page says so instead of returning nothing", async () => {
  expect(await formatRead("")).toContain("empty");
  expect(await formatRead("   \n\n  ")).toContain("empty");
});

test("an image URL that doesn't serve an image never reaches the Images: list", async () => {
  // The in-page extractor emits `![alt](src)`, which extractImages already
  // parses — no second format to keep in sync. This URL 404s, so keepRealImages
  // drops it and no list is offered; otherwise the model cites a dead picture.
  const out = await formatRead(`${PAGE}\n\n![a blue widget](https://example.invalid/w.png)`);
  expect(out).not.toContain("Images:");
});
