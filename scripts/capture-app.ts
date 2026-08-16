import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const out = resolve("website/assets");
mkdirSync(out, { recursive: true });

const client = new Client({ name: "adhd-site-capture", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--channel=stable", "--isolated", "--viewport=1440x920", "--allow-unrestricted-paths"],
  env: process.env as Record<string, string>,
}));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError) throw new Error(JSON.stringify(result));
  return result;
};
const evaluate = (fn: string) => call("evaluate_script", { function: fn });
const shot = (name: string) => call("take_screenshot", { filePath: resolve(out, name), fullPage: false });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

await call("navigate_page", { type: "url", url: "http://127.0.0.1:8787", timeout: 20_000 });
await wait(1_200);
await shot("app-home.png");

await evaluate(`() => {
  const input = document.querySelector('#msg');
  input.value = 'Who is Lakshman Kadirgamar? Give me a concise overview and include reliable sources.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#composer').requestSubmit();
}`);

for (let frame = 1; frame <= 10; frame++) {
  await wait(frame === 1 ? 500 : 1_200);
  await shot(`demo-${String(frame).padStart(2, "0")}.png`);
  const state = await evaluate(`() => ({ busy: !document.querySelector('#status').classList.contains('hidden'), answers: document.querySelectorAll('.assistant-block').length })`);
  if (JSON.stringify(state).includes('"busy":false') && frame >= 4) break;
}
await wait(1_000);
await shot("app-answer.png");

await evaluate(`() => document.querySelector('#open-flows').click()`);
await wait(1_200);
await shot("app-flows.png");

await evaluate(`() => { document.querySelector('#flows-panel').classList.add('hidden'); document.querySelector('#open-settings').click(); }`);
await wait(800);
await shot("app-settings.png");

await client.close();
