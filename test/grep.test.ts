import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/tools.js";

// Exercises the grep tool contract regardless of which path runs: ripgrep when
// installed, the JS-walk fallback when it isn't (e.g. CI without rg).
const grep = (builtinTools().grep as any).execute;

test("grep finds a matching line with file:line, and reports misses", async () => {
  // Under ~/.adhd, not the OS tmpdir — grep is confined to the allowed roots
  // (home by default), and /var/folders/... isn't one of them.
  const scratch = join(homedir(), ".adhd");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "grep-"));
  writeFileSync(join(dir, "a.txt"), "hello world\nsecond line\n");

  try {
    const hit = await grep({ pattern: "second", path: dir });
    expect(hit).toContain("a.txt");
    expect(hit).toContain("second line");

    const miss = await grep({ pattern: "nonexistent-xyzzy", path: dir });
    expect(miss).toBe("no matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
