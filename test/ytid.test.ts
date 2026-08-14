import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ytId lives in the browser bundle (app.js is a browser module with imports at the top),
// so lift it out by marker and eval it rather than duplicating it — same trick
// as specsig.test.ts.
const src = readFileSync(join(import.meta.dir, "..", "web", "src", "app.js"), "utf8");
const body = src.slice(src.indexOf("// YT_ID_START"), src.indexOf("// YT_ID_END"));
const ytId = new Function(body + "\nreturn ytId;")() as (s: unknown, p?: string) => string | null;

const ID = "dQw4w9WgXcQ"; // a real id is always exactly 11 chars

test("every URL shape YouTube actually hands out resolves to the id", () => {
  for (const u of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/watch?v=${ID}&list=PLabc&index=2`,
    // `v` is not the first param — the old regex missed this entirely
    `https://www.youtube.com/watch?app=desktop&v=${ID}`,
    `https://www.youtube.com/watch?feature=share&v=${ID}&t=1`,
    ID, // a bare id
  ]) {
    expect(ytId(u), u).toBe(ID);
  }
});

test("a playlist embed is not a video — this is what showed 'Video unavailable'", () => {
  // The old pattern accepted 6+ chars, so this produced the id "videoseries"
  // and YouTube answered with its error page inside our iframe.
  expect(ytId("https://www.youtube.com/embed/videoseries?list=PLabc123")).toBeNull();
  expect(ytId("https://www.youtube.com/playlist?list=PLabc123")).toBeNull();
});

test("anything that isn't a confident 11-char id returns null", () => {
  expect(ytId("https://vimeo.com/12345")).toBeNull();
  expect(ytId("https://example.com/watch?v=" + ID)).toBeNull(); // right shape, wrong host
  expect(ytId("https://notyoutube.com/watch?v=" + ID)).toBeNull();
  expect(ytId("https://www.youtube.com/watch?v=tooshort")).toBeNull();
  expect(ytId("https://www.youtube.com/@somechannel")).toBeNull();
  expect(ytId("")).toBeNull();
  expect(ytId(null)).toBeNull();
  expect(ytId(undefined)).toBeNull();
});

test("an explicit non-youtube provider always wins", () => {
  expect(ytId(`https://www.youtube.com/watch?v=${ID}`, "vimeo")).toBeNull();
  expect(ytId(`https://www.youtube.com/watch?v=${ID}`, "youtube")).toBe(ID);
});
