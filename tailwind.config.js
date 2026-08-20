/** @type {import('tailwindcss').Config} */
export default {
  // src/**/*.ts is load-bearing: web.ts renders the settings/flows fragments
  // server-side, so their classes exist nowhere in the client module graph.
  content: ["./web/index.html", "./web/src/**/*.js", "./src/**/*.ts"],
  theme: {
    extend: {
      colors: {
        base: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        raise: "rgb(var(--c-surface-2) / <alpha-value>)",
        line: "rgb(var(--c-border) / <alpha-value>)",
        paper: "rgb(var(--c-text) / <alpha-value>)",
        dim: "rgb(var(--c-text-dim) / <alpha-value>)",
        signal: "rgb(var(--c-accent) / <alpha-value>)",
        gold: "rgb(var(--c-accent-2) / <alpha-value>)",
        done: "rgb(var(--c-positive) / <alpha-value>)",
        bad: "rgb(var(--c-negative) / <alpha-value>)",
        iris: "rgb(var(--c-info) / <alpha-value>)",
      },
      fontFamily: {
        display: ["Instrument Sans", "ui-sans-serif", "system-ui"],
        sans: ["Instrument Sans", "ui-sans-serif", "system-ui"],
        mono: ["DM Mono", "ui-monospace", "monospace"],
      },
    },
  },
};
