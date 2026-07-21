import { expect, test } from "bun:test";
import { domainOf, recordFailure, isBadDomain, removeDomain } from "../src/failcache.js";

test("domainOf strips www and rejects junk", () => {
  expect(domainOf("https://www.example.com/x")).toBe("example.com");
  expect(domainOf("https://sub.example.com")).toBe("sub.example.com");
  expect(domainOf("not a url")).toBe("");
});

test("a domain turns bad after two failures", () => {
  const url = "https://test-failcache-xyz.invalid/page"; // fake — never collides with real data
  const d = domainOf(url);
  removeDomain(d); // clean slate
  recordFailure(url, "boom");
  expect(isBadDomain(d)).toBe(false); // one strike
  recordFailure(url, "boom again");
  expect(isBadDomain(d)).toBe(true); // two strikes → bad
  removeDomain(d); // cleanup, leave real cache untouched
  expect(isBadDomain(d)).toBe(false);
});

test("404 / not-found failures never count against the domain", () => {
  const url = "https://test-failcache-404.invalid/missing"; // fake
  const d = domainOf(url);
  removeDomain(d);
  recordFailure(url, "HTTP 404 Not Found");
  recordFailure(url, "page not found");
  recordFailure(url, "410 Gone");
  expect(isBadDomain(d)).toBe(false); // soft page-misses: domain stays searchable
  recordFailure(url, "HTTP 403 Forbidden");
  recordFailure(url, "connection refused");
  expect(isBadDomain(d)).toBe(true); // two real blocking failures → bad
  removeDomain(d);
});
