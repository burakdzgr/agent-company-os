// T39 unit surface: registry integrity for the 14 MVP tools, pattern
// matching used by grants/policies, taint elevation, S2 env scrubbing.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMITS,
  elevateRisk,
  matchesToolPattern,
  rateLimitFor,
  scrubSecretEnv,
} from "./contract.js";
import { buildRegistry, getTool, listTools, toolRegistry } from "./registry.js";
import { dbInspect, fsRead, gitMerge, MVP_TOOLS, terminalRun, webSearch } from "./definitions.js";

describe("tool registry (17 §2)", () => {
  it("registers exactly the 14 MVP tools of 35 §9 (fs.edit added 2026-08-15)", () => {
    expect(listTools().map((t) => t.name).sort()).toEqual(
      [
        "fs.read",
        "fs.write",
        "fs.edit",
        "fs.search",
        "git.commit",
        "git.branch",
        "git.diff",
        "git.merge",
        "terminal.run",
        "db.inspect",
        "web.fetch",
        "web.search",
        "task.query",
        "memory.search",
      ].sort(),
    );
  });

  it("every definition is well-formed (risk, scopes, schemas, cost estimator)", () => {
    for (const def of toolRegistry.values()) {
      expect(["R0", "R1", "R2", "R3"]).toContain(def.risk);
      expect(def.scopes.length).toBeGreaterThan(0);
      expect(def.timeoutMs).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(10);
      // read-only tools are retry-safe, writers never are
      if (def.risk === "R0") expect(def.sideEffectFree).toBe(true);
      else expect(def.sideEffectFree).toBe(false);
      const estimate = def.estimateCost(def.input.parse(sampleInputFor(def.name)));
      expect(estimate.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects duplicate and badly-named definitions (fail-closed registry)", () => {
    expect(() => buildRegistry([fsRead, fsRead])).toThrow(/duplicate/);
    expect(() => buildRegistry([{ ...fsRead, name: "FsRead" }])).toThrow(/naming/);
    expect(getTool("no.such.tool")).toBeUndefined();
  });

  it("db.inspect refuses non-SELECT statements at the schema layer", () => {
    expect(() => dbInspect.input.parse({ query: "DELETE FROM users" })).toThrow();
    expect(dbInspect.input.parse({ query: "SELECT 1" }).maxRows).toBe(100);
    expect(() =>
      dbInspect.input.parse({ query: "with x as (select 1) select * from x" }),
    ).not.toThrow();
  });

  it("risk-class rate-limit defaults apply unless the tool overrides (17 §6)", () => {
    expect(rateLimitFor(fsRead)).toEqual(DEFAULT_RATE_LIMITS.R0);
    expect(rateLimitFor(terminalRun)).toEqual({ perAgentPerMin: 20, perCompanyPerMin: 200 });
    expect(rateLimitFor(gitMerge)).toEqual({ perAgentPerMin: 3, perCompanyPerMin: 15 });
  });

  it("web.search declares a server-side credential ref (S2)", () => {
    expect(webSearch.credentialRefs).toEqual(["search.api_key"]);
  });
});

describe("pattern matching + taint elevation", () => {
  it("matchesToolPattern: exact, prefix glob, full wildcard", () => {
    expect(matchesToolPattern("git.commit", "git.commit")).toBe(true);
    expect(matchesToolPattern("git.*", "git.commit")).toBe(true);
    expect(matchesToolPattern("git.*", "github.pr.merge")).toBe(false);
    expect(matchesToolPattern("*", "web.fetch")).toBe(true);
    expect(matchesToolPattern("fs.read", "fs.readdir")).toBe(false);
  });

  it("elevateRisk moves one class up and caps at R3 (17 §7.4)", () => {
    expect(elevateRisk("R0")).toBe("R1");
    expect(elevateRisk("R1")).toBe("R2");
    expect(elevateRisk("R2")).toBe("R3");
    expect(elevateRisk("R3")).toBe("R3");
  });
});

describe("S2 env scrubbing", () => {
  it("strips credential-looking keys before validation/audit", () => {
    const { env, scrubbed } = scrubSecretEnv({
      PATH: "/usr/bin",
      NODE_ENV: "test",
      GITHUB_TOKEN: "ghp_x",
      npm_config_registry_KEY: "k",
      DB_PASSWORD: "hunter2",
      MY_SECRET_VALUE: "s",
    });
    expect(env).toEqual({ PATH: "/usr/bin", NODE_ENV: "test" });
    expect(scrubbed.sort()).toEqual(
      ["DB_PASSWORD", "GITHUB_TOKEN", "MY_SECRET_VALUE", "npm_config_registry_KEY"].sort(),
    );
  });
});

function sampleInputFor(name: string): unknown {
  switch (name) {
    case "fs.read":
      return { path: "src/index.ts" };
    case "fs.write":
      return { path: "src/index.ts", content: "x" };
    case "fs.search":
      return { pattern: "TODO" };
    case "git.commit":
      return { message: "feat: x" };
    case "git.branch":
      return { branch: "task/81-x" };
    case "git.diff":
      return {};
    case "git.merge":
      return {
        taskId: "018f0000-0000-7000-8000-000000000001",
        branch: "task/81-x",
        expectedHeadSha: "a".repeat(40),
      };
    case "terminal.run":
      return { command: "npm test" };
    case "db.inspect":
      return { query: "select 1" };
    case "web.fetch":
      return { url: "https://registry.npmjs.org/react" };
    case "web.search":
      return { query: "fastify zod" };
    case "task.query":
      return {};
    case "memory.search":
      return { query: "auth conventions" };
    case "fs.edit":
      return { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" };
    default:
      throw new Error(`no sample input for ${name}`);
  }
}

// keep MVP_TOOLS referenced so the export surface is exercised
it("MVP_TOOLS export matches the registry size", () => {
  expect(MVP_TOOLS).toHaveLength(14);
});
