import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_ROOT } from "./config.js";

// Remember which domains failed to fetch and why, so we stop wasting a turn
// re-fetching dead pages and can drop them from search results. Plain JSON at
// ~/.adhd/fetch-failures.json — a domain is "bad" once it has failed twice.
export const FAILCACHE_FILE = join(HOME_ROOT, "fetch-failures.json");
const BAD_THRESHOLD = 2;

export type Failure = { reason: string; count: number; lastTs: string };
type Cache = Record<string, Failure>;

function read(): Cache {
  if (!existsSync(FAILCACHE_FILE)) return {};
  try {
    const v = JSON.parse(readFileSync(FAILCACHE_FILE, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function write(c: Cache): void {
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(FAILCACHE_FILE, JSON.stringify(c, null, 2));
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// A 404 / "gone" / "not found" means THAT PAGE is missing — the domain is fine,
// so never hold it against the domain. Only blocking/dead-host failures (403,
// 401, 429, 5xx, timeouts, connection refused, DNS) should count toward the
// bad-domain threshold and get the domain dropped from future search results.
function isSoftPageMiss(reason: string): boolean {
  return /\b(404|410)\b|not[\s-]?found|\bgone\b/i.test(reason);
}

export function recordFailure(url: string, reason: string): void {
  const d = domainOf(url);
  if (!d) return;
  if (isSoftPageMiss(reason)) return; // a missing page isn't a bad domain
  const c = read();
  const prev = c[d];
  c[d] = { reason: reason.slice(0, 200), count: (prev?.count ?? 0) + 1, lastTs: new Date().toISOString() };
  write(c);
}

export function isBadDomain(domain: string): boolean {
  return (read()[domain.replace(/^www\./, "")]?.count ?? 0) >= BAD_THRESHOLD;
}

export function listFailures(): (Failure & { domain: string })[] {
  return Object.entries(read()).map(([domain, f]) => ({ domain, ...f }));
}

export function clearFailures(): void {
  write({});
}

export function removeDomain(domain: string): void {
  const c = read();
  delete c[domain.replace(/^www\./, "")];
  write(c);
}
