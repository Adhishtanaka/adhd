import { expect, test } from "bun:test";
import { normalizeMermaid } from "../web/src/mermaid.js";

const compactTitanic = `flowchart TD A["All 891 passengers<br/>38.4% survived"] --> B["Females 314<br/>74.2% survived"] A --> C["Males 577<br/>18.9% survived"] B --> B1["1st class 94<br/>96.8% survived"] B --> B2["2nd class 76<br/>92.1% survived"] B --> B3["3rd class 144<br/>50.0% survived"] C --> C1["1st class 122<br/>36.9% survived"] C --> C2["2nd class 108<br/>15.7% survived"] C --> C3["3rd class 347<br/>13.5% survived"] style A fill:#334155,color:#fff style B fill:#1e3a5f,color:#fff style B1 fill:#14532d,color:#fff style B2 fill:#166534,color:#fff style B3 fill:#4d7c0f,color:#fff style C fill:#7f1d1d,color:#fff style C1 fill:#b45309,color:#fff style C2 fill:#b91c1c,color:#fff style C3 fill:#7f1d1d,color:#fff`;

test("normalizes every statement in a compact one-line flowchart", () => {
  const normalized = normalizeMermaid(compactTitanic);
  expect(normalized).toContain("flowchart TD\nA[");
  expect(normalized).toContain("\nA --> C");
  expect(normalized).toContain("\nstyle C3 ");
  expect(normalized.split("\n")).toHaveLength(18);
});

test("leaves a valid multiline diagram unchanged", () => {
  const source = "flowchart LR\n  A --> B\n  style A fill:#334155";
  expect(normalizeMermaid(source)).toBe(source);
});
