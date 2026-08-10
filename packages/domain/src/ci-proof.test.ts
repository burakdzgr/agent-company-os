// Deliberately failing fixture — T06 acceptance: a seeded failing unit test
// must block merge. This branch is never merged.
import { describe, expect, it } from "vitest";

describe("ci-proof", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
