import { expect, test } from "bun:test";
import { toolName, contentToText } from "../src/mcp.js";

// Names come from a foreign server, so they can carry anything. The provider
// only accepts [A-Za-z0-9_-], and two servers may both expose "search".
test("tool names are namespaced and provider-safe", () => {
  expect(toolName("notes", "search")).toBe("notes_search");
  expect(toolName("notes", "search")).not.toBe(toolName("docs", "search"));
  expect(toolName("my server", "get:thing/v2")).toBe("my_server_get_thing_v2");
  expect(toolName("x", "y".repeat(100)).length).toBeLessThanOrEqual(64);
});

test("MCP content parts flatten to text the model can read", () => {
  expect(contentToText({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  expect(contentToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  // Non-text parts are named, not dropped silently — the model should know an
  // image came back rather than see nothing.
  expect(contentToText({ content: [{ type: "image", data: "…" }] })).toBe("[image]");
  expect(contentToText({ content: [] })).toBe("(no output)");
});
