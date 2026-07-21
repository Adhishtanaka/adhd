import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/tools.js";

// Exercises the grep tool contract regardless of which path runs: ripgrep when
// installed, the JS-walk fallback when it isn't (e.g. CI without rg).
const grep = (builtinTools().grep as any).execute;

test("grep finds a matching line with file:line, and reports misses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(dir, "a.txt"), "hello world\nsecond line\n");

  const hit = await grep({ pattern: "second", path: dir });
  expect(hit).toContain("a.txt");
  expect(hit).toContain("second line");

  const miss = await grep({ pattern: "nonexistent-xyzzy", path: dir });
  expect(miss).toBe("no matches");
});
