import { expect, test } from "bun:test";
import { allowKeyFor, orAfter, asPreApproved, confirmAction, setBashConfirm } from "../src/tools.js";

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

// A prompt nobody answers used to hang forever, which left `busy` stuck true and
// wedged the scheduler (it skips every tick while busy). Unanswered must settle.
test("an unanswered prompt settles to the fallback and cleans up", async () => {
  let cleaned = false;
  const never = new Promise<boolean>(() => {});
  expect(await orAfter(never, 5, false, () => (cleaned = true))).toBe(false);
  expect(cleaned).toBe(true);
});

test("an answered prompt keeps its answer and never expires", async () => {
  let cleaned = false;
  const yes = Promise.resolve(true);
  expect(await orAfter(yes, 5, false, () => (cleaned = true))).toBe(true);
  await new Promise((r) => setTimeout(r, 20)); // past the deadline it must not fire
  expect(cleaned).toBe(false);
});

// Running a flow IS the approval for its steps, so a tool node must not raise a
// permission card. The scope has to be async-local: a chat turn running beside
// the flow still gets asked.
test("flow steps are pre-approved without leaking approval to concurrent work", async () => {
  const asked: string[] = [];
  setBashConfirm(async ({ command }) => {
    asked.push(command);
    return false;
  });
  const inFlow = asPreApproved(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return confirmAction("flow step");
  });
  const inChat = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    return confirmAction("chat step");
  })();
  expect(await inFlow).toBe(true);
  expect(await inChat).toBe(false);
  expect(asked).toEqual(["chat step"]);
});
