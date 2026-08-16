import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const out = resolve("website/assets");
mkdirSync(out, { recursive: true });

const client = new Client({ name: "adhd-site-capture", version: "0.2.0" });
await client.connect(new StdioClientTransport({
  command: "npx",
  args: [
    "-y", "chrome-devtools-mcp@latest", "--headless", "--channel=stable",
    "--isolated", "--viewport=1920x1200", "--allow-unrestricted-paths",
    "--no-usage-statistics", "--no-performance-crux",
  ],
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

async function send(message: string, slug: string) {
  const counts = await evaluate(`() => 'COUNTS=' + document.querySelectorAll('.usermsg').length + ':' + document.querySelectorAll('.assistant-block').length`);
  const raw = JSON.stringify(counts);
  const [, userCount = "0", answerCount = "0"] = raw.match(/COUNTS=(\d+):(\d+)/) ?? [];
  const users = Number(userCount);
  const answers = Number(answerCount);
  const submit = () => evaluate(`() => {
    const input = document.querySelector('#msg');
    input.value = ${JSON.stringify(message)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();
  }`);
  await submit();
  let accepted = false;
  let lastCount = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    await wait(500);
    const result = await evaluate(`() => 'COUNT=' + document.querySelectorAll('.usermsg').length`);
    lastCount = JSON.stringify(result);
    if (lastCount.includes("COUNT=" + (users + 1))) { accepted = true; break; }
    if (attempt === 7) await submit();
  }
  if (!accepted) throw new Error(`Prompt was not accepted: ${slug}; before=${raw}; after=${lastCount}`);
  await evaluate(`() => { const log = document.querySelector('#log'); log.lastElementChild?.scrollIntoView({ block: 'end' }); log.scrollTop = 1e9; }`);
  await shot(`${slug}-working.png`);
  for (let second = 0; second < 90; second++) {
    await wait(1_000);
    const result = await evaluate(`() => document.querySelector('#status').classList.contains('hidden') && document.querySelectorAll('.assistant-block').length > ${answers} ? 'DONE' : 'BUSY'`);
    if (JSON.stringify(result).includes("DONE")) {
      await wait(1_200);
      await evaluate(`() => { const log = document.querySelector('#log'); log.lastElementChild?.scrollIntoView({ block: 'end' }); log.scrollTop = 1e9; }`);
      await wait(600);
      await shot(`${slug}.png`);
      return;
    }
  }
  throw new Error(`Timed out waiting for ${slug}`);
}

await call("navigate_page", { type: "url", url: "http://127.0.0.1:8787", timeout: 20_000 });
// The app bundle includes Mermaid, Leaflet and the Flow canvas; wait for the
// composer listener and model state, not merely the first HTML paint.
for (let ready = 0; ready < 30; ready++) {
  const result = await evaluate(`() => document.querySelector('#model-select').options.length > 0 && document.querySelector('#send').innerHTML.length > 0 ? 'READY' : 'LOADING'`);
  if (JSON.stringify(result).includes("READY")) break;
  await wait(500);
}
await wait(1_000);
await shot("app-home-hd.png");

await send("Who was Princess Diana? Give me a concise overview with reliable sources.", "diana-01-who");
await send("Where did she die?", "diana-02-where");
await send("Find a good restaurant near that place for me to visit.", "diana-03-restaurant");
await send("Before I visit, show me images of the first restaurant you recommended.", "diana-04-images");

await evaluate(`() => document.querySelector('#new-chat').click()`);
await wait(800);
await send("Find the 'Attention Is All You Need' PDF on my computer and open it for me.", "pdf-local-file");

await evaluate(`() => document.querySelector('#open-flows').click()`);
await wait(1_200);
await shot("app-flows-hd.png");

await evaluate(`() => { document.querySelector('#flows-panel').classList.add('hidden'); document.querySelector('#open-settings').click(); }`);
await wait(900);
await shot("app-settings-hd.png");

await client.close();
