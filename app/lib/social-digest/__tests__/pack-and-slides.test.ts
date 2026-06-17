import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../github-digest/collect.server";
import { buildSocialPack } from "../pack.server";
import { buildCarousels } from "../slides.server";

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

describe("buildSocialPack (deterministic fallback)", () => {
  it("uses the template when no AI key, and injects the real numbers (never invents them)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { pack, mode } = await buildSocialPack({
      activity: activity(),
      range: "June 13–19, 2026",
      shippedCount: 2,
      waitlistDelta: 9,
    });
    expect(mode).toBe("template");
    expect(pack.shippedCount).toBe(2);
    expect(pack.waitlistDelta).toBe(9);
    expect(pack.linkedin.coverA).toContain("2 things");
    expect(pack.linkedin.ctaHeadline).toContain("9 store owners");
    // fallback feature copy is derived from merged PR titles, prefix stripped
    expect(pack.linkedin.features[0].title.toLowerCase()).toContain("peer comparison");
  });

  it("handles a zero-shipped week without claiming '0 things'", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { pack } = await buildSocialPack({
      activity: activity({ mergedPRs: [] }),
      range: "June 13–19, 2026",
      shippedCount: 0,
      waitlistDelta: 0,
    });
    expect(pack.linkedin.coverA).not.toContain("0 things");
    expect(pack.linkedin.ctaHeadline).toContain("in the open");
  });
});

describe("buildCarousels", () => {
  it("emits 4 distinct slides per platform with the pack's copy", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { pack } = await buildSocialPack({
      activity: activity(),
      range: "June 13–19, 2026",
      shippedCount: 2,
      waitlistDelta: 9,
    });
    const { linkedinHtml, instagramHtml } = buildCarousels(pack);

    expect((linkedinHtml.match(/class="slide"/g) ?? []).length).toBe(4);
    expect((instagramHtml.match(/class="slide"/g) ?? []).length).toBe(4);
    // numbers/copy actually land on the slides
    expect(linkedinHtml).toContain("2 things");
    expect(linkedinHtml).toContain("9 store owners");
    expect(instagramHtml).toContain(pack.instagram.bigNum);
    // the two platforms are not the same creative
    expect(linkedinHtml).not.toBe(instagramHtml);
    expect(instagramHtml).toContain("Calderyn · for Shopify");
  });
});
