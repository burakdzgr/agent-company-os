// Tailwind preset (28 §2, 24 §7, 36 §2) — shared tokens for every ACOS surface.
// `acos`/`dept`/`presence` scales come from the acosDark theme (36 §2); the
// legacy `ink`/`accent` scales stay for the pre-overhaul views (N6: additive).
import { acosDarkSurfaces, acosDarkText, presenceColors } from "./theme/acosDark.js";
import { departmentColors } from "./theme/departmentColors.js";

export const acosPreset = {
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7f9",
          100: "#e9ebf0",
          200: "#d3d8e2",
          400: "#8b94a7",
          600: "#4b5568",
          800: "#252c3b",
          900: "#161b26",
          950: "#0d1017",
        },
        accent: {
          400: "#6d8bff",
          500: "#4a6bfa",
          600: "#3a55d9",
        },
        ok: "#2fbf71",
        warn: "#e8a13c",
        danger: "#e5484d",
        acos: {
          bg0: acosDarkSurfaces["bg-0"],
          bg1: acosDarkSurfaces["bg-1"],
          bg2: acosDarkSurfaces["bg-2"],
          bg3: acosDarkSurfaces["bg-3"],
          line: acosDarkSurfaces.line,
          fg0: acosDarkText["fg-0"],
          fg1: acosDarkText["fg-1"],
          fg2: acosDarkText["fg-2"],
        },
        dept: departmentColors,
        presence: presenceColors,
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        card: "0.625rem",
      },
    },
  },
} as const;
