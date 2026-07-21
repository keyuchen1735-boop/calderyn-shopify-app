// D6 publish acknowledgment: the server publishes in seconds while the POST's
// response can lag minutes, so the studio confirms from the publication row.
// Baseline comparison (not wall clock) decides — clock skew between client
// and server must never fake or miss a confirmation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishAckReached } from "./client";
import { designerPublicationStatus } from "./publish.server";

const { getSupabase } = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/storebuilder/studio.server", () => ({ requirePublishableTenantDomain: vi.fn() }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  expireOverdueExperiment: vi.fn(),
  hasRunningExperiment: vi.fn(),
}));

const SHOP = "00000000-0000-0000-0000-000000000010";

type Row = { data: Record<string, unknown> | null; error: null };
function chain(result: Row) {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => result,
  };
  return q;
}

function supabaseWith(rows: { publication: Row; shop: Row }) {
  getSupabase.mockReturnValue({
    from: (table: string) => (table === "shops" ? chain(rows.shop) : chain(rows.publication)),
  });
}

describe("publishAckReached", () => {
  it("confirms when the timestamp moved past the pre-publish baseline", () => {
    expect(publishAckReached("2026-07-21T10:00:00Z", { publishedAt: "2026-07-21T10:05:00Z", storefrontUrl: null })).toBe(true);
  });

  it("confirms a first-ever publish (null baseline)", () => {
    expect(publishAckReached(null, { publishedAt: "2026-07-21T10:05:00Z", storefrontUrl: null })).toBe(true);
  });

  it("does not confirm while the row still carries the old publish", () => {
    expect(publishAckReached("2026-07-21T10:00:00Z", { publishedAt: "2026-07-21T10:00:00Z", storefrontUrl: null })).toBe(false);
  });

  it("does not confirm while no publication exists yet", () => {
    expect(publishAckReached(null, { publishedAt: null, storefrontUrl: null })).toBe(false);
  });
});

describe("designerPublicationStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports null status for a shop that never published", async () => {
    supabaseWith({ publication: { data: null, error: null }, shop: { data: null, error: null } });
    expect(await designerPublicationStatus(SHOP)).toEqual({ publishedAt: null, storefrontUrl: null });
  });

  it("reports the home snapshot's timestamp and the tenant storefront URL", async () => {
    supabaseWith({
      publication: { data: { published_at: "2026-07-21T10:05:00Z" }, error: null },
      shop: { data: { org_slug: "peakandpine" }, error: null },
    });
    expect(await designerPublicationStatus(SHOP)).toEqual({
      publishedAt: "2026-07-21T10:05:00Z",
      storefrontUrl: "https://peakandpine.calderyncompany.com/storefront",
    });
  });

  it("still reports the timestamp when the org slug is missing (no URL, no throw)", async () => {
    supabaseWith({
      publication: { data: { published_at: "2026-07-21T10:05:00Z" }, error: null },
      shop: { data: null, error: null },
    });
    expect(await designerPublicationStatus(SHOP)).toEqual({
      publishedAt: "2026-07-21T10:05:00Z",
      storefrontUrl: null,
    });
  });
});
