import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";
import { cap, confirmAction } from "./tools.js";
import { loadConfig, setMcpServers, disabledTools, HOME_ROOT } from "./config.js";

// MCP (modelcontextprotocol.io) servers, so any tool someone else already wrote
// works here without adhd shipping a connector for it. Configured in config.json:
//
//   "mcpServers": {
//     "notes": { "command": "npx", "args": ["-y", "@some/notes-mcp"], "trust": "ask" }
//   }
//
// ponytail: stdio transport only — local processes are the local-first case, and
// they need no OAuth. HTTP/SSE servers are the upgrade if a remote one matters.
export type McpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // How much to trust this server's tools. Foreign tools arrive with schemas we
  // didn't write and side effects we can't infer from a name, so the default is
  // to ask before every call — the same gate bash gets. "read" means the server
  // only reads (a docs lookup, a search index) and may run unprompted.
  trust?: "ask" | "read";
};

// --- migration: Chrome is no longer an MCP server ---------------------------
// adhd used to seed chrome-devtools-mcp here, which put 29 tool schemas (~27k
// chars) into every single request — more context than the system prompt and
// every other tool combined. Chrome now lives in browser.ts as an internal
// engine behind the one `browser` tool, so the seeded server is removed. Run
// ONCE, ever: someone who adds it back by hand keeps it.
const MIGRATED_MARK = join(HOME_ROOT, ".mcp-seeded-v2");

/** Drop the old seeded Chrome server. Call before loadMcpTools(). */
export function migrateMcpDefaults(): void {
  if (existsSync(MIGRATED_MARK)) return;
  mkdirSync(HOME_ROOT, { recursive: true });
  const servers = loadConfig().mcpServers ?? {};
  // Only the entry we seeded — a hand-customised chrome server is left alone.
  if (servers.chrome?.args?.some((a) => a.includes("chrome-devtools-mcp"))) {
    const { chrome: _gone, ...rest } = servers;
    setMcpServers(rest);
  }
  writeFileSync(MIGRATED_MARK, new Date().toISOString());
}

// Tool names must survive the provider's [A-Za-z0-9_-] check and stay unique
// across servers, so they're namespaced rather than used bare.
export const toolName = (server: string, tool: string): string =>
  `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

// MCP returns a content array (text / image / resource parts). The model only
// ever gets text back from a tool here, so flatten to text and drop the rest.
export function contentToText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result ?? "");
  const text = content
    .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "unknown"}]`))
    .join("\n")
    .trim();
  return text || "(no output)";
}

// Connected clients, kept for the process lifetime. ponytail: no reconnect, no
// pooling — a server that dies stays dead until restart, which is the same deal
// as a user tool that fails to import.
const clients: Client[] = [];

// What each server actually offered at connect time, so Settings can list a
// server's tools instead of making you go read its docs. Filled by connect();
// survives a tool being switched off, because the switch is what you came to
// the list to flip.
export type McpToolInfo = { name: string; full: string; description: string };
const catalog: Record<string, McpToolInfo[]> = {};
export const mcpCatalog = (): Record<string, McpToolInfo[]> => catalog;

async function connect(name: string, spec: McpServer): Promise<Record<string, Tool>> {
  const client = new Client({ name: "adhd", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      // Inherit adhd's env so servers find PATH/HOME, plus whatever the config adds.
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
    }),
  );
  clients.push(client);

  const { tools } = await client.listTools();
  const out: Record<string, Tool> = {};
  const off = disabledTools();
  catalog[name] = tools.map((t) => ({
    name: t.name,
    full: toolName(name, t.name),
    description: t.description ?? "",
  }));
  for (const t of tools) {
    const full = toolName(name, t.name);
    // Switched off in Settings: still catalogued (so it can be switched back on)
    // but never handed to the model, so it costs no schema in the context.
    if (off.has(full)) continue;
    out[full] = dynamicTool({
      description: `[${name}] ${t.description ?? t.name}`,
      // The server's own JSON Schema, handed to the model as-is — there's no zod
      // shape to write because the tools aren't known until runtime.
      inputSchema: jsonSchema((t.inputSchema ?? { type: "object", properties: {} }) as any),
      execute: async (args) => {
        // trust:"read" normally skips the card; permission mode "ask" overrides
        // that and prompts anyway, and "auto" skips regardless (see tools.ts).
        const ok = await confirmAction(
          `${full}(${cap(JSON.stringify(args ?? {}), 200)})`,
          spec.trust === "read",
        );
        if (!ok) return "User declined this tool call.";
        try {
          return cap(contentToText(await client.callTool({ name: t.name, arguments: (args ?? {}) as any })));
        } catch (e) {
          return `MCP call failed: ${(e as Error).message}`;
        }
      },
    });
  }
  return out;
}

// One bad server must not stop adhd from starting, so failures are logged and
// skipped — same contract as loadUserTools.
export async function loadMcpTools(): Promise<Record<string, Tool>> {
  const servers = loadConfig().mcpServers ?? {};
  const out: Record<string, Tool> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec?.command) {
      console.error(`adhd: mcp server ${name} has no command, skipping`);
      continue;
    }
    try {
      Object.assign(out, await connect(name, spec));
    } catch (e) {
      console.error(`adhd: mcp server ${name} failed to start: ${(e as Error).message}`);
    }
  }
  return out;
}
