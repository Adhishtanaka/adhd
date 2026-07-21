import { expect, test } from "bun:test";
import { sanitize } from "../src/sanitize.js";

test("strips script and other dangerous tags", () => {
  expect(sanitize("<script>alert(1)</script>hi")).toBe("hi");
  expect(sanitize("<p>ok</p><style>x{}</style>")).toBe("<p>ok</p>");
  expect(sanitize("<svg onload=alert(1)></svg>a")).toBe("a");
  expect(sanitize("<iframe src=evil></iframe>")).toBe("");
});

test("strips event handlers, including the /onerror bypass", () => {
  expect(sanitize('<img src=x onerror="alert(1)">')).not.toContain("onerror");
  expect(sanitize("<img/onerror=alert(1)>")).not.toContain("onerror"); // no whitespace before on-handler
  expect(sanitize("<a onclick=alert(1)>x</a>")).not.toContain("onclick");
});

test("neutralizes dangerous url schemes in href/src", () => {
  expect(sanitize('<a href="javascript:alert(1)">x</a>')).toContain('href="#"');
  expect(sanitize("<a href=javascript:alert(1)>x</a>")).toContain('href="#"'); // unquoted
  expect(sanitize('<a href="java&#115;cript:alert(1)">x</a>')).toContain('href="#"'); // entity-encoded
  expect(sanitize('<img src="data:text/html,<script>alert(1)</script>">')).toContain('src="#"');
});

test("leaves safe content intact", () => {
  expect(sanitize('<a href="https://example.com">ok</a>')).toContain('href="https://example.com"');
  expect(sanitize("<p>plain <strong>text</strong></p>")).toBe("<p>plain <strong>text</strong></p>");
  expect(sanitize('<a href="#section">jump</a>')).toContain('href="#section"');
});
