// Assistant markdown is rendered to HTML in the browser, but the model can echo
// content from fetched web pages — strip the obvious injection vectors before it
// hits innerHTML. ponytail: allowlist-free scrub, denylisting tags marked never
// emits + event handlers + dangerous url schemes. Enough for a localhost
// single-user tool; a real sanitizer (sanitize-html / DOMPurify) is the upgrade
// if this ever leaves localhost.
const DANGER_TAGS = "script|style|iframe|object|embed|svg|math|link|meta|base|form";

// Decode numeric HTML entities and drop whitespace/control chars the browser
// itself ignores inside a url scheme — so `java&#115;cript:` and `java\tscript:`
// are recognized as `javascript:` before we test them.
function deobfuscateScheme(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[\s\x00-\x1f]/g, "");
}

export function sanitize(h: string): string {
  return h
    .replace(new RegExp(`<\\s*(${DANGER_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\s*\\/?\\s*(${DANGER_TAGS})\\b[^>]*\\/?>`, "gi"), "")
    // event handlers, allowing '/' as the separator (e.g. <img/onerror=…>)
    .replace(/[\s/]on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // href/src pointing at a dangerous scheme (javascript:/data:/vbscript:),
    // after decoding entities and stripping ignored whitespace/control chars
    .replace(/(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr, val) =>
      /^["']?(?:javascript|data|vbscript):/i.test(deobfuscateScheme(val)) ? `${attr}="#"` : m,
    );
}
