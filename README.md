# ADHD

adhd is your own AI assistant that runs entirely on your machine. It plans, writes, researches, handles files, remembers what matters, and automates the things you do over and over, built for everyday work, not for writing code. 

It runs on Bun, talks to DeepSeek through the AI SDK, and serves a ChatGPT-style web UI on 127.0.0.1. From a single chat box it reads and writes files, runs shell commands, searches and fetches the web, remembers facts across sessions, schedules tasks, and delegates work to subagents, with every tool call shown live as it happens. And when a task is worth repeating, you can draw it once as a visual Flow and run it on demand, on a schedule, or by asking in chat.

```
▌ you  find nearby restaurants

✓ recall       user/location
✓ web_search   places · "restaurants Homagama, Sri Lanka"
✓ web_fetch    https://…/the-one-it-picked
Here are a few near you: …
```

Everything stays on your machine: one Bun process, no database, no framework, no cloud but the model API you point it at. API keys never leave `127.0.0.1`.

## Quick start

```bash
bun install
bun start          # serves + opens http://127.0.0.1:8787
```

Add your DeepSeek key in **Settings** (or drop it in `.env` first — see [Configuration](#configuration)), and start chatting. On first launch adhd seeds a few example Flows so there's something to run.

- **Standalone binary:** `bun run build` compiles `./adhd` (run it from a directory that has `public/` beside it).
- **Tests:** `bun test`.

## What it can do

- **Streams** answers with a live, collapsible trace of every tool call.
- **Falls back** to the next model when one is rate-limited, mid-turn, without losing work or re-running tools.
- **Renders rich replies** — images and galleries, inline video, tables, charts, metric cards, progress bars, [Mermaid](https://mermaid.js.org) diagrams, hand-drawn SVGs, and maps with directions ([MapTiler](https://maptiler.com) tiles, [Leaflet](https://leafletjs.com) + OSRM). Image URLs are verified to actually serve an image before being shown or handed to the model.
- **Shows your own local files** (images, video, docs) inline, from folders you explicitly allow.
- **Remembers** durable facts across sessions as [OKF](https://okf.md/spec/) markdown under `~/.adhd/memory/`.
- **Schedules tasks** that fire while adhd is open, with desktop notifications.
- **Builds visual Flows** — prompt, condition, and tool steps you wire, save, run (with pause/stop), schedule, or trigger from chat.
- **Loads skills** — instruction packs the model picks up on demand.
- **Delegates** big self-contained subtasks to subagents, or grinds a hard task across passes with `loop_task`.
- **Light, dark, and system** themes.

Anything that changes your machine (`bash`, `powershell`, `run_script`) asks for a yes/no in the UI first — including inside subagents, Flows, and scheduled runs. Approving with "always allow" remembers that *program* (`bash:git`), never a whole command line, and is offered only for a single plain command — anything that could smuggle a second one (`ls && rm -rf ~`) is one-time approval only. A prompt nobody answers within 5 minutes declines itself, so a scheduled run that fires while you're away fails safely instead of hanging.

## Architecture

One Bun process serves the UI, streams each turn over SSE, and runs the agent in-process.

```mermaid
flowchart TB
  subgraph browser["Browser — public/"]
    ui["index.html + app.js<br/>SSE transcript · composer · spec renderer"]
    flow["flow.js<br/>React Flow canvas (Flows)"]
  end

  subgraph server["Server — src/"]
    web["web.ts · Bun.serve<br/>SSE stream · chat / settings / flows routes · scheduler tick"]
    setup["setup.ts · buildAgent()<br/>assembles config + models + tools + prompt"]
    agent["agent.ts · turn loop<br/>fallback chain · retries · history compaction"]
    tools["tools.ts<br/>files · shell · web_search · web_fetch"]
    flows["flows.ts<br/>graph runner · run_flow"]
    render["render.ts<br/>render_ui + component catalog"]
    extra["memory.ts · skills.ts · scheduler.ts<br/>subagent.ts · loop.ts · failcache.ts"]
    san["sanitize.ts<br/>strips injection vectors"]
  end

  ui -- "POST /chat" --> web
  flow -- "POST /flows · /flows/run · /flows/control" --> web
  web -- "SSE: text · tool-call · render_ui · flow · done" --> ui
  web --> setup
  setup --> agent
  agent --> tools
  agent --> extra
  agent --> render
  agent --> flows
  flows --> tools
  render --> web
  web --> san
  san --> ui
```

Guards on the loopback server: only loopback `Host` headers are accepted (DNS-rebinding), state-changing requests must be same-origin (CSRF), and local files are served only from allowed roots with a locked-down CSP.

## How the system prompt is built

Assembled once at startup, from five parts. The same string goes to the main agent and to every subagent.

```mermaid
flowchart LR
  base["BASE_SYSTEM<br/><i>setup.ts</i><br/>role · research + shell discipline"]
  cat["catalogPromptSection()<br/><i>render.ts</i><br/>render_ui component catalog"]
  env["envSection()<br/><i>setup.ts</i><br/>OS · user · cwd · datetime"]
  sk["skillsPromptSection()<br/><i>skills.ts</i><br/>skill names + descriptions"]
  mem["memoryPromptSection()<br/><i>memory.ts</i><br/>memory ids + summaries"]

  base --> sum(("system<br/>prompt"))
  cat --> sum
  env --> sum
  sk --> sum
  mem --> sum
  sum --> a["Agent + subagents"]
```

`config.systemPrompt` replaces `BASE_SYSTEM`; the other four are always appended. Skill and memory *bodies* aren't included — only names and one-line descriptions, so the model knows what it can pull in with `use_skill` and `recall`.

## The turn loop

Text and tool calls stream together. Finished steps go into a per-turn buffer, so if a model gets rate-limited mid-turn adhd switches to the next one in the chain and replays the buffer instead of re-running tools.

```mermaid
flowchart TD
  msg(["Your message"]) --> push["push to history · compact to historyBudget"]
  push -. "over budget" .-> sum["summarize oldest messages<br/>into a running summary"]
  sum --> push
  push --> stream["streamText — model emits text + tool calls"]
  stream --> q{"Tool call?"}
  q -- "yes" --> run["run tool → buffer the step (pendingTurn)"]
  run --> stream
  q -- "no" --> done(["done — render markdown + rich blocks"])
  stream -. "rate limited" .-> next["retire model, move to next in chain"]
  next --> replay["replay pendingTurn as context"]
  replay --> stream
```

Guards: `maxRetries: 0` (adhd owns retries, not the SDK), `stepCountIs(12)` max tool steps per turn, and history that's **compacted, not dropped** — when it outgrows `historyBudget` the oldest messages are summarized into a running summary (folded into the system prompt) instead of being discarded, so the model keeps the gist of the earlier conversation. Tool-call/result pairs stay intact either way.

Long tool calls don't hold the turn open: a tool that blows its deadline hands back a "backgrounded" note so the UI goes idle and you can keep chatting. When the work lands, its result wakes the agent as a fresh turn — and several jobs finishing close together are coalesced into a single turn, so a burst of backgrounded fetches produces one reply, not one per job.

## Flows

A **Flow** is a saved workflow you draw on a canvas — [n8n](https://n8n.io)-style, but each node is a plain function, not an agent. Open it from the **Flows** button in the header.

The canvas is [React Flow](https://reactflow.dev), loaded from a pinned CDN via an import map — no build step, in keeping with the rest of the frontend. The graph runs **server-side** in [`flows.ts`](src/flows.ts) and is stored as JSON in `~/.adhd/flows.json`.

Data flows along the edges: each node takes the previous node's output as its input and passes its own output on. `{{prev}}` anywhere in a field is replaced by that input. Without a placeholder, the input is appended (for prompt/if/switch text) or left untouched (for tool arguments).

```mermaid
flowchart LR
  s(["Start"]) --> t["Tool<br/>web_search"]
  t --> sw{"Switch<br/>sentiment"}
  sw -- "positive" --> p["Prompt<br/>thank them"]
  sw -- "negative" --> n["Prompt<br/>apologize + refund"]
  sw -- "else" --> o["Prompt<br/>acknowledge"]
  p --> e(["End"])
  n --> e
  o --> e
```

| Node | What it does |
|------|--------------|
| **Start / End** | Mark where the run begins and where it stops. Start is the explicit entry point; End halts the walk. |
| **Prompt** | One model call, **no tools** — deterministic by design, so a step can't wander off doing its own research. Optional *Use saved memory* toggle folds in what adhd knows about you (off by default). |
| **If** | Asks the model a yes/no question about the input and follows the matching edge. |
| **Switch** | Multi-way branch: the model sorts the input into one of your named cases (plus an automatic `else`) and follows that case's edge. Each case is its own output handle. |
| **Tool** | Runs exactly one tool. Argument fields are read straight from the tool's own schema — required fields marked, defaults applied, enums become dropdowns. Shell tools still ask for approval. |
| **Merge** | Fan-in: wire several nodes into it and it **waits for all of them**, then joins their outputs into labeled sections (`## 1`, `## 2`, …) for the next node — usually a Prompt. The counterpart to fan-out, where one node feeds several. |

A node with several outgoing edges **fans out** — every branch runs — and a **Merge** node fans them back in. This is what a "combine a few tool outputs, then write one report" flow looks like:

```mermaid
flowchart LR
  s(["Start"]) --> a["Tool<br/>web_fetch · news"]
  s --> b["Tool<br/>web_fetch · weather"]
  a --> m["Merge<br/>combine inputs"]
  b --> m
  m --> p["Prompt<br/>write daily report"]
  p --> e(["End"])
```

Runs stream over the same SSE channel as chat: each node lights up, reports its duration, and logs its output. A run can be **paused, resumed, or stopped** mid-flight. A built-in 30-step cap stops any accidental cycle instead of hanging.

**Three ways to run a Flow:**

- The **Run** button on the canvas.
- Ask in chat — the agent calls the `run_flow` tool by name.
- Schedule it — add a task whose prompt is `flow:<id>` (Settings → Schedule).

Example Flows (Morning brief, Umbrella check, File → todo list) are seeded **once**, on first run only. Delete them and they stay deleted; your own Flows are never touched.

## Tools

| Tool | What it does | Asks first |
|------|--------------|:---------:|
| `read_file` / `write_file` | Read or write a text file | — |
| `list_dir` / `grep` / `glob` | List, regex-search, or glob for files | — |
| `bash` / `powershell` | Run a shell command | yes |
| `run_script` | Write and run a Bun/TypeScript snippet | yes |
| `web_search` | Google via [Serper](https://serper.dev) — web, images, videos, places, shopping, news | — |
| `web_fetch` | Read a URL as clean markdown; `query` returns only the relevant parts | — |
| `search_files` | Find your own local images/videos/docs to show | — |
| `remember` / `recall` | Save or load durable memory | — |
| `schedule` | Add, list, or remove scheduled tasks | — |
| `use_skill` | Load a skill's full instructions | — |
| `spawn_agent` | Delegate a self-contained subtask to a subagent (depth 1 — subagents can't spawn) | — |
| `loop_task` | Iterate a hard task across multiple passes | yes |
| `run_flow` | Run a saved Flow by name | — |
| `render_ui` | Draw a rich block — image, gallery, table, chart, map, sources | — |
| `ask_user` | Ask a multiple-choice question | interactive |

Flow **tool nodes** get the same file/shell/web tools (minus `spawn_agent` / `loop_task` / `run_flow`, so a Flow can't recurse into another). Flow **prompt nodes** get no tools at all.

## Configuration

### Environment

Create a `.env` in the project root:

```bash
DEEPSEEK_API_KEY=sk-...   # required — the model
SERPER_API_KEY=...        # optional — enables web_search
MAPTILER_KEY=...          # optional — map tiles (falls back to OpenStreetMap)
ADHD_PORT=8787            # optional — server port, default 8787
```

`DEEPSEEK_API_KEY` and `SERPER_API_KEY` can instead be set in **Settings**, which stores them in `~/.adhd/secrets.json` (`chmod 600`). These keys are never sent back to the browser. `MAPTILER_KEY` is a public client-side map key, so it *does* reach the browser — restrict it by domain in the MapTiler dashboard.

### config.json

Merged from `~/.adhd/config.json`, then `./.adhd/config.json` (project wins). All optional:

```jsonc
{
  "model": "deepseek-v4-flash",  // or "deepseek-v4-pro"
  "fallbackModel": [],           // string or string[]; [] = no fallback
  "baseURL": "https://api.deepseek.com",
  "historyBudget": 60000,        // max chars of chat history per request (~4 chars/token)
  "systemPrompt": "...",         // replaces BASE_SYSTEM
  "localRoots": ["/path/..."],   // folders the local-file tools may read (default: home)
  "allowedCommands": ["bash:git"]// "always allow" keys added via the approval prompt
}
```

### State on disk (`~/.adhd/`)

| Path | What |
|------|------|
| `secrets.json` | API keys (`chmod 600`) |
| `config.json` | the settings above |
| `memory/` | durable memories, one OKF markdown file each |
| `schedule.json` | scheduled tasks |
| `flows.json` | saved Flows |
| `tools/<name>.ts` | your custom tools |
| `skills/<name>/SKILL.md` | your skills |

### Extending

- **Tools:** drop `~/.adhd/tools/<name>.ts` that default-exports an AI SDK `tool()` — the filename becomes the tool name, and it's available in chat and as a Flow tool node.
- **Skills:** add `~/.adhd/skills/<name>/SKILL.md` with `name` and `description` frontmatter; the model loads the body on demand with `use_skill`.

## License

[MIT](LICENSE) © 2026 Adhishtanaka Kulasooriya
