// Extractive compression: given a fetched page and what the caller is looking
// for, return only the most relevant paragraphs (BM25-ranked) under a char
// budget — no LLM call, no deps, deterministic. ponytail: BM25 over paragraphs
// beats shipping a vector DB to trim one page.

const STOP = new Set(
  ("a an the of to and or is are was were be been being in on at for with as by from " +
    "this that these those it its it's you your we our they their he she his her i me my " +
    "do does did done have has had not no yes but if then else so than too very can could " +
    "will would should may might must about into over under out up down off then").split(" "),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2 && !STOP.has(t));
}

// Return the highest-BM25 paragraphs for `query`, in original document order,
// joined and kept under `budget` chars. Returns "" when there's nothing to rank
// against (empty query) or no paragraph matches — the caller then falls back to
// plain head-truncation.
// Pull images that carry real alt text out of fetched markdown, so the assistant
// can surface relevant ones. Skips alt-less decoration and data/icon URLs.
export function extractImages(markdown: string, limit = 8): { alt: string; src: string }[] {
  const out: { alt: string; src: string }[] = [];
  const seen = new Set<string>();
  const re = /!\[([^\]]+)\]\((https?:\/\/[^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) && out.length < limit) {
    const alt = m[1].trim();
    const src = m[2];
    if (!alt || alt.length < 2 || seen.has(src)) continue;
    if (/sprite|icon|logo|avatar|pixel|spacer|1x1/i.test(src)) continue;
    seen.add(src);
    out.push({ alt, src });
  }
  return out;
}

export function rankChunks(text: string, query: string, budget: number): string {
  const q = tokenize(query);
  if (q.length === 0) return "";

  const chunks = text
    .split(/\n{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length === 0) return "";

  const toks = chunks.map(tokenize);
  const N = chunks.length;
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / N || 1;

  // df per query term (how many chunks contain it)
  const df = new Map<string, number>();
  for (const term of new Set(q)) {
    let c = 0;
    for (const t of toks) if (t.includes(term)) c++;
    df.set(term, c);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = chunks.map((chunk, i) => {
    const t = toks[i];
    const dl = t.length || 1;
    let score = 0;
    for (const term of new Set(q)) {
      const n = df.get(term)!;
      if (n === 0) continue;
      const tf = t.filter((w) => w === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { i, chunk, score };
  });

  const relevant = scored.filter((s) => s.score > 0);
  if (relevant.length === 0) return "";

  // Greedily take the best chunks until the budget is spent, then restore
  // reading order.
  relevant.sort((a, z) => z.score - a.score);
  const picked: { i: number; chunk: string }[] = [];
  let used = 0;
  for (const s of relevant) {
    const cost = s.chunk.length + 2; // + join separator
    if (picked.length > 0 && used + cost > budget) break;
    picked.push({ i: s.i, chunk: s.chunk });
    used += cost;
    if (used >= budget) break;
  }
  picked.sort((a, z) => a.i - z.i);
  return picked.map((p) => p.chunk).join("\n\n");
}
