import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../github-digest/collect.server";
import { buildSocialPack, variationInstruction } from "../pack.server";

function activity(over: Partial<Activity> = {}): Activity {
  return {
    repo: "acme/app",
    sinceIso: "2026-06-10T00:00:00.000Z",
    commits: [{ subject: "feat: add peer benchmarks", sha: "a", actor: { key: "x", label: "X" } }],
    mergedPRs: [
      { number: 1, title: "feat(benchmarks): peer comparison vs niche", actor: { key: "x", label: "X" } },
      { number: 2, title: "feat(ship-cost/3pl): connect EasyPost + Shippo", actor: { key: "x", label: "X" } },
    ],
    openedPRs: [],
    branchesScanned: 1,
    branchesTotal: 1,
    notes: [],
    ...over,
  } as unknown as Activity;
}

afterEach(() => vi.unstubAllEnvs());

describe("variationInstruction", () => {
  it("returns empty string when variation is undefined", () => {
    expect(variationInstruction(undefined)).toBe("");
  });

  it("returns empty string when reasons array is empty", () => {
    expect(variationInstruction({ reasons: [] })).toBe("");
  });

  it("returns empty string when reasons array is empty even with note and priorCopy", () => {
    expect(variationInstruction({ reasons: [], note: "try again", priorCopy: ["old copy"] })).toBe("");
  });

  it("includes each reason, note, priorCopy, and regeneration/different keywords", () => {
    const result = variationInstruction({
      reasons: ["tone too salesy"],
      note: "more data",
      priorCopy: ["old headline"],
    });

    expect(result.toLowerCase()).toMatch(/regeneration/);
    expect(result.toLowerCase()).toMatch(/different/);
    expect(result).toContain("tone too salesy");
    expect(result).toContain("more data");
    expect(result).toContain("old headline");
  });

  it("handles multiple reasons joined in the output", () => {
    const result = variationInstruction({
      reasons: ["tone too salesy", "wrong feature highlighted"],
    });

    expect(result).toContain("tone too salesy");
    expect(result).toContain("wrong feature highlighted");
    expect(result.toLowerCase()).toMatch(/regeneration/);
    expect(result.toLowerCase()).toMatch(/different/);
  });

  it("works without optional note or priorCopy", () => {
    const result = variationInstruction({ reasons: ["too long"] });
    expect(result).toBeTruthy();
    expect(result).toContain("too long");
    // should not throw or include undefined/null strings
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  it("includes all priorCopy items when multiple are provided", () => {
    const result = variationInstruction({
      reasons: ["tone"],
      priorCopy: ["first rejected headline", "second rejected line"],
    });
    expect(result).toContain("first rejected headline");
    expect(result).toContain("second rejected line");
  });
});

describe("buildSocialPack with variation (no AI key — template fallback)", () => {
  it("returns a valid pack in template mode when variation is set and ANTHROPIC_API_KEY is unset", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { pack, mode } = await buildSocialPack({
      activity: activity(),
      range: "June 13–19, 2026",
      shippedCount: 3,
      waitlistDelta: 5,
      variation: {
        reasons: ["tone too salesy", "wrong feature highlighted"],
        note: "focus on inventory, not ads",
        priorCopy: ["Old headline that was rejected"],
      },
    });

    // must not throw; must return a valid pack
    expect(mode).toBe("template");
    expect(pack.shippedCount).toBe(3);
    expect(pack.waitlistDelta).toBe(5);
    // numbers still injected deterministically (not by model)
    expect(pack.linkedin.coverA).toContain("3 things");
    expect(pack.linkedin.ctaHeadline).toContain("5 store owners");
    // pack shape is complete
    expect(pack.linkedin.features).toHaveLength(2);
    expect(pack.instagram.bigNum).toBeTruthy();
  });

  it("does not throw when variation has an empty reasons array (falls through to template)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { mode } = await buildSocialPack({
      activity: activity(),
      range: "June 13–19, 2026",
      shippedCount: 1,
      waitlistDelta: 0,
      variation: { reasons: [] },
    });
    expect(mode).toBe("template");
  });
});
