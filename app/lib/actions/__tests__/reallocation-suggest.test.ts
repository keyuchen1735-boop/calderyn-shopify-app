import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { suggestReallocation } from "../reallocation-suggest.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(opts: {
  campaigns: Array<Record<string, unknown>>;
  grades: Array<Record<string, unknown>>;
}) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "ad_campaign_dim" ? opts.campaigns : opts.grades, error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const camp = (id: string, platform: string, budget: number) => ({
  id, external_id: `x-${id}`, platform, name: `Camp ${id}`, daily_budget_cents: budget,
});
// grade rows arrive ordered day_bucket DESC (the query orders them).
const grade = (campaignId: string, g: string, roas: number, day = "2026-06-09") => ({
  campaign_id: campaignId, grade: g, roas, day_bucket: day,
});

describe("suggestReallocation", () => {
  it("picks the worst-graded source and the best winning cross-platform dest", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000), camp("c", "meta", 3000)],
      grades: [grade("a", "poor", 0.4), grade("b", "winning", 3.2), grade("c", "winning", 4.1)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest?.campaignId).toBe("c"); // higher ROAS wins the tie among winners
    expect(s.dest?.platform).toBe("meta");
  });

  it("returns dest null when no winning campaign exists on ANOTHER platform", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "google", 1000)],
      grades: [grade("a", "poor", 0.4), grade("b", "winning", 3.2)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest).toBeNull();
  });

  it("never suggests draining a winning campaign as source", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "winning", 3.0), grade("b", "winning", 4.0)],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source).toBeNull();
    expect(s.dest).toBeNull();
  });

  it("pins the source when sourceCampaignId is given (autopilot path)", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "okay", 1.1), grade("b", "winning", 3.2)],
    });
    const s = await suggestReallocation(SHOP, sb, { sourceCampaignId: "a" });
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest?.campaignId).toBe("b");
  });

  it("excludes ungraded campaigns entirely", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [grade("a", "poor", 0.4)], // b has no grade
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.source?.campaignId).toBe("a");
    expect(s.dest).toBeNull();
  });

  it("uses only the LATEST grade per campaign", async () => {
    const sb = fakeSb({
      campaigns: [camp("a", "google", 2000), camp("b", "meta", 1000)],
      grades: [
        grade("b", "winning", 3.2, "2026-06-09"), // latest first (desc order)
        grade("b", "poor", 0.2, "2026-06-01"),
        grade("a", "poor", 0.4, "2026-06-09"),
      ],
    });
    const s = await suggestReallocation(SHOP, sb);
    expect(s.dest?.campaignId).toBe("b");
  });
});
