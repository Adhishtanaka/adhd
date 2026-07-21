import { expect, test } from "bun:test";
import { specTools, type SpecItem } from "../src/loop.js";

// The tools' execute takes (input, options); options is unused here.
const run = (t: any, input: any) => t.execute(input, {} as any);
const allDone = (spec: SpecItem[]) => spec.length > 0 && spec.every((s) => s.done);

test("spec_set populates the RAM checklist, all unchecked", async () => {
  const spec: SpecItem[] = [];
  const { spec_set } = specTools(spec, () => {});
  await run(spec_set, { items: [{ title: "a", verify: "va" }, { title: "b", verify: "vb" }] });
  expect(spec.length).toBe(2);
  expect(spec.every((s) => !s.done)).toBe(true);
  expect(allDone(spec)).toBe(false);
});

test("spec_check flips the right item and drives completion", async () => {
  const spec: SpecItem[] = [];
  const { spec_set, spec_check } = specTools(spec, () => {});
  await run(spec_set, { items: [{ title: "a", verify: "va" }, { title: "b", verify: "vb" }] });

  await run(spec_check, { index: 1, note: "checked a" });
  expect(spec[0].done).toBe(true);
  expect(spec[0].note).toBe("checked a");
  expect(allDone(spec)).toBe(false); // b still open

  await run(spec_check, { index: 2 });
  expect(allDone(spec)).toBe(true); // now complete
});

test("spec_check with a bad index returns an error, does not throw", async () => {
  const spec: SpecItem[] = [];
  const { spec_set, spec_check } = specTools(spec, () => {});
  await run(spec_set, { items: [{ title: "a", verify: "va" }] });
  const out = await run(spec_check, { index: 9 });
  expect(out).toContain("no item at index 9");
  expect(spec[0].done).toBe(false);
});

test("spec_set replaces any prior checklist", async () => {
  const spec: SpecItem[] = [];
  const { spec_set } = specTools(spec, () => {});
  await run(spec_set, { items: [{ title: "old", verify: "v" }] });
  await run(spec_set, { items: [{ title: "new1", verify: "v" }, { title: "new2", verify: "v" }] });
  expect(spec.map((s) => s.title)).toEqual(["new1", "new2"]);
});
