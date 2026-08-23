import { expect, test } from "bun:test";
import { logUser, logAssistant, logToolCall, logToolResult, logUsage, logError, recentLogs, toolTotals } from "../src/toollog.js";

// Real ~/.adhd/logs.db, like failcache.test.ts uses the real fetch-failures.json —
// a few rows tagged with a fake session/tool are harmless residue in an activity log.
test("a turn's prompt, tool call, reply and usage all land under the same turn id", () => {
  const session = "__test_session__";
  const turn = logUser(session, "do the thing");
  const callId = crypto.randomUUID();
  logToolCall(session, turn, callId, "__test_tool__", { q: "hi" });
  logToolResult(callId, "ok");
  logUsage(session, turn, 42);
  logAssistant(session, turn, "done!");

  const rows = recentLogs().filter((r) => r.turn === turn);
  const kinds = rows.map((r) => r.kind).sort();
  expect(kinds).toEqual(["assistant", "tool", "usage", "user"].sort());

  const toolRow = rows.find((r) => r.kind === "tool")!;
  expect(toolRow.name).toBe("__test_tool__");
  expect(toolRow.content).toBe(JSON.stringify({ q: "hi" }));
  expect(toolRow.result).toBe("ok");
  expect(toolRow.tokens).toBe(42); // tagged with the step's usage

  const usageRow = rows.find((r) => r.kind === "usage")!;
  expect(usageRow.tokens).toBe(42); // also its own row, so a tool-less step isn't lost

  const totals = toolTotals().find((t) => t.tool === "__test_tool__");
  expect(totals?.calls).toBeGreaterThanOrEqual(1);
  expect(totals?.tokens).toBeGreaterThanOrEqual(42);
});

test("a result for an unknown call id is a no-op, not a crash", () => {
  expect(() => logToolResult(crypto.randomUUID(), "whatever")).not.toThrow();
});

test("a step with no tool calls still records its usage", () => {
  const session = "__test_session__";
  const turn = logUser(session, "just answer directly");
  logUsage(session, turn, 7); // no logToolCall in between — the earlier bug this guards against
  const rows = recentLogs().filter((r) => r.turn === turn && r.kind === "usage");
  expect(rows).toHaveLength(1);
  expect(rows[0].tokens).toBe(7);
});

test("errors land in the log too", () => {
  const session = "__test_session__";
  const turn = logUser(session, "trigger a failure");
  logError(session, turn, "boom");
  const rows = recentLogs().filter((r) => r.turn === turn && r.kind === "error");
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toBe("boom");
});
