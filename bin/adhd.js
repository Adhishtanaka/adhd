#!/usr/bin/env node
// The real entry point (src/web.ts) needs Bun's runtime (bun:sqlite, Bun.serve,
// TS with no build step) — it can't run under plain Node. This wrapper is
// deliberately plain, Bun-free JS so it works under EITHER runtime: if we're
// already inside Bun (e.g. `bunx adhd-cli`, which always executes a package's
// bin via Bun regardless of its shebang), just run the real entry directly.
// Otherwise — e.g. the npm-installed global `adhd` command, launched by Node
// because a shebang alone can't select an interpreter on every platform —
// hand off to a real `bun` process, and if there isn't one on PATH, say so
// clearly instead of letting a cryptic "Cannot find module 'bun:sqlite'" (or
// similar) surface first.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web.ts");

if (process.versions.bun) {
  await import(entry);
} else {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    const install =
      process.platform === "win32"
        ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
        : "curl -fsSL https://bun.sh/install | bash";
    console.error(
      "\nadhd needs Bun to run (https://bun.sh) — it wasn't found on your PATH.\n\n" +
        `Install it, then run adhd again:\n\n  ${install}\n`,
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
