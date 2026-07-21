import { tool, type Tool } from "ai";
import { z } from "zod";

// Generative UI, json-render style but stack-native: the model calls render_ui
// with a flat-tree spec { root, elements: { id: { type, props, children } } };
// the browser maps node types to DOM (see public/app.js renderSpec). The AI SDK
// validates this schema and our agent retries malformed tool calls, so a bad
// spec self-corrects. Prose stays the default; this is for visual content.
const specSchema = z.object({
  root: z.string().describe("id of the top element in `elements`"),
  elements: z
    .record(
      z.object({
        type: z.string().describe("component type — one of the catalog below"),
        props: z.record(z.any()).optional(),
        children: z.array(z.string()).optional().describe("ids of child elements"),
      }),
    )
    .describe("id → element map"),
});

export type Spec = z.infer<typeof specSchema>;

let renderSink: (spec: Spec) => void = () => {};
export function setRenderSink(fn: (spec: Spec) => void): void {
  renderSink = fn;
}

export function renderUiTool(): Tool {
  return tool({
    description:
      "Render a rich visual block in the chat — images, an image gallery, a video, a mermaid diagram, cards, or a references/sources list. Use it for visual content and to cite web_search results as clickable references. For plain text answers, just write prose instead of calling this.",
    inputSchema: specSchema,
    execute: async (spec) => {
      renderSink(spec);
      const rootType = spec.elements?.[spec.root]?.type;
      const isMedia = rootType === "Image" || rootType === "Gallery" || rootType === "Video" || rootType === "Svg";
      // For MEDIA (image/gallery/video/svg): the picture goes first, and the model
      // SHOULD now write the details as normal prose below it. For structured
      // cards (Card/Table/Metric/Map): the card IS the answer — no prose after.
      return isMedia
        ? "Media shown — the user can see it. Now write the actual answer as normal prose BELOW it (the facts/details). " +
            "Do NOT describe the image itself ('the image above shows…') — just give the information."
        : "UI block rendered — the user can see it. If this was a content card, write NO further text at all: " +
            "no intro line, no wrap-up, no description of its contents. The card IS the whole answer — end your turn now with zero additional prose.";
    },
  });
}

// Injected into the system prompt so the model knows the component catalog.
export function catalogPromptSection(): string {
  return (
    "\n\nRich UI (render_ui): to show visual content, call render_ui with a spec " +
    "{ root, elements: { id: { type, props, children } } }. Component types and their props:\n" +
    "- Text { content } — a SHORT string (a caption, a label, one or two sentences); supports markdown (bold, inline code, small lists). Not for long explanations — those go in your prose answer, not here.\n" +
    "- Heading { level (1-3), content }\n" +
    "- Image { src, alt, caption? }\n" +
    "- Gallery {} with children of Image ids (a responsive image grid)\n" +
    "- Video { src, provider? ('youtube'|'vimeo'|'file') } — direct files play inline; youtube/vimeo load on click\n" +
    "- Card { title? } with children\n" +
    "- Grid {} with children (multi-column layout)\n" +
    "- List { ordered?, items: [string] }\n" +
    "- Link { href, label } (opens in a new tab)\n" +
    "- References { items: [{ title, url, snippet? }] } — a sources list; use this to cite web_search results\n" +
    "- FollowUps { items: [string] } — 3-4 short suggested next questions, shown as clickable chips the user can tap\n" +
    "- Mermaid { code } — a mermaid diagram (flowchart/sequence/etc.), best for flows and relationships\n" +
    "- Svg { code, background? } — a raw inline SVG illustration; best for spatial/visual explanations you draw yourself\n" +
    "- Table { columns:[…], rows:[[…]] } — tabular data / spreadsheets\n" +
    "- Metric { label, value, delta?, unit? } — a KPI/metric card\n" +
    "- Progress { value (0-100), label? } — a progress bar\n" +
    "- Map { markers:[{ lat, lng, label? } | { query, label? }], route?:{ from, to }, center? } — a map (only when a location is asked)\n" +
    'Example: { "root":"g", "elements": { "g":{"type":"Gallery","children":["i1","i2"]}, ' +
    '"i1":{"type":"Image","props":{"src":"https://…/a.jpg","alt":"…"}}, ' +
    '"i2":{"type":"Image","props":{"src":"https://…/b.jpg","alt":"…"}} } }\n' +
    "When something is clearer visually, SHOW it: an Svg for spatial/illustrative ideas, a Mermaid diagram for " +
    "flows/relationships, a Table for data — especially when the user asks you to explain or show a concept; " +
    "otherwise answer in prose. For reports or calculations, run_script to compute the numbers first, then render " +
    "Table/Metric inside a Card. To show a file the user already has, call search_files, then render an Image " +
    "or Video whose src is 'local://<absolute path>'. Use render_ui only when it genuinely helps.\n" +
    "Presentation (you are a visual answer engine, not a chat log): when a question is about a place, person, " +
    "product, landmark, animal, dish, event, or any topic that has a natural picture, PREFER showing it. Pull a " +
    "relevant image URL from web_fetch's `Images:` list or a web_search with type:'images', and render a bare Image (or " +
    "a Gallery when several good ones exist) — do NOT wrap it in a Card. Then write the actual answer as normal PROSE " +
    "below the image. A good answer usually = ONE render_ui Image/Gallery block first, then your prose details, then sources. " +
    "The image is the visual; the words go beneath it as ordinary text, not stuffed into a card.\n" +
    "When the user asks for a VIDEO, song, trailer, clip, or YouTube link, ALWAYS render a Video block (it embeds and " +
    "plays inline) with the watch URL as `src` — never just paste the link in prose. Find the URL with web_search " +
    "type:'videos' first if you don't have it.\n" +
    "Two hard rules to avoid repetition:\n" +
    "1. Cite sources ONCE. Emit at most a SINGLE References block per answer, at the very end. Never repeat the same " +
    "sources across multiple render_ui calls, and don't restate URLs in prose too.\n" +
    "2. Don't say the same thing twice, but DO answer. After MEDIA (Image/Gallery/Video/Svg), write your prose answer " +
    "below it — just don't narrate the picture ('the image above shows…'). After a STRUCTURED card that already carries " +
    "the whole answer (Card/Table/Map/Metric), write NO additional prose — the card is the answer; end the turn. " +
    "(References/FollowUps never count as content.)\n" +
    "render_ui is for VISUAL things — diagrams, images, tables, references, a metric or two. It is NOT a " +
    "container for a long written answer. Never pour multiple paragraphs of explanation into Text/Card nodes; the " +
    "written explanation is your normal prose reply. If your render_ui block is mostly words, it belongs in prose instead.\n" +
    "Images render at a fixed max height in the chat log — for 2+ images always use Gallery (hero + thumbnails) " +
    "rather than several separate Image blocks, so they display consistently.\n" +
    "End most answers with a FollowUps block of 3-4 natural next questions the user might ask (skip it only for pure " +
    "chit-chat or when there's no sensible follow-up). Put it after any References block."
  );
}
