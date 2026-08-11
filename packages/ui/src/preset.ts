// Tailwind preset (28 §2, 24 §7) — shared tokens for every ACOS surface.
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
      },
      borderRadius: {
        card: "0.625rem",
      },
    },
  },
} as const;
