import { expect, test } from "bun:test";
import { sep } from "node:path";
import { parse, serialize, memoryPath, MEMORY_DIR } from "../src/memory.js";

test("serialize → parse round-trips and stays OKF-conformant", () => {
  const md = serialize({
    type: "preference",
    title: "Indentation",
    description: "prefers tabs over spaces",
    tags: ["style", "editor"],
    timestamp: "2026-07-18T00:00:00.000Z",
    body: "# Detail\nAlways use tabs.",
  });
  expect(md).toMatch(/^---\n[\s\S]*?\n---\n/);
  expect(md).toContain("type: preference");

  const m = parse(md, "preferences/indent");
  expect(m.id).toBe("preferences/indent");
  expect(m.type).toBe("preference");
  expect(m.tags).toEqual(["style", "editor"]);
  expect(m.timestamp).toBe("2026-07-18T00:00:00.000Z");
  expect(m.body).toBe("# Detail\nAlways use tabs.");
});

test("parse tolerates missing frontmatter (type defaults non-empty)", () => {
  const m = parse("just a body", "loose");
  expect(m.type).toBe("note");
  expect(m.body).toBe("just a body");
});

test("memoryPath allows valid ids and blocks path traversal", () => {
  expect(memoryPath("preferences/style")).toBe(`${MEMORY_DIR}${sep}preferences${sep}style.md`);
  expect(memoryPath("../../etc/passwd")).toBeNull();
  expect(memoryPath("/etc/passwd")).toBeNull();
  expect(memoryPath("a/../../b")).toBeNull();
});
