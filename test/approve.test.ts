import { expect, test } from "bun:test";
import { allowKeyFor } from "../src/tools.js";

test("plain commands yield a runner-scoped program key", () => {
  expect(allowKeyFor("bash", "git status")).toBe("bash:git");
  expect(allowKeyFor("bash", "  ls -la  ")).toBe("bash:ls");
  expect(allowKeyFor("pwsh", "Get-ChildItem")).toBe("pwsh:Get-ChildItem");
  expect(allowKeyFor("bash", "/usr/bin/uptime")).toBe("bash:/usr/bin/uptime");
});

// The whole point of the key: an allowed name must never be able to carry a
// second program along with it.
test("anything that can smuggle a second command is not blanket-allowable", () => {
  for (const cmd of [
    "ls && rm -rf ~",
    "ls; rm -rf ~",
    "ls || rm -rf ~",
    "ls | xargs rm",
    "echo $(rm -rf ~)",
    "echo `rm -rf ~`",
    "cat < /etc/passwd",
    "ls > out.txt",
    "ls\nrm -rf ~",
  ])
    expect(allowKeyFor("bash", cmd)).toBeNull();
});

test("bash:git does not grant pwsh:git", () => {
  expect(allowKeyFor("pwsh", "git status")).not.toBe(allowKeyFor("bash", "git status"));
});
