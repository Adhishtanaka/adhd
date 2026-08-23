import { test, expect } from "bun:test";
import { carriesAnswer, renderUiTool, setTurnKey, type Spec } from "../src/render.js";

// Build a spec from [id, type, children?] triples; the first is the root.
const spec = (...nodes: [string, string, string[]?][]): Spec => ({
  root: nodes[0][0],
  elements: Object.fromEntries(nodes.map(([id, type, children]) => [id, { type, children }])),
});

test("a Card that merely frames an image is media — the answer still has to be written", () => {
  // The regression: asking about a person rendered a Card holding their photo,
  // a title and a link. Judging by the root type alone called that a finished
  // answer, so the model was told to write nothing and no facts ever appeared.
  const johnCena = spec(
    ["c", "Card", ["img", "t", "l"]],
    ["img", "Image"],
    ["t", "Text"],
    ["l", "Link"],
  );
  expect(carriesAnswer(johnCena)).toBe(false);
});

test("bare media never carries the answer", () => {
  for (const type of ["Image", "Gallery", "Video", "Svg", "Mermaid", "Map"]) {
    expect(carriesAnswer(spec(["r", type]))).toBe(false);
  }
});

test("structured content is the answer, including inside a Card", () => {
  expect(carriesAnswer(spec(["t", "Table"]))).toBe(true);
  expect(carriesAnswer(spec(["m", "Metric"]))).toBe(true);
  // The catalog prompt asks for Table/Metric wrapped in a Card for reports —
  // there the card genuinely is the whole answer.
  expect(carriesAnswer(spec(["c", "Card", ["t"]], ["t", "Table"]))).toBe(true);
});

test("structured content wins over media in the same block", () => {
  // A report with a chart beside its numbers: the numbers are the answer.
  expect(carriesAnswer(spec(["c", "Card", ["i", "t"]], ["i", "Image"], ["t", "Table"]))).toBe(true);
});

test("sources and follow-up chips are chrome, never the answer", () => {
  // Otherwise citing anything told the model to end its turn on the spot.
  expect(carriesAnswer(spec(["r", "References"]))).toBe(false);
  expect(carriesAnswer(spec(["f", "FollowUps"]))).toBe(false);
});

test("a Card of pure text carries its own answer", () => {
  expect(carriesAnswer(spec(["c", "Card", ["t"]], ["t", "Text"]))).toBe(true);
});

test("a second References block in the same turn is rejected, a new turn resets it", async () => {
  const tool = renderUiTool();
  const refs = spec(["r", "References"]);
  setTurnKey("turn-a");
  const first = await tool.execute!(refs, {} as any);
  expect(String(first)).not.toContain("Rejected");
  const second = await tool.execute!(refs, {} as any);
  expect(String(second)).toContain("Rejected");
  setTurnKey("turn-b");
  const third = await tool.execute!(refs, {} as any);
  expect(String(third)).not.toContain("Rejected");
});

test("a second FollowUps block in the same turn is rejected too, independently of References", async () => {
  const tool = renderUiTool();
  setTurnKey("turn-c");
  const followUps = spec(["f", "FollowUps"]);
  expect(String(await tool.execute!(followUps, {} as any))).not.toContain("Rejected");
  expect(String(await tool.execute!(followUps, {} as any))).toContain("Rejected");
  // References isn't shown yet this turn, so it still goes through.
  const refs = spec(["r", "References"]);
  expect(String(await tool.execute!(refs, {} as any))).not.toContain("Rejected");
});
