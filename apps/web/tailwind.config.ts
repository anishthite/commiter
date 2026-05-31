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
        nerv: {
          bg: "#000000",
          orange: "#ff6600",
          amber: "#ffaa33",
          warn: "#ff0033",
          grid: "#2a1500",
          text: "#ffe8c8",
          dim: "#1a0a00",
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
