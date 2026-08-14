import { defineConfig } from "vite";

// Sources live in web/, the build lands in public/ — which is exactly what
// src/web.ts serves (and what the compiled binary expects beside it).
export default defineConfig({
  root: "web",
  base: "/",
  build: { outDir: "../public", emptyOutDir: true },
});
