import { expect, test } from "bun:test";
import { formatSerper, keepRealImages, builtinTools } from "../src/tools.js";

const run = (t: any, input: any) => t.execute(input, {} as any);

test("search formats knowledge graph, answer, and organic with URLs", () => {
  const out = formatSerper("search", {
    knowledgeGraph: { title: "Bun", description: "JS runtime", website: "https://bun.sh" },
    answerBox: { answer: "42" },
    organic: [{ title: "Bun docs", link: "https://bun.sh/docs", snippet: "fast" }],
  });
  expect(out).toContain("# Bun — JS runtime (https://bun.sh)");
  expect(out).toContain("answer: 42");
  expect(out).toContain("Bun docs — https://bun.sh/docs");
});

test("places shows address, rating, website", () => {
  const out = formatSerper("places", {
    places: [{ title: "Cafe", address: "1 Main St", rating: 4.5, ratingCount: 20, website: "https://c.com" }],
  });
  expect(out).toContain("Cafe — 1 Main St | 4.5★ (20) | https://c.com");
});

test("videos show url, duration, channel", () => {
  const out = formatSerper("videos", {
    videos: [{ title: "Bun in 100s", link: "https://youtu.be/x", videoUrl: "https://gstatic/redirect", duration: "2:13", channel: "Fireship" }],
  });
  expect(out).toContain("Bun in 100s — https://youtu.be/x (2:13) | Fireship");
});

test("empty results give a clear message", () => {
  expect(formatSerper("shopping", {})).toBe("no shopping results");
});

test("keepRealImages keeps only urls that serve an image content-type", async () => {
  const orig = globalThis.fetch;
  // stub: URLs containing "good" serve an image (webp), everything else is HTML
  globalThis.fetch = (async (url: string) => {
    const isImg = String(url).includes("good");
    return new Response(isImg ? "x" : "<html>", {
      status: 200,
      headers: { "content-type": isImg ? "image/webp" : "text/html" },
    });
  }) as any;
  try {
    const kept = await keepRealImages([
      { src: "https://x/good.webp" }, // webp image → kept
      { src: "https://x/dead.html" }, // HTML page → dropped
      { src: "https://x/good2" }, // image, no extension → kept (content-type, not ext)
    ]);
    expect(kept.map((k) => k.src)).toEqual(["https://x/good.webp", "https://x/good2"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("file tools refuse paths outside the allowed roots", async () => {
  const t = builtinTools();
  expect(await run(t.read_file, { path: "/etc/passwd" })).toContain("outside the allowed folders");
  expect(await run(t.write_file, { path: "/etc/roots-test.txt", content: "x" })).toContain(
    "outside the allowed folders",
  );
  expect(await run(t.list_dir, { path: "/etc" })).toContain("outside the allowed folders");
  expect(await run(t.grep, { pattern: "root", path: "/etc" })).toContain("outside the allowed folders");
  expect(await run(t.glob, { pattern: "*", cwd: "/etc" })).toContain("outside the allowed folders");
});
