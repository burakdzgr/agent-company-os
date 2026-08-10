// Flat ESLint config. Full boundary enforcement (eslint-plugin-boundaries,
// no-internal-modules) lands in T02 — the agent-framework blacklist is active
// from day one (29-MVP-PLAN.md §6, ADR-004).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "docs/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["crewai", "crewai/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langchain", "langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["langgraph", "langgraph/*"], message: "Agent frameworks are banned in core (ADR-004)." },
            { group: ["@langchain/*"], message: "Agent frameworks are banned in core (ADR-004)." },
          ],
        },
      ],
    },
  },
);
