// adhd web UI — SSE transcript, composer, and a React generative-UI renderer
// (json-render: a flat spec tree dispatched through a component REGISTRY).
// HTMX drives settings/memory/schedule/failures/roots forms; the transcript
// itself stays imperative (append-only log); this file owns the conversation +
// rich rendering.
import React from "react";
import * as ReactDOM from "react-dom/client";
import L from "leaflet";
import htmx from "htmx.org";
import mermaid from "mermaid";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Leaflet normally sniffs its marker images out of the stylesheet's url(); the
// bundler rewrites those to hashed/inlined URLs, which defeats the sniff. Hand
// it the resolved URLs instead, or every L.marker() renders as a broken image.
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

// mermaid stays on window: applyTheme() feature-detects it (it used to be a CDN
// script that might not have loaded yet) and re-initialises on every theme flip.
window.mermaid = mermaid;

const log = document.getElementById("log");
const chatArea = document.getElementById("chat-area");
const setHome = (on) => chatArea.classList.toggle("home", on);
const msg = document.getElementById("msg");
const composer = document.getElementById("composer");
const sendBtn = document.getElementById("send");
const modelEl = document.getElementById("model-select");
const connEl = document.getElementById("conn");
const nokey = document.getElementById("nokey");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");

let busy = false;
let maptilerKey = ""; // filled from /state; empty → maps fall back to OSM tiles
let turnAssistants = [];
let shownSources = new Set(); // source URLs already cited this turn — dedupe repeats
let shownSpecs = new Set(); // render_ui specs already drawn this turn — dedupe repeats
let contentCardThisTurn = false; // a card carried the answer — trim prose to a one-line intro
let floatBottom = []; // sources / follow-up blocks — always moved below the answer at turn end
let current = null;
let labeledThisTurn = false;
let specRoots = []; // mounted React roots for render_ui blocks — unmounted on "New chat"
let toolSummary = null; // the current turn's collapsible tool-activity wrapper, lazily created
let turnStartTime = null;

// ---- theme (light / dark / system) ----
// The pre-paint script in index.html already set data-theme from localStorage;
// here we react to changes and keep mermaid's theme in sync.
const isLightNow = () => {
  const t = document.documentElement.dataset.theme;
  if (t === "light") return true;
  if (t === "dark") return false;
  return matchMedia("(prefers-color-scheme: light)").matches; // system
};
function initMermaid() {
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: isLightNow() ? "default" : "dark", securityLevel: "strict" });
}
function applyTheme(pref) {
  // pref: "light" | "dark" | "system"
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  localStorage.setItem("theme", pref);
  initMermaid(); // new diagrams pick up the current theme; already-rendered ones keep their look
}
window.applyTheme = applyTheme;
window.currentThemePref = () => localStorage.getItem("theme") || "system";
// keep system mode live if the OS theme flips while the app is open
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (window.currentThemePref() === "system") initMermaid();
});
initMermaid();

// Stay pinned to the bottom while the answer streams — and keep it pinned as
// that content GROWS after it was appended: images decode, React mounts, mermaid
// and Leaflet fill in async, a tool summary expands. Checking atBottom() only at
// append time (what we used to do) missed all of that and left the view stranded
// mid-transcript. `pinned` flips false the moment the user scrolls up, so we
// never fight them for the scrollbar; scrolling back down re-arms it.
const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 90;
let pinned = true;
log.addEventListener("scroll", () => (pinned = atBottom()));
const stickBottom = () => {
  if (pinned) log.scrollTop = log.scrollHeight;
};
const growth = new ResizeObserver(stickBottom);
function add(node) {
  node.classList?.add("entry");
  log.appendChild(node);
  growth.observe(node); // follow this block as it fills in later
  stickBottom();
  return node;
}
function el(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function block(label, node) {
  const wrap = el("assistant-block");
  wrap.append(el("eyebrow mb-1.5", label), node);
  return wrap;
}
const localUrl = (src) => (String(src).startsWith("local://") ? "/local?path=" + encodeURIComponent(String(src).slice(8)) : src);
// Anchor hrefs come straight from the model's render_ui spec (Link, References),
// which never passes through the server's HTML sanitizer. Allow only web schemes:
// blocks javascript:/data: and same-origin /local navigations that would run in
// this origin. Returns "#" for anything else.
const safeHref = (u) => {
  try {
    const { protocol, href } = new URL(String(u), location.href);
    if (!["http:", "https:", "mailto:"].includes(protocol)) return "#";
    return href.startsWith(location.origin + "/local") ? "#" : href;
  } catch {
    return "#";
  }
};

// ---- icons: small hand-authored line-icon set, no library/dependency ----
const SVGNS = "http://www.w3.org/2000/svg";
function svgTag(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const ICONS = {
  search: [["circle", { cx: 11, cy: 11, r: 7 }], ["line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
  download: [["path", { d: "M12 3v12" }], ["polyline", { points: "7 10 12 15 17 10" }], ["line", { x1: 5, y1: 21, x2: 19, y2: 21 }]],
  "file-text": [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }], ["polyline", { points: "14 2 14 8 20 8" }], ["line", { x1: 8, y1: 13, x2: 16, y2: 13 }], ["line", { x1: 8, y1: 17, x2: 16, y2: 17 }]],
  edit: [["path", { d: "M12 20h9" }], ["path", { d: "M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" }]],
  hash: [["line", { x1: 4, y1: 9, x2: 20, y2: 9 }], ["line", { x1: 4, y1: 15, x2: 20, y2: 15 }], ["line", { x1: 10, y1: 3, x2: 8, y2: 21 }], ["line", { x1: 16, y1: 3, x2: 14, y2: 21 }]],
  terminal: [["polyline", { points: "4 17 10 11 4 5" }], ["line", { x1: 12, y1: 19, x2: 20, y2: 19 }]],
  zap: [["polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" }]],
  settings: [["line", { x1: 4, y1: 6, x2: 20, y2: 6 }], ["circle", { cx: 14, cy: 6, r: 2 }], ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }], ["circle", { cx: 8, cy: 12, r: 2 }], ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }], ["circle", { cx: 16, cy: 18, r: 2 }]],
  bookmark: [["path", { d: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" }]],
  "book-open": [["path", { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" }], ["path", { d: "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["polyline", { points: "12 7 12 12 15 14.5" }]],
  layers: [["rect", { x: 3, y: 3, width: 13, height: 13, rx: 2 }], ["rect", { x: 8, y: 8, width: 13, height: 13, rx: 2 }]],
  users: [["circle", { cx: 9, cy: 7, r: 3 }], ["path", { d: "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" }], ["circle", { cx: 18, cy: 8, r: 2 }], ["path", { d: "M16 20c0-2.5 1.8-4.5 4-5" }]],
  repeat: [["polyline", { points: "17 1 21 5 17 9" }], ["path", { d: "M3 11V9a4 4 0 0 1 4-4h14" }], ["polyline", { points: "7 23 3 19 7 15" }], ["path", { d: "M21 13v2a4 4 0 0 1-4 4H3" }]],
  layout: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["line", { x1: 3, y1: 9, x2: 21, y2: 9 }], ["line", { x1: 9, y1: 9, x2: 9, y2: 21 }]],
  "help-circle": [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2-3 4" }], ["circle", { cx: 12, cy: 17, r: 1, fill: "currentColor", stroke: "none" }]],
  x: [["line", { x1: 18, y1: 6, x2: 6, y2: 18 }], ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  play: [["polygon", { points: "5 3 19 12 5 21" }]],
  loader: [["circle", { cx: 12, cy: 12, r: 9, "stroke-dasharray": "40 16" }]],
  check: [["polyline", { points: "20 6 9 17 4 12" }]],
  plus: [["line", { x1: 12, y1: 5, x2: 12, y2: 19 }], ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  list: [["line", { x1: 8, y1: 6, x2: 21, y2: 6 }], ["line", { x1: 8, y1: 12, x2: 21, y2: 12 }], ["line", { x1: 8, y1: 18, x2: 21, y2: 18 }], ["line", { x1: 3, y1: 6, x2: 3.01, y2: 6 }], ["line", { x1: 3, y1: 12, x2: 3.01, y2: 12 }], ["line", { x1: 3, y1: 18, x2: 3.01, y2: 18 }]],
  "chevron-down": [["polyline", { points: "6 9 12 15 18 9" }]],
  "arrow-up": [["line", { x1: 12, y1: 20, x2: 12, y2: 5 }], ["polyline", { points: "6 11 12 5 18 11" }]],
};
function icon(name, cls) {
  const svg = svgTag("svg", {
    width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
  });
  if (cls) svg.setAttribute("class", cls);
  (ICONS[name] || ICONS.zap).forEach(([tag, attrs]) => svg.append(svgTag(tag, attrs)));
  return svg;
}

// ---- media helpers ----
function openLightbox(url, isSvg) {
  const lb = document.getElementById("lightbox");
  lb.innerHTML = "";
  const img = document.createElement("img");
  img.src = url;
  img.tabIndex = -1;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "lb-close";
  close.append(icon("x"));
  close.setAttribute("aria-label", "Close");
  close.onclick = (e) => {
    e.stopPropagation();
    lb.close();
  };
  lb.append(img, close);
  lb.onclick = (e) => {
    if (e.target === lb) lb.close(); // click on the backdrop only, not the image/button
  };
  lb.showModal();
  img.focus();
}
async function download(url, name) {
  try {
    const r = await fetch(url);
    const b = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = name || "download";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(url, "_blank");
  }
}
function withImageChrome(fig, url, name, svg) {
  fig.classList.add("imgwrap");
  const img = fig.querySelector("img");
  if (img) img.onclick = () => openLightbox(url, svg);
  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "dl";
  dl.append(icon("download"), document.createTextNode(" Save"));
  dl.setAttribute("aria-label", "Save image");
  dl.onclick = (e) => {
    e.stopPropagation();
    download(url, name);
  };
  fig.append(dl);
  return fig;
}
// A fixed-height placeholder while the image loads avoids the chat log jumping
// once it comes in; on error it swaps to an "unavailable" message instead of
// collapsing the figure, which would otherwise jump a gallery hero (and its
// thumbnail strip above it) or a captioned image's layout unexpectedly.
function imageEl(src, alt, caption) {
  const url = localUrl(src);
  const fig = document.createElement("figure");
  fig.classList.add("media-placeholder");
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt || "";
  img.loading = "lazy";
  img.className = "media-cap rounded-lg";
  img.onload = () => fig.classList.remove("media-placeholder");
  img.onerror = () => {
    fig.innerHTML = "";
    fig.append(el("eyebrow", "image unavailable"));
  };
  fig.append(img);
  withImageChrome(fig, url, (alt || "image").replace(/[^\w.-]+/g, "_"));
  if (caption) fig.append(el("eyebrow mt-1", caption));
  return fig;
}
function svgEl(code, background) {
  const uri = "data:image/svg+xml;utf8," + encodeURIComponent(String(code));
  const fig = document.createElement("figure");
  if (background) fig.classList.add("frame");
  const img = document.createElement("img");
  img.src = uri;
  img.className = "media-cap rounded-lg";
  fig.append(img);
  return withImageChrome(fig, uri, "illustration.svg", true);
}
// Click-to-play poster, so an embed only loads once you ask for it.
// `watch` is the canonical page: some uploaders disable embedding outright, and
// the player's own "Video unavailable" screen is a dead end without a way out.
function facade(thumb, embed, watch) {
  const wrap = el("relative rounded-lg overflow-hidden bg-black aspect-video cursor-pointer group");
  wrap.setAttribute("role", "button");
  wrap.setAttribute("aria-label", "Play video");
  wrap.tabIndex = 0;
  if (thumb) {
    const img = document.createElement("img");
    img.src = thumb;
    img.className = "w-full h-full object-cover opacity-80 group-hover:opacity-100 transition";
    img.onerror = () => (img.style.display = "none");
    wrap.append(img);
  }
  const playGlyph = icon("play", "text-white/90 group-hover:scale-110 transition pointer-events-none");
  playGlyph.setAttribute("width", "40");
  playGlyph.setAttribute("height", "40");
  const playWrap = el("absolute inset-0 flex items-center justify-center");
  playWrap.append(playGlyph);
  wrap.append(playWrap);
  const play = () => {
    const f = document.createElement("iframe");
    f.src = embed;
    f.className = "w-full aspect-video rounded-lg";
    f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    f.allowFullscreen = true;
    f.loading = "lazy";
    if (!watch) return wrap.replaceWith(f);
    // Keep a way out under the player, since we can't detect from outside the
    // iframe whether YouTube rendered the video or its error page.
    const box = el("space-y-1");
    const a = document.createElement("a");
    a.href = watch;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "eyebrow hover:text-paper transition";
    a.textContent = "Won't play? Open on YouTube →";
    box.append(f, a);
    wrap.replaceWith(box);
  };
  wrap.onclick = play;
  wrap.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      play();
    }
  };
  return wrap;
}
// YT_ID_START — parsed URL-first, not by regex (see test/ytid.test.ts).
// The old pattern only knew watch?v= and /embed/, only when `v` was the FIRST
// query param, and accepted any 6+ chars as an id. That turned
// "/embed/videoseries?list=…" into the id "videoseries" — a real video id is
// always exactly 11 chars — and YouTube answered with its "Video unavailable"
// page. Anything that isn't a confident 11-char id now returns null, so we fall
// back to a plain link instead of embedding a player that can't work.
const YT_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/;
const YT_PATH = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/;
function ytId(src, provider) {
  if (provider && provider !== "youtube") return null;
  const s = String(src ?? "").trim();
  if (/^[\w-]{11}$/.test(s)) return s; // a bare id
  let u;
  try {
    u = new URL(s, "https://www.youtube.com");
  } catch {
    return null;
  }
  if (!YT_HOST.test(u.hostname)) return null;
  // youtu.be/<id> — the id is the whole path
  if (u.hostname.endsWith("youtu.be")) {
    const id = u.pathname.slice(1);
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  // /watch?v=<id>, wherever `v` sits among the params
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = u.pathname.match(YT_PATH); // /embed/, /shorts/, /live/, /v/
  // "videoseries" is YouTube's playlist-embed sentinel, and is exactly 11 chars
  // like a real id — so the length check alone lets it through.
  return m && m[1] !== "videoseries" ? m[1] : null;
}
// YT_ID_END
function vimeoId(src, provider) {
  if (provider && provider !== "vimeo") return null;
  const m = String(src).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}
function videoEl(src, provider) {
  const yt = ytId(src, provider);
  // origin + playsinline: the IFrame API wants an explicit origin, and without
  // playsinline iOS hijacks playback into fullscreen. rel=0 keeps the end-card
  // suggestions to the same channel.
  if (yt)
    return facade(
      `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
      `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&playsinline=1&rel=0&origin=${encodeURIComponent(location.origin)}`,
      `https://www.youtube.com/watch?v=${yt}`,
    );
  const vim = vimeoId(src, provider);
  if (vim) return facade(null, `https://player.vimeo.com/video/${vim}?autoplay=1`);
  const v = document.createElement("video");
  v.src = localUrl(src);
  v.controls = true;
  v.className = "w-full rounded-lg";
  return v;
}
// Hero + thumbnail-strip gallery: one big item, the rest as a scrollable strip;
// click (or arrow-key) a thumb to swap it into the hero (images open the
// lightbox, videos play).
function mediaNode(it) {
  return it.type === "Video" ? videoEl(it.src, it.provider) : imageEl(it.src, it.alt, it.caption);
}
function thumbUrl(it) {
  if (it.type === "Video") {
    const y = ytId(it.src, it.provider);
    return y ? `https://i.ytimg.com/vi/${y}/mqdefault.jpg` : null;
  }
  return localUrl(it.src);
}
function galleryEl(items) {
  items = items.filter((it) => it && it.src);
  if (!items.length) return el("eyebrow", "no media to show");
  if (items.length === 1) return mediaNode(items[0]);
  const wrap = el("space-y-2");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "image gallery");
  // Fixed-height, centered hero container so swapping between an image (height
  // capped) and a video (aspect-video, deliberately NOT capped — 16:9 would
  // letterbox badly at chat-column width) never reflows the surrounding card.
  const hero = el("relative flex items-center justify-center rounded-lg overflow-hidden bg-raise");
  hero.style.minHeight = "var(--media-max-h)";
  const counter = el("eyebrow absolute bottom-2 right-2 bg-surface/90 px-1.5 py-0.5 rounded");
  const strip = el("flex gap-2 overflow-x-auto pb-1 snap-x snap-mandatory");
  strip.style.maskImage = strip.style.webkitMaskImage =
    "linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent)";
  const thumbs = [];
  const CAP = 6;
  let revealed = items.length <= CAP;
  const show = (i) => {
    hero.innerHTML = "";
    hero.append(mediaNode(items[i]), counter);
    counter.textContent = `${i + 1} / ${items.length}`;
    thumbs.forEach((b, j) => {
      b.classList.toggle("ring-2", j === i);
      b.setAttribute("aria-current", j === i ? "true" : "false");
    });
  };
  const focusThumb = (i) => {
    thumbs[i].focus();
    show(i);
  };
  let badge = null;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    thumbs.slice(CAP).forEach((b) => strip.append(b));
    badge?.remove();
  };
  items.forEach((it, i) => {
    const b = document.createElement("button");
    b.className =
      "relative shrink-0 h-12 w-16 sm:h-16 sm:w-24 rounded-lg overflow-hidden border border-line ring-signal snap-start hover:ring-2 hover:ring-line transition";
    b.setAttribute("aria-label", (it.type === "Video" ? "Play video " : "View image ") + (i + 1));
    const thumbFallback = () => {
      b.innerHTML = "";
      const wrap = el("h-full w-full flex items-center justify-center text-dim");
      wrap.append(icon(it.type === "Video" ? "play" : "file-text"));
      b.append(wrap);
    };
    const t = thumbUrl(it);
    if (t) {
      const im = document.createElement("img");
      im.src = t;
      im.loading = "lazy";
      im.className = "h-full w-full object-cover";
      im.onerror = thumbFallback;
      b.append(im);
    } else thumbFallback();
    if (it.type === "Video" && t) {
      const p = icon("play", "text-white/90 pointer-events-none");
      const pWrap = el("absolute inset-0 flex items-center justify-center");
      pWrap.append(p);
      b.append(pWrap);
    }
    b.onclick = () => {
      show(i);
      if (i === CAP - 1) reveal();
    };
    thumbs.push(b);
    if (i < CAP) strip.append(b);
  });
  if (!revealed) {
    badge = el(
      "absolute inset-0 flex items-center justify-center bg-paper/70 text-surface text-sm font-semibold rounded-lg pointer-events-none",
      `+${items.length - CAP}`,
    );
    thumbs[CAP - 1].append(badge);
  }
  strip.onkeydown = (e) => {
    const i = thumbs.indexOf(document.activeElement);
    if (i === -1) return;
    const n = revealed ? items.length : CAP;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusThumb((i + 1) % n);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusThumb((i - 1 + n) % n);
    }
  };
  wrap.append(hero, strip);
  show(0);
  return wrap;
}
function referencesEl(items) {
  const wrap = el("flex flex-wrap gap-2");
  // Drop sources already cited this turn so the model can't render the same
  // list two or three times in one answer.
  const filtered = (items || []).filter((it) => it.url && !shownSources.has(it.url) && shownSources.add(it.url));
  const CAP = 3;
  const pillFor = (it) => {
    const a = document.createElement("a");
    a.href = safeHref(it.url);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "source-pill";
    let host = "";
    try {
      host = new URL(it.url).hostname.replace(/^www\./, "");
    } catch {}
    const tip = [it.title, it.snippet].filter(Boolean).join(" — ");
    if (tip) a.title = tip;
    a.append(el("source-pill-icon", (host[0] || "?").toUpperCase()), el("", host || it.url));
    return a;
  };
  filtered.slice(0, CAP).forEach((it) => wrap.append(pillFor(it)));
  if (filtered.length > CAP) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "source-pill source-pill-more";
    more.textContent = `+${filtered.length - CAP} more`;
    more.onclick = () => {
      filtered.slice(CAP).forEach((it) => wrap.insertBefore(pillFor(it), more));
      more.remove();
    };
    wrap.append(more);
  }
  return wrap;
}
function mermaidEl(code) {
  const holder = el("frame overflow-x-auto");
  const id = "mmd-" + Math.random().toString(36).slice(2);
  if (window.mermaid)
    mermaid
      .render(id, String(code))
      .then(({ svg }) => (holder.innerHTML = svg))
      .catch(() => (holder.textContent = code));
  else holder.textContent = code;
  return holder;
}
// ---- maps (Leaflet + OSM/OSRM, keyless) ----
async function geocode(q) {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q));
    const j = await r.json();
    if (j[0]) return { lat: +j[0].lat, lng: +j[0].lon };
  } catch {}
  return null;
}
function getGeo() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 8000 });
  });
}
function mapEl(p) {
  const holder = el("frame");
  const div = document.createElement("div");
  div.style.height = "320px";
  div.className = "rounded-lg";
  holder.append(div);
  setTimeout(async () => {
    if (!window.L) {
      holder.textContent = "map unavailable";
      return;
    }
    const map = L.map(div);
    // MapTiler streets-v4 raster tiles when a key is configured (in .env, fetched
    // via /state — never hardcoded in source); otherwise fall back to keyless OSM.
    if (maptilerKey)
      L.tileLayer(`https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=${maptilerKey}`, {
        attribution: '© <a href="https://www.maptiler.com/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        tileSize: 512,
        zoomOffset: -1,
        minZoom: 1,
        maxZoom: 20,
        crossOrigin: true,
      }).addTo(map);
    else L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
    const pts = [];
    for (const m of p.markers || []) {
      let lat = m.lat,
        lng = m.lng;
      if ((lat == null || lng == null) && m.query) {
        const g = /near me|my location/i.test(m.query) ? await getGeo() : await geocode(m.query);
        if (g) {
          lat = g.lat;
          lng = g.lng;
        }
      }
      if (lat != null && lng != null) {
        const mk = L.marker([lat, lng]).addTo(map);
        // bindPopup parses a string as HTML — pass a text node so a model-supplied
        // label can't inject markup.
        if (m.label) mk.bindPopup(el("", String(m.label)));
        pts.push([lat, lng]);
      }
    }
    if (p.route && p.route.from && p.route.to) {
      const a = typeof p.route.from === "string" ? await geocode(p.route.from) : p.route.from;
      const b = typeof p.route.to === "string" ? await geocode(p.route.to) : p.route.to;
      if (a && b) {
        L.marker([a.lat, a.lng]).addTo(map);
        L.marker([b.lat, b.lng]).addTo(map);
        pts.push([a.lat, a.lng], [b.lat, b.lng]);
        try {
          const rr = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
          const j = await rr.json();
          if (j.routes && j.routes[0]) {
            const coords = j.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            const accent = getComputedStyle(document.documentElement).getPropertyValue("--c-accent").trim();
            L.polyline(coords, { color: `rgb(${accent})`, weight: 4 }).addTo(map);
            coords.forEach((c) => pts.push(c));
            holder.append(el("eyebrow mt-2", `${(j.routes[0].distance / 1000).toFixed(1)} km · ~${Math.round(j.routes[0].duration / 60)} min`));
          }
        } catch {}
      }
    }
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 });
    else map.setView([20, 0], 2);
    setTimeout(() => map.invalidateSize(), 120);
  }, 0);
  return holder;
}

// ---- spec renderer: json-render tree → React ----
// The spec is a flat id→element map; <Node> walks it and dispatches on `type`
// through REGISTRY. Every child gets a key, so a re-render reconciles instead of
// re-appending — the structural reason a duplicated spec can't paint twice.
const h = React.createElement;
// Escape hatch for leaf widgets that own their DOM imperatively (Leaflet,
// mermaid's async render, the gallery's hero swap, lightbox/download chrome).
// React mounts the node once and stays out of it.
function Native({ make }) {
  const host = React.useRef(null);
  React.useEffect(() => {
    const node = make();
    host.current.append(node);
    return () => node.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; the spec node never changes identity
  }, []);
  return h("div", { ref: host });
}
const native = (make) => h(Native, { make });
// Prefer the server-rendered markdown for a text prop, else plain text. Returns
// the props to spread, so a component doesn't branch on it twice.
const html = (rendered, plain) =>
  rendered != null ? { dangerouslySetInnerHTML: { __html: rendered } } : { children: plain || "" };
const REGISTRY = {
  // props.html is server-sanitized markdown (see setRenderSink in web.ts); the
  // model's raw html field is stripped there and never reaches this.
  Text: ({ p }) =>
    p.html != null
      ? h("div", { className: "md text-paper/95", ref: (n) => n && enrich(n), dangerouslySetInnerHTML: { __html: p.html } })
      : h("div", { className: "md text-paper/95" }, p.content || ""),
  Heading: ({ p }) =>
    h("h" + Math.min(3, Math.max(1, p.level || 2)), {
      className: "font-display font-semibold",
      // Same rule as Text: *Html is server-derived and sanitized, never the
      // model's own html field. Falls back to plain text if it's missing.
      ...html(p.contentHtml, p.content),
    }),
  Image: ({ p }) => native(() => imageEl(p.src, p.alt, p.caption)),
  Svg: ({ p }) => native(() => svgEl(p.code, p.background)),
  Video: ({ p }) => native(() => videoEl(p.src, p.provider)),
  Mermaid: ({ p }) => native(() => mermaidEl(p.code)),
  Map: ({ p }) => native(() => mapEl(p)),
  References: ({ p }) => native(() => referencesEl(p.items)),
  FollowUps: ({ p }) => native(() => followUpsEl(p.items)),
  Gallery: ({ node, elements }) =>
    native(() =>
      galleryEl(
        (node.children || []).map((c) => (elements[c] ? { type: elements[c].type, ...(elements[c].props || {}) } : null)),
      ),
    ),
  Card: ({ p, kids }) =>
    h(
      "div",
      { className: "frame space-y-2" },
      p.title
        ? h("div", { className: "font-display font-semibold md", key: "title", ...html(p.titleHtml, p.title) })
        : null,
      kids,
    ),
  Grid: ({ kids }) => h("div", { className: "grid gap-3 sm:grid-cols-2" }, kids),
  List: ({ p }) =>
    h(
      p.ordered ? "ol" : "ul",
      { className: "pl-5 space-y-1 md " + (p.ordered ? "list-decimal" : "list-disc") },
      (p.items || []).map((it, i) => h("li", { key: i, ...html(p.itemsHtml?.[i], it) })),
    ),
  Link: ({ p }) =>
    h(
      "a",
      { href: safeHref(p.href), target: "_blank", rel: "noopener noreferrer", className: "text-signal underline" },
      p.label || p.href,
    ),
  Table: ({ p }) =>
    h(
      "div",
      { className: "frame overflow-x-auto" },
      h(
        "table",
        { className: "data" },
        p.columns ? h("thead", null, h("tr", null, p.columns.map((c, i) => h("th", { key: i }, c)))) : null,
        h(
          "tbody",
          null,
          (p.rows || []).map((row, i) =>
            h("tr", { key: i }, (row || []).map((cell, j) => h("td", { key: j }, String(cell)))),
          ),
        ),
      ),
    ),
  Metric: ({ p }) =>
    h(
      "div",
      { className: "frame metric" },
      h("div", { className: "eyebrow" }, p.label || ""),
      h("div", { className: "v" }, (p.value ?? "") + (p.unit ? " " + p.unit : "")),
      p.delta != null
        ? h(
            "div",
            { className: "text-xs mt-0.5 " + (p.delta > 0 ? "text-done" : p.delta < 0 ? "text-bad" : "text-dim") },
            (p.delta > 0 ? "▲ " : p.delta < 0 ? "▼ " : "") + p.delta,
          )
        : null,
    ),
  Progress: ({ p }) =>
    h(
      "div",
      { className: "space-y-1" },
      p.label ? h("div", { className: "eyebrow" }, p.label + "  " + Math.round(p.value || 0) + "%") : null,
      h(
        "div",
        { className: "w-full bg-raise rounded-full h-2 overflow-hidden" },
        h("div", {
          className: "h-full bg-signal rounded-full",
          style: { width: Math.max(0, Math.min(100, p.value || 0)) + "%" },
        }),
      ),
    ),
};
// React unmounts the entire root when a child throws, so without a boundary one
// bad node silently blanks the whole block — and a throw during React's async
// render never reaches renderSpec's try/catch.
class Boundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed
      ? h("div", { className: "font-mono text-xs text-bad" }, "could not render UI block")
      : this.props.children;
  }
}
function Node({ id, elements, depth }) {
  const node = elements[id];
  if (!node || depth > 20) return null;
  // Dedupe child ids: a model that lists the same id twice ("children":["t1","t1"])
  // would otherwise render that Table/Map twice inside the Card.
  const kids = [...new Set(node.children || [])].map((c) => h(Node, { key: c, id: c, elements, depth: depth + 1 }));
  const C = REGISTRY[node.type];
  return C ? h(C, { p: node.props || {}, kids, node, elements }) : h("div", { className: "space-y-2" }, kids);
}
// Suggested next questions as clickable chips — tapping one asks it.
// Real <button>s (not just styled divs) so they're natively keyboard-reachable;
// arrow keys additionally rove focus between them, matching the gallery
// thumbnail strip's nav pattern. The kbd hint only shows once a chip has focus.
function followUpsEl(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return el("");
  const wrap = el("followups-wrap");
  wrap.append(el("eyebrow followups-hint", "↑↓ navigate · ↵ select"));
  const row = el("flex flex-wrap gap-2");
  const chips = [];
  list.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "border border-line rounded-full px-3 py-1.5 text-xs cursor-pointer text-dim hover:text-paper hover:border-signal transition";
    b.textContent = q;
    b.onclick = () => {
      if (busy) return;
      msg.value = q;
      composer.requestSubmit();
    };
    chips.push(b);
    row.append(b);
  });
  row.onkeydown = (e) => {
    const i = chips.indexOf(document.activeElement);
    if (i === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      chips[(i + 1) % chips.length].focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      chips[(i - 1 + chips.length) % chips.length].focus();
    }
  };
  wrap.append(row);
  return wrap;
}
const KIND = { Gallery: "images", Image: "image", Svg: "illustration", Video: "video", References: "sources", FollowUps: "related", Mermaid: "diagram", Table: "table", Metric: "metric", Map: "map", Card: "view", Grid: "view" };
// SPEC_SIG_START — structural signature, id-agnostic (see test/specsig.test.ts)
// Walks the tree from the root emitting type + sorted props + children, so a
// re-emitted block with fresh element ids or a different key order hashes the
// same. props.html is skipped: the server derives it from props.content.
function specSig(spec) {
  const seen = new Set();
  const walk = (id) => {
    const n = spec.elements?.[id];
    if (!n || seen.has(id)) return "";
    seen.add(id);
    const p = n.props || {};
    const props = Object.keys(p)
      .filter((k) => k !== "html")
      .sort()
      .map((k) => k + ":" + JSON.stringify(p[k]))
      .join(",");
    return `${n.type}{${props}}[${(n.children || []).map(walk).join("|")}]`;
  };
  return walk(spec.root);
}
// SPEC_SIG_END
function renderSpec(spec) {
  // Same block, twice in one turn: the model re-emits a Card/Table/Map it already
  // drew, and an agent retry after a mid-step error replays the render_ui call.
  // Draw it once per turn.
  const sig = specSig(spec);
  if (shownSpecs.has(sig)) return;
  shownSpecs.add(sig);
  const type = spec.elements?.[spec.root]?.type;
  // A References block whose sources were ALL already cited this turn would
  // render empty — drop it up front. This has to be decided from the spec, not
  // from the mounted DOM: React renders asynchronously, so the old
  // "is the node empty?" check would now always see an empty node.
  // Peek at shownSources without consuming — referencesEl does the real filter.
  if (type === "References" && !(spec.elements[spec.root].props?.items || []).some((it) => it?.url && !shownSources.has(it.url)))
    return;
  const inner = el("");
  try {
    const root = ReactDOM.createRoot(inner);
    specRoots.push(root);
    root.render(h(Boundary, null, h(Node, { id: spec.root, elements: spec.elements || {}, depth: 0 })));
    return add(block(KIND[type] || "view", inner));
  } catch {
    add(el("font-mono text-xs text-bad", "could not render UI block"));
  }
}
function enrich(container) {
  container.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
  container.querySelectorAll("pre code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (pre) pre.replaceWith(mermaidEl(code.textContent));
  });
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy")) return;
    const b = el("copy eyebrow", "copy");
    b.style.cssText = "position:absolute;top:6px;right:8px;cursor:pointer;";
    b.onclick = () => {
      navigator.clipboard?.writeText(pre.innerText.replace(/\n?copy$/, ""));
      b.textContent = "copied";
      setTimeout(() => (b.textContent = "copy"), 1200);
    };
    pre.appendChild(b);
  });
  container.querySelectorAll("img").forEach((img) => (img.onclick = () => openLightbox(img.src)));
}

// ---- transcript pieces ----
function userBubble(text) {
  setHome(false);
  add(el("usermsg whitespace-pre-wrap text-paper", text));
  contentCardThisTurn = false;
  shownSources = new Set();
  shownSpecs = new Set();
  floatBottom = [];
  toolSummary = null;
  turnStartTime = Date.now();
}
function assistantNode() {
  const n = el("md whitespace-pre-wrap leading-relaxed text-paper/95");
  const wrapped = labeledThisTurn ? n : block("adhd", n);
  labeledThisTurn = true;
  turnAssistants.push(wrapped);
  add(wrapped);
  return n;
}
const TOOL_ICON = { web_search: "search", browser: "globe", search_files: "search", read_file: "file-text", write_file: "edit", list_dir: "file-text", grep: "search", glob: "hash", bash: "terminal", powershell: "terminal", run_script: "zap", remember: "bookmark", recall: "book-open", schedule: "clock", use_skill: "layers", spawn_agent: "users", loop_task: "repeat", render_ui: "layout", ask_user: "help-circle" };
const TOOL_STATUS = { web_search: "searching the web", browser: "using the browser", search_files: "searching your files", run_script: "running a script", bash: "running a command", powershell: "running a command", render_ui: "drawing", remember: "saving to memory", recall: "checking memory", spawn_agent: "delegating", loop_task: "iterating" };
// Individual tool calls append into a per-turn collapsible summary (lazily
// created on the first tool-call), rather than directly into #log — expanded
// live while the turn runs, auto-collapsed to a duration-stamped one-liner
// once the turn completes (see the `done` handler).
function createToolSummary() {
  const wrap = el("tool-summary");
  const header = el("tool-summary-header");
  header.append(icon("chevron-down", "tool-summary-chevron"), el("truncate flex-1", "Working"), el("tool-summary-duration"));
  const rows = el("tool-summary-rows space-y-1");
  header.onclick = () => wrap.classList.toggle("collapsed");
  wrap.append(header, rows);
  add(wrap);
  return { wrap, label: header.children[1], duration: header.children[2], rows };
}
function toolRow(id, name, summary) {
  if (!toolSummary) toolSummary = createToolSummary();
  toolSummary.label.textContent = TOOL_STATUS[name] || "running " + name;
  const row = el("font-mono text-xs flex items-center gap-2 text-dim");
  row.dataset.tool = id;
  const g = icon(TOOL_ICON[name] || "zap", "text-dim w-3 h-3 shrink-0 spin");
  row.append(g, el("truncate", name + (summary ? "  " + summary : "")));
  toolSummary.rows.append(row);
}
function toolDone(id) {
  const row = log.querySelector(`[data-tool="${CSS.escape(id)}"]`);
  if (!row) return;
  const g = row.firstChild;
  g.replaceWith(icon("check", "text-done w-3 h-3 shrink-0"));
}
function setStatus(text) {
  statusText.textContent = text;
  statusEl.classList.remove("hidden");
}

// ---- SSE ----
function connect() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => connEl.classList.add("hidden"));
  es.addEventListener("error", () => connEl.classList.remove("hidden"));
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  on("text", (d) => {
    if (!current) current = assistantNode();
    current.textContent += d.delta;
    setStatus("writing");
    stickBottom();
  });
  on("tool-call", (d) => {
    current = null;
    toolRow(d.id, d.name, d.summary);
    setStatus(TOOL_STATUS[d.name] || "running " + d.name);
  });
  on("tool-result", (d) => toolDone(d.id));
  on("render_ui", (d) => {
    current = null;
    const node = renderSpec(d.spec);
    const kind = KIND[d.spec.elements?.[d.spec.root]?.type];
    if (kind === "sources" || kind === "related") {
      // Sources and follow-ups belong below the answer no matter when the model
      // emits them — hold them and re-append at turn end.
      if (node) floatBottom.push({ kind, node });
    } else if (d.carries) {
      // `carries` is the server's call (render.ts carriesAnswer), the same verdict
      // it gave the model in the tool result. Deciding it again here is how the two
      // ended up disagreeing and dropping the prose that held the actual answer.
      contentCardThisTurn = true;
    }
  });
  on("sub", (d) => add(el("font-mono text-xs text-dim pl-4", d.line)));
  on("info", (d) => add(el("font-mono text-xs text-dim", d.message)));
  // flow progress belongs to the Flows page (flow.js registers the handler);
  // one EventSource for the whole app, so it's forwarded rather than duplicated.
  on("flow", (d) => window.onFlowEvent?.(d));
  on("error", (d) => add(el("font-mono text-xs text-bad", "error: " + d.message)));
  // usage is still broadcast; nothing displays it now that the context strip
  // answers the question people were actually reading the counter for.
  // Occupancy, not spend — the header counter answers the other question.
  on("context", (d) => renderContext(d));
  on("compaction", (d) => compactionRow(d));
  on("todos", (d) => renderTodos(d.items));
  on("busy", (d) => setBusy(d.busy));
  on("model", (d) => (modelEl.value = d.model));
  on("confirm", (d) => confirmCard(d));
  on("ask", (d) => askCard(d));
  on("notify", (d) => notify(d.title, d.body));
  on("done", (d) => {
    // When a content card already carried the answer, the card IS the whole
    // answer — drop any trailing prose entirely rather than keeping an intro line.
    if (d.html && !contentCardThisTurn) {
      turnAssistants.forEach((n) => n.remove());
      const ans = el("md leading-relaxed text-paper/95");
      ans.innerHTML = d.html;
      enrich(ans);
      if (ans.textContent.trim()) add(block("adhd", ans));
    } else if (d.html && contentCardThisTurn) {
      turnAssistants.forEach((n) => n.remove());
    }
    // Float sources, then follow-ups, to the very bottom (below the answer).
    floatBottom.sort((a, b) => (a.kind === "sources" ? -1 : 1) - (b.kind === "sources" ? -1 : 1));
    floatBottom.forEach(({ node }) => log.appendChild(node));
    stickBottom();
    floatBottom = [];
    turnAssistants = [];
    shownSources = new Set();
  shownSpecs = new Set();
    contentCardThisTurn = false;
    current = null;
    labeledThisTurn = false;
    if (toolSummary) {
      const elapsed = Math.max(0, Math.round((Date.now() - turnStartTime) / 1000));
      toolSummary.duration.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      toolSummary.wrap.classList.add("collapsed");
      toolSummary = null;
    }
    if (document.hidden) notify("adhd", "Answer ready");
  });
}
function setBusy(v) {
  busy = v;
  ctxCompact.disabled = v; // the server 409s a mid-turn compact; don't offer it
  // The composer stays live while the agent works — sending now queues rather
  // than being swallowed, so the button must stay clickable and the placeholder
  // has to say what pressing it will actually do.
  msg.placeholder = v ? "Queue a message…" : "Ask adhd anything…";
  if (v) setStatus("thinking");
  else {
    statusEl.classList.add("hidden");
    drainQueue();
  }
}

// ---- notifications ----
function notify(title, body) {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

// ---- interactive prompts ----
// Approval card. The model's plain-English `explain` leads — that's what the
// user actually decides on; the raw command sits below it, collapsed behind a
// toggle so it's available but not the headline.
function confirmCard(d) {
  const c = el("frame space-y-2 approve");
  c.append(el("eyebrow", "run this?"));
  if (d.explain) c.append(el("text-sm text-paper", d.explain));
  // The command is shown OUTRIGHT, never behind a toggle or a tooltip. You can't
  // approve what you can't see, and a hidden default means people click Allow
  // without ever reading it — the explain line is the model's claim about the
  // command, this is the command.
  c.append(el("eyebrow mt-1", "command"));
  c.append(el("font-mono text-xs whitespace-pre-wrap bg-raise border border-line rounded-lg px-2.5 py-2 text-paper overflow-x-auto", d.command));

  const answer = (ok, always) => {
    post("/confirm", { token: d.token, ok, always: !!always });
    c.remove();
  };
  const btn = (cls, label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  const btns = el("flex flex-wrap gap-2 pt-1");
  btns.append(btn("bg-paper text-base rounded-full px-3.5 py-1 text-xs cursor-pointer font-medium", "Allow once", () => answer(true, false)));
  // allowKey is null for anything the server won't blanket-approve (shell
  // operators, run_script) — no "always" button at all in that case.
  if (d.allowKey)
    btns.append(
      btn(
        "border border-line text-paper rounded-full px-3.5 py-1 text-xs cursor-pointer hover:border-signal transition-colors",
        `Always allow ${d.allowKey.split(":")[1]}`,
        () => answer(true, true),
      ),
    );
  btns.append(btn("border border-line text-dim rounded-full px-3.5 py-1 text-xs cursor-pointer", "Deny", () => answer(false, false)));
  c.append(btns);
  add(c);
}
function askCard(d) {
  const c = el("frame space-y-2");
  c.append(el("text-sm", d.question));
  const answer = (v) => {
    post("/ask", { token: d.token, answer: v });
    c.remove();
  };
  const opts = el("flex flex-wrap gap-2");
  (d.options || []).forEach((o) => {
    const b = el("border border-line rounded-full px-3.5 py-1 text-xs cursor-pointer hover:border-signal transition-colors", o);
    b.onclick = () => answer(o);
    opts.append(b);
  });
  c.append(opts);
  const inp = document.createElement("input");
  inp.className = "w-full bg-base border border-line rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-signal";
  inp.placeholder = "or type your own…";
  inp.onkeydown = (e) => {
    if (e.key === "Enter" && inp.value.trim()) answer(inp.value.trim());
  };
  c.append(inp);
  add(c);
}

// ---- composer / settings ----
function post(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
// ---- send queue -------------------------------------------------------------
// A message typed mid-turn used to be dropped on the floor. It waits here
// instead and sends itself when the agent frees up, editable and removable until
// then. Lifted from deepseek-harness's QueueDock, minus the server: the queue is
// purely client-side, so a refresh loses it — which is fine, nothing has been
// said to the agent yet. ponytail: no steer action, that one needs the server to
// interrupt a running turn and adhd can't.
const queueEl = document.getElementById("queue");
let queued = [];

function renderQueue() {
  queueEl.replaceChildren();
  queueEl.classList.toggle("hidden", queued.length === 0);
  queued.forEach((text, i) => {
    const row = el("frame flex items-center gap-2 py-1.5 font-mono text-[11px] text-dim");
    row.append(icon("clock", "w-3.5 h-3.5 shrink-0 opacity-60"));

    const preview = el("flex-1 truncate", text);
    preview.title = text; // full text on hover — the row itself stays one line
    row.append(preview);

    const act = (name, label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "shrink-0 opacity-60 hover:opacity-100 hover:text-paper transition";
      b.title = label;
      b.setAttribute("aria-label", `${label} queued message`);
      b.append(icon(name, "w-3.5 h-3.5"));
      b.onclick = fn;
      return b;
    };

    row.append(
      act("edit", "Edit", () => {
        const input = document.createElement("input");
        input.className = "flex-1 bg-transparent text-paper outline-none";
        input.value = text;
        input.setAttribute("aria-label", "Edit queued message");
        const commit = (save) => {
          if (save && input.value.trim()) queued[i] = input.value.trim();
          renderQueue();
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") (e.preventDefault(), commit(true));
          if (e.key === "Escape") commit(false);
        };
        input.onblur = () => commit(true);
        preview.replaceWith(input);
        input.focus();
      }),
      act("x", "Remove", () => {
        queued.splice(i, 1);
        renderQueue();
      }),
    );
    queueEl.append(row);
  });
}

async function send(text) {
  userBubble(text);
  const r = await post("/chat", { message: text });
  if (r.status === 400) {
    nokey.classList.remove("hidden");
    openSettings();
  }
}

// Drain one message per idle transition: /chat flips busy back on immediately,
// so the next one waits for the turn after. Sequential by construction.
function drainQueue() {
  if (busy || !queued.length) return;
  void send(queued.shift());
  renderQueue();
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = msg.value.trim();
  if (!text) return;
  msg.value = "";
  msg.style.height = "auto";
  if (busy) {
    queued.push(text);
    renderQueue();
    return;
  }
  await send(text);
});
msg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
msg.addEventListener("input", () => {
  msg.style.height = "auto";
  msg.style.height = Math.min(msg.scrollHeight, 160) + "px";
});
sendBtn.append(icon("arrow-up")); // header buttons carry their own SVG in index.html
const panel = document.getElementById("panel");
window.openSettings = () => {
  panel.classList.remove("hidden");
  htmx.ajax("GET", "/settings", "#settings");
};
window.closeSettings = () => {
  panel.classList.add("hidden");
};
document.getElementById("open-settings").onclick = openSettings;

// ---- new chat ----
const newChatBtn = document.getElementById("new-chat");
newChatBtn.onclick = async () => {
  await post("/new", {});
  // Unmount before clearing the DOM, so Native's cleanup runs (Leaflet maps and
  // video iframes otherwise leak past the transcript that held them).
  specRoots.forEach((r) => r.unmount());
  specRoots = [];
  growth.disconnect(); // drop observers on the transcript we're about to throw away
  log.innerHTML = "";
  pinned = true;
  setHome(true);
  ctxEl.classList.add("hidden"); // server also broadcasts a fresh context on /new
  queued = []; // anything still waiting was meant for the conversation just discarded
  renderQueue();
  renderTodos([]);
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSettings();
});
document.body.addEventListener("htmx:afterSwap", (e) => {
  if (e.target.id === "settings") {
    refreshState();
    wireSettings();
  }
});
// The settings fragment is server-rendered HTML (HTMX); wire its client-only
// controls (theme + notifications) after each swap.
function wireSettings() {
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  const panels = [...document.querySelectorAll("[data-settings-panel]")];
  const selectTab = (id, focus = false) => {
    if (!tabs.some((tab) => tab.dataset.settingsTab === id)) id = "general";
    tabs.forEach((tab) => {
      const active = tab.dataset.settingsTab === id;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    panels.forEach((section) => (section.hidden = section.dataset.settingsPanel !== id));
    sessionStorage.setItem("adhd-settings-tab", id);
  };
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab.dataset.settingsTab);
    tab.onkeydown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.settingsTab, true);
    };
  });
  selectTab(sessionStorage.getItem("adhd-settings-tab") || "general");
  const sel = document.getElementById("appearance-select");
  if (sel) {
    sel.value = window.currentThemePref();
    sel.onchange = () => applyTheme(sel.value);
  }
  const notif = document.getElementById("notif-toggle");
  if (notif && "Notification" in window) {
    notif.checked = Notification.permission === "granted";
    notif.disabled = Notification.permission === "denied";
    notif.onchange = () => {
      if (notif.checked) Notification.requestPermission().then((p) => (notif.checked = p === "granted"));
    };
  }
}
// --- context strip ----------------------------------------------------------
// One <span> per message, flex-grow set to its size in chars, so the browser
// does the percentage maths and this stays arithmetic-free. The bar is measured
// against the BUDGET (what actually triggers compaction) rather than the raw
// window — at a 1M-token window the used slice would be a couple of invisible
// pixels. The window is in the readout instead.
const ctxEl = document.getElementById("ctx");
const ctxBar = document.getElementById("ctx-bar");
const ctxRead = document.getElementById("ctx-read");
const NEAR = 0.75; // past this, compaction is close — colour says so

const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

function renderContext(s) {
  if (!s || !s.budget) return;
  // Only fixed overhead so far (prompt + tool schemas): no conversation to show.
  const empty = s.segments.every((g) => g.kind === "system" || g.kind === "schemas");
  ctxEl.classList.toggle("hidden", empty);
  if (empty) return;

  ctxBar.replaceChildren();
  for (const g of s.segments) {
    const b = document.createElement("span");
    b.style.flexGrow = g.size;
    b.style.background = `var(--ctx-${g.kind})`;
    b.title = `${g.name || g.kind} · ${short(g.size)} chars`;
    ctxBar.append(b);
  }
  // Trailing spacer = headroom left in the budget. Transparent, so the track
  // colour shows through as "free".
  const free = document.createElement("span");
  free.style.flexGrow = Math.max(0, s.budget - s.used);
  free.style.background = "transparent";
  ctxBar.append(free);

  const pct = s.used / s.budget;
  ctxEl.classList.toggle("near", pct >= NEAR);
  // Fixed overhead is worth naming: it's the part compaction can never shrink,
  // and the only lever on it is switching capabilities off in Settings.
  const fixed = s.segments
    .filter((g) => g.kind === "system" || g.kind === "schemas")
    .reduce((a, g) => a + g.size, 0);
  const compacted = s.compactions ? ` · ${s.compactions} compaction${s.compactions > 1 ? "s" : ""}` : "";
  // Pruning is the cheap half of compaction and it happens silently, so say what
  // it bought — otherwise the bar just mysteriously shrinks.
  const reclaimed = s.pruned ? ` · ${short(s.pruned)} pruned` : "";
  ctxRead.textContent = `${short(s.used)} / ${short(s.budget)} · ${short(fixed)} fixed${compacted}${reclaimed}`;
  ctxBar.title =
    `${Math.round(pct * 100)}% of budget. ${short(fixed)} chars of that is the system prompt plus ` +
    `tool schemas, sent every message — switch capabilities off in Settings to shrink it.`;
}

// A landed compaction, marked in the transcript where it happened. Everything
// above the line is no longer what the model sees, so this is a permanent edit
// to the conversation and deserves a row rather than a toast that scrolls away.
// Collapsed by default; expands to the summary that replaced the history.
// Native <details> does the disclosure — no state to track, and the keyboard and
// aria behaviour come free. Mirrors deepseek-harness's CompactionItem, including
// staying non-expandable when the summariser produced nothing to show.
function compactionRow(d) {
  const bits = [];
  if (d.items) bits.push(`${d.items} message${d.items > 1 ? "s" : ""} summarised`);
  if (d.pruned) bits.push(`${short(d.pruned)} chars of tool output pruned`);
  if (!bits.length) return;

  const row = document.createElement(d.summary ? "details" : "div");
  row.className = "group my-3 border-t border-line pt-2 font-mono text-[11px] text-dim";
  const head = document.createElement(d.summary ? "summary" : "div");
  head.className =
    "flex items-center gap-2" + (d.summary ? " cursor-pointer list-none hover:text-paper transition-colors" : "");
  head.append(icon("layers", "w-3.5 h-3.5 shrink-0"), el("", `${d.manual ? "compacted" : "auto-compacted"} · ${bits.join(" · ")}`));
  if (d.summary) head.append(el("ml-auto opacity-60 group-open:hidden", "summary"));
  row.append(head);
  // textContent, not markdown: the summary is prose full of "~400"-style figures
  // that GFM would render as strikethrough, and plain text needs no sanitising.
  if (d.summary) row.append(el("mt-2 whitespace-pre-wrap border-l border-line pl-3 leading-relaxed text-paper/80", d.summary));
  add(row);
}

// Manual compaction. Summarising is a model call, so this can take a second —
// disable the button meanwhile rather than let it queue up duplicate passes.
// The server refuses with 409 while a turn is in flight; the info/context events
// it broadcasts land through the normal stream, so there's nothing to render here.
const ctxCompact = document.getElementById("ctx-compact");
ctxCompact.onclick = async () => {
  ctxCompact.disabled = true;
  ctxCompact.textContent = "compacting…";
  try {
    await post("/compact", {});
  } finally {
    ctxCompact.disabled = false;
    ctxCompact.textContent = "compact";
  }
};

// --- task list --------------------------------------------------------------
// The agent's own plan, as it goes. Hidden entirely when there's no list, so a
// one-shot question doesn't grow furniture.
const todosEl = document.getElementById("todos");
const todoList = document.getElementById("todo-list");
const MARK = { done: "[x]", doing: "[>]", pending: "[ ]" };

function renderTodos(items) {
  const list = items || [];
  todosEl.classList.toggle("hidden", list.length === 0);
  todoList.replaceChildren();
  for (const it of list) {
    const row = document.createElement("div");
    row.className = "todo-row";
    row.dataset.s = it.status;
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = MARK[it.status] || MARK.pending;
    const title = document.createElement("span");
    title.textContent = it.title; // textContent: the model wrote this
    row.append(mark, title);
    todoList.append(row);
  }
}

async function refreshState() {
  try {
    const s = await (await fetch("/state")).json();
    maptilerKey = s.maptilerKey || "";
    if (s.models && modelEl.options.length !== s.models.length) {
      modelEl.innerHTML = "";
      s.models.forEach((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = id;
        modelEl.append(o);
      });
    }
    // A model typed into Settings won't be in the suggestion list; add it so the
    // dropdown shows what's actually running instead of going blank.
    if (s.model && !Array.from(modelEl.options).some((o) => o.value === s.model)) {
      const o = document.createElement("option");
      o.value = o.textContent = s.model;
      modelEl.append(o);
    }
    modelEl.value = s.model;
    nokey.classList.toggle("hidden", s.hasKey);
    sendBtn.disabled = !s.hasKey;
    renderContext(s.context);
    renderTodos(s.todos);
  } catch {}
}
modelEl.onchange = () => post("/model", { id: modelEl.value });

connect();
refreshState();
