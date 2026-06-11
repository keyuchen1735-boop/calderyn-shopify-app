import { describe, it, expect, vi } from "vitest";
import {
  MANUAL_SYNC_COOLDOWN_MS,
  manualSyncCooldown,
  syncShopAds,
  formatSyncToast,
} from "../manual-sync.server";
import type { AdWorkItem } from "../registry.server";
import type { SupabaseClient } from "@supabase/supabase-js";

const NOW = Date.parse("2026-06-11T15:00:00.000Z");

describe("manualSyncCooldown — spam-proofing the Sync now button", () => {
  it("allows a shop that has never synced", () => {
    const v = manualSyncCooldown(null, NOW);
    expect(v.allowed).toBe(true);
    expect(v.retryAfterSec).toBe(0);
  });

  it("blocks a shop that synced 2 minutes ago and says when to retry", () => {
    const v = manualSyncCooldown("2026-06-11T14:58:00.000Z", NOW);
    expect(v.allowed).toBe(false);
    // 5-minute cooldown - 2 minutes elapsed = 180s remaining
    expect(v.retryAfterSec).toBe(180);
  });

  it("allows a shop whose last sync is older than the cooldown", () => {
    const v = manualSyncCooldown("2026-06-11T14:54:59.000Z", NOW);
    expect(v.allowed).toBe(true);
  });

  it("allows exactly-at-cooldown-boundary syncs", () => {
    const boundary = new Date(NOW - MANUAL_SYNC_COOLDOWN_MS).toISOString();
    expect(manualSyncCooldown(boundary, NOW).allowed).toBe(true);
  });

  it("fails open on an unparseable timestamp", () => {
    expect(manualSyncCooldown("not-a-date", NOW).allowed).toBe(true);
  });
});

// --- syncShopAds orchestration -------------------------------------------

// Minimal sb stub: records shop_integrations updates, returns ok.
function sbStub() {
  const updates: Array<{ patch: Record<string, unknown>; shopId: string; kind: string }> = [];
  const sb = {
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_c1: string, shopId: string) => ({
          eq: async (_c2: string, kind: string) => {
            updates.push({ patch, shopId, kind });
            return { error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return { sb, updates };
}

function workItem(
  status: string,
  platform: string,
  connectResult: unknown = {},
): AdWorkItem {
  return {
    shopId: "shop-1",
    status,
    adapter: {
      platform,
      integrationKind: `${platform}_ads`,
      connect: vi.fn(async () => connectResult),
    },
  } as unknown as AdWorkItem;
}

describe("syncShopAds — on-demand per-shop ingest", () => {
  it("backfills a pending integration and marks it live", async () => {
    const { sb, updates } = sbStub();
    const item = workItem("pending", "tiktok");
    const backfill = vi.fn(async () => {});
    const poll = vi.fn(async () => {});

    const result = await syncShopAds(sb, "shop-1", {
      adaptersForShop: async () => [item],
      backfill,
      poll,
    });

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(result.synced).toEqual(["tiktok"]);
    expect(result.errors).toEqual([]);
    const live = updates.find((u) => u.patch.sync_status === "live");
    expect(live).toBeTruthy();
    expect(live!.kind).toBe("tiktok_ads");
    expect(live!.patch.last_sync_at).toBeTruthy();
  });

  it("polls a live integration", async () => {
    const { sb } = sbStub();
    const item = workItem("live", "meta");
    const backfill = vi.fn(async () => {});
    const poll = vi.fn(async () => {});

    const result = await syncShopAds(sb, "shop-1", {
      adaptersForShop: async () => [item],
      backfill,
      poll,
    });

    expect(poll).toHaveBeenCalledTimes(1);
    expect(backfill).not.toHaveBeenCalled();
    expect(result.synced).toEqual(["meta"]);
  });

  it("skips an integration whose adapter cannot connect", async () => {
    const { sb } = sbStub();
    const item = workItem("live", "google", null);

    const result = await syncShopAds(sb, "shop-1", {
      adaptersForShop: async () => [item],
      backfill: vi.fn(async () => {}),
      poll: vi.fn(async () => {}),
    });

    expect(result.synced).toEqual([]);
    expect(result.skipped).toEqual(["google"]);
    expect(result.errors).toEqual([]);
  });

  it("records an error for one platform without aborting the others", async () => {
    const { sb, updates } = sbStub();
    const bad = workItem("live", "google");
    const good = workItem("live", "meta");
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("DEVELOPER_TOKEN_NOT_APPROVED"))
      .mockResolvedValueOnce(undefined);

    const result = await syncShopAds(sb, "shop-1", {
      adaptersForShop: async () => [bad, good],
      backfill: vi.fn(async () => {}),
      poll,
    });

    expect(result.errors).toEqual([
      expect.stringContaining("DEVELOPER_TOKEN_NOT_APPROVED"),
    ]);
    expect(result.synced).toEqual(["meta"]);
    const errPatch = updates.find((u) => u.patch.sync_status === "error");
    expect(errPatch).toBeTruthy();
    expect(String(errPatch!.patch.sync_error)).toContain("DEVELOPER_TOKEN_NOT_APPROVED");
  });
});

describe("formatSyncToast — merchant-facing result message", () => {
  it("confirms a clean multi-platform sync with friendly platform names", () => {
    const t = formatSyncToast({ synced: ["meta", "tiktok"], skipped: [], errors: [] });
    expect(t.isError).toBe(false);
    expect(t.message).toBe("Synced Meta and TikTok.");
  });

  it("uses singular phrasing for one platform", () => {
    const t = formatSyncToast({ synced: ["meta"], skipped: [], errors: [] });
    expect(t.message).toBe("Synced Meta.");
  });

  it("reports nothing-to-sync without looking like an error", () => {
    const t = formatSyncToast({ synced: [], skipped: [], errors: [] });
    expect(t.isError).toBe(false);
    expect(t.message).toMatch(/no ad accounts/i);
  });

  it("flags a partial failure but still names what succeeded", () => {
    const t = formatSyncToast({
      synced: ["meta"],
      skipped: [],
      errors: ["google: DEVELOPER_TOKEN_NOT_APPROVED"],
    });
    expect(t.isError).toBe(true);
    expect(t.message).toContain("Meta");
    expect(t.message).toMatch(/google/i);
  });

  it("is an error when every platform failed", () => {
    const t = formatSyncToast({ synced: [], skipped: [], errors: ["google: x"] });
    expect(t.isError).toBe(true);
    expect(t.message).toMatch(/couldn.t sync/i);
  });
});
