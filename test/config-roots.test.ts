import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { isUnderRoots, isUnderRootsForWrite, allowedRoots } from "../src/config.js";

const dir = join(homedir(), ".adhd");

test("home is an allowed root by default", () => {
  expect(allowedRoots()).toContain(homedir());
});

test("accepts a real file under home, rejects escape and system paths", () => {
  mkdirSync(dir, { recursive: true });
  const ok = join(dir, "roots-test.txt");
  writeFileSync(ok, "x");
  expect(isUnderRoots(ok)).toBe(true);
  expect(isUnderRoots("/etc/passwd")).toBe(false); // exists but outside roots
  expect(isUnderRoots(join(homedir(), ".."))).toBe(false); // escapes home
  rmSync(ok);
});

test("rejects sensitive files even under an allowed root", () => {
  mkdirSync(dir, { recursive: true });
  const pem = join(dir, "roots-test.pem");
  writeFileSync(pem, "x");
  expect(isUnderRoots(pem)).toBe(false); // .pem is denylisted
  rmSync(pem);
});

test("write variant accepts a not-yet-created path under home, rejects escape", () => {
  const nested = join(dir, "roots-test-nested", "new-file.txt"); // parent dir doesn't exist yet
  expect(isUnderRootsForWrite(nested)).toBe(true);
  expect(isUnderRootsForWrite("/etc/roots-test-new.txt")).toBe(false);
  expect(isUnderRootsForWrite(join(homedir(), "..", "roots-test-new.txt"))).toBe(false); // escapes home
});
