import type { Config } from "tailwindcss";

/**
 * NERV theme tokens. Phase 3 will use these for the skinned dashboard;
 * Phase 1 just needs them to exist so the bare heatmap can show *something*.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Resolves to CSS variables defined in globals.css so the same
        // class names work for both light (default) and dark themes.
        // <alpha-value> lets Tailwind opacity modifiers (e.g. text-nerv-text/70)
        // still work — we hand it the channel-list form of the color.
        nerv: {
          bg: "rgb(var(--nerv-bg) / <alpha-value>)",
          orange: "rgb(var(--nerv-orange) / <alpha-value>)",
          amber: "rgb(var(--nerv-amber) / <alpha-value>)",
          warn: "rgb(var(--nerv-warn) / <alpha-value>)",
          grid: "rgb(var(--nerv-grid) / <alpha-value>)",
          text: "rgb(var(--nerv-text) / <alpha-value>)",
          dim: "rgb(var(--nerv-dim) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
