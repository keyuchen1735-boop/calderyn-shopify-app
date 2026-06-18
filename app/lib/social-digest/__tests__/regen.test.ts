import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPriorCopy } from "../run.server";
import type { SocialPack } from "../slides.server";

// Module-level mock so the module cache sees it before run.server is resolved.
vi.mock("../../supabase.server", () => ({
  getSupabase: vi.fn(),
}));

// ---------------------------------------------------------------------------
// extractPriorCopy — pure, no I/O
// ---------------------------------------------------------------------------

function makePack(overrides: Partial<SocialPack> = {}): SocialPack {
  return {
    range: "June 13–19, 2026",
    shippedCount: 2,
    waitlistDelta: 5,
    linkedin: {
      coverA: "We shipped 2 things this week.",
      coverB: "Here's what's new.",
      features: [
        { title: "Peer benchmarks launched", support: "See how you rank.", metric: "New this week" },
        { title: "EasyPost connected", support: "Live shipping rates.", metric: "Shipping" },
      ],
      ctaHeadline: "5 store owners joined the waitlist this week.",
    },
    instagram: {
      coverA: "Is your store",
      coverHi: "actually",
      coverB: "doing well?",
      bigNum: "68th",
      bigLabel: "percentile in your niche — we shipped peer benchmarks so you finally know.",
      feature: { title: "Peer benchmarks", support: "Rank yourself.", metric: "New" },
      ctaHeadline: "Built this week. Building in the open.",
    },
    linkedinCaption: "Heads-down week of building.\n\ncalderyncompany.com\n#Shopify",
    instagramCaption: "Big week for merchants.\n\ncalderyncompany.com\n#DTC",
    ...overrides,
  };
}

describe("extractPriorCopy", () => {
  it("returns all expected copy fields from a SocialPack", () => {
    const pack = makePack();
    const result = extractPriorCopy(pack);

    expect(result).toContain("We shipped 2 things this week.");       // linkedin.coverA
    expect(result).toContain("Here's what's new.");                   // linkedin.coverB
    expect(result).toContain("Peer benchmarks launched");             // linkedin.features[0].title
    expect(result).toContain("EasyPost connected");                   // linkedin.features[1].title
    expect(result).toContain("5 store owners joined the waitlist this week."); // linkedin.ctaHeadline
    expect(result).toContain("Is your store");                        // instagram.coverA
    expect(result).toContain("actually");                             // instagram.coverHi
    expect(result).toContain("doing well?");                          // instagram.coverB
    expect(result).toContain("percentile in your niche — we shipped peer benchmarks so you finally know."); // instagram.bigLabel
    expect(result).toContain("Peer benchmarks");                      // instagram.feature.title
    expect(result).toContain("Heads-down week of building.\n\ncalderyncompany.com\n#Shopify"); // linkedinCaption
    expect(result).toContain("Big week for merchants.\n\ncalderyncompany.com\n#DTC");          // instagramCaption
  });

  it("filters out empty strings", () => {
    const pack = makePack({
      instagram: {
        coverA: "",
        coverHi: "actually",
        coverB: "doing well?",
        bigNum: "68th",
        bigLabel: "Some label",
        feature: { title: "Feature", support: "Support", metric: "Metric" },
        ctaHeadline: "Built this week.",
      },
    });
    const result = extractPriorCopy(pack);
    expect(result).not.toContain("");
    expect(result.every((s) => s.trim().length > 0)).toBe(true);
  });

  it("deduplicates identical strings", () => {
    // Make linkedin.coverA === linkedin.coverB to force a duplicate
    const pack = makePack({
      linkedin: {
        coverA: "Same headline",
        coverB: "Same headline",
        features: [
          { title: "Feature A", support: "S", metric: "M" },
          { title: "Feature B", support: "S", metric: "M" },
        ],
        ctaHeadline: "CTA",
      },
    });
    const result = extractPriorCopy(pack);
    const count = result.filter((s) => s === "Same headline").length;
    expect(count).toBe(1);
  });

  it("returns an array (not empty) for a fully-populated pack", () => {
    const result = extractPriorCopy(makePack());
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// regenerateDigest — cap branch (unit-testable without full I/O)
// ---------------------------------------------------------------------------

describe("regenerateDigest — cap branch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns {ok:false, capped:true} when regen_count >= MAX_REGENS (5)", async () => {
    // Wire the module-level mock to return a row with regen_count at the cap.
    const { getSupabase } = await import("../../supabase.server");
    vi.mocked(getSupabase).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "test-id",
                week_range: "June 13–19, 2026",
                since_iso: "2026-06-12T00:00:00.000Z",
                regen_count: 5,
                pack_json: makePack(),
                prior_copy_json: [],
                li_image_paths: [],
                ig_image_paths: [],
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof getSupabase>);

    const { regenerateDigest } = await import("../run.server");
    const result = await regenerateDigest("test-id", { reasons: ["tone"] });
    expect(result.ok).toBe(false);
    expect(result.capped).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns {ok:false, error} when regen_count is 4 but GITHUB_TOKEN is missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const { getSupabase } = await import("../../supabase.server");
    vi.mocked(getSupabase).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "test-id",
                week_range: "June 13–19, 2026",
                since_iso: "2026-06-12T00:00:00.000Z",
                regen_count: 4,
                pack_json: makePack(),
                prior_copy_json: [],
                li_image_paths: [],
                ig_image_paths: [],
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof getSupabase>);

    const { regenerateDigest } = await import("../run.server");
    const result = await regenerateDigest("test-id", { reasons: ["tone"] });
    expect(result.ok).toBe(false);
    expect(result.capped).toBeUndefined();
    expect(result.error).toMatch(/GITHUB_TOKEN/);
  });
});
