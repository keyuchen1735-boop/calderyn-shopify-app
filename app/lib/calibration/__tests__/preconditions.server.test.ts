// TDD: Slice 5 Task 4 — freshness re-check (I4) + stockout pause allowlist (I10)
//
// Schema reality (confirmed from prod DB):
//   sku_dim: id, shop_id, external_id, product_id, inventory_item_id, sku, title (NO inventory_policy, NO inventory_tracked)
//   inventory_level_fact: id, shop_id, sku_id, location_id, available, observed_at, source_version
//   ad_campaign_dim: id, shop_id, platform, external_id, name, status, daily_budget_cents, last_synced_at
//   alerts: id, shop_id, detector_id, entity_ref, status, dollar_impact, day_bucket, last_seen_at
//
// Fail-safe: if a required datum is unavailable (inventory_policy/tracking not in schema),
// return ok:false — never default to allowing the action.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  preconditionFresh,
  stockoutPauseAllowed,
} from "../preconditions.server";
import type { Candidate } from "../../actions/autopilot-targeting.server";

// ---------------------------------------------------------------------------
// Helpers: chainable Supabase builder mock
// ---------------------------------------------------------------------------

type DbResult<T = unknown> = { data: T; error: null } | { data: null; error: { message: string } };

/** Minimal chainable Supabase mock that resolves to a fixed result per table. */
function makeSb(tableResults: Record<string, DbResult>): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      const result = tableResults[table] ?? { data: null, error: { message: `no mock for table ${table}` } };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.in = vi.fn(self);
      chain.gt = vi.fn(self);
      chain.order = vi.fn(self);
      chain.limit = vi.fn(self);
      chain.maybeSingle = vi.fn(async () => {
        // Return first element or null for maybeSingle semantics.
        if (Array.isArray(result.data)) {
          return result.data.length > 0
            ? { data: result.data[0], error: null }
            : { data: null, error: null };
        }
        return result;
      });
      chain.then = (resolve: (r: DbResult) => unknown) => {
        return Promise.resolve(resolve(result));
      };
      return chain;
    }),
  } as unknown as SupabaseClient;
}

/** Campaign dim row: status='ACTIVE' means it's running on the platform.
 *  Calderyn stores status as-received from the platform (Meta: ACTIVE, Google: ENABLED, etc.)
 *  — we treat any truthy non-paused string as active. */
const activeCampaign = {
  id: "camp-uuid",
  status: "ACTIVE",
  daily_budget_cents: 10000,
  last_synced_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
};

const pausedCampaign = {
  id: "camp-uuid",
  status: "PAUSED",
  daily_budget_cents: 0,
  last_synced_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
};

const endedCampaign = {
  id: "camp-uuid",
  status: "ENDED",
  daily_budget_cents: 0,
  last_synced_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
};

const baseCandidate: Candidate = {
  alert_id: "alert-1",
  detector_id: "campaign_below_breakeven",
  dollar_impact: 80,
  campaign_id: "camp-uuid",
  campaign_spend_cents: 50000,
  daily_budget_cents: 10000,
};

// ---------------------------------------------------------------------------
// preconditionFresh — pause_campaign
// ---------------------------------------------------------------------------

describe("preconditionFresh — pause_campaign", () => {
  it("ok:true when campaign is active and still failing", async () => {
    const sb = makeSb({ ad_campaign_dim: { data: [activeCampaign], error: null } });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
  });

  it("ok:false when campaign is already paused", async () => {
    const sb = makeSb({ ad_campaign_dim: { data: [pausedCampaign], error: null } });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/precondition_stale/);
  });

  it("ok:false when campaign has ended", async () => {
    const sb = makeSb({ ad_campaign_dim: { data: [endedCampaign], error: null } });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/precondition_stale/);
  });

  it("ok:false when campaign row is not found (fail-safe)", async () => {
    const sb = makeSb({ ad_campaign_dim: { data: [], error: null } });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stale_facts|not found|precondition_stale/);
  });

  it("ok:false when campaign data is stale (last_synced_at > 24h ago)", async () => {
    const staleCampaign = {
      ...activeCampaign,
      last_synced_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    };
    const sb = makeSb({ ad_campaign_dim: { data: [staleCampaign], error: null } });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stale_facts/);
  });

  it("ok:false on a DB read error (fail-safe: never execute on unknown)", async () => {
    const sb = makeSb({
      ad_campaign_dim: { data: null, error: { message: "connection timeout" } },
    });
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("ok:false when preconditionFresh throws (fail-safe wrapper)", async () => {
    // Simulate a sb that throws synchronously (invalid proxy).
    const throwingSb = {
      from: () => {
        throw new Error("unexpected db failure");
      },
    } as unknown as SupabaseClient;
    const result = await preconditionFresh({
      kind: "pause_campaign",
      candidate: baseCandidate,
      sb: throwingSb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// preconditionFresh — reduce_campaign_budget
// ---------------------------------------------------------------------------

describe("preconditionFresh — reduce_campaign_budget", () => {
  it("ok:true when live budget is still above the intended target", async () => {
    // candidate.daily_budget_cents = 10000 (snapshot); live = 10000 → still above any target
    const sb = makeSb({ ad_campaign_dim: { data: [activeCampaign], error: null } });
    const reduceCand: Candidate = { ...baseCandidate, detector_id: "ad_tax_overload", daily_budget_cents: 10000 };
    const result = await preconditionFresh({
      kind: "reduce_campaign_budget",
      candidate: reduceCand,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
  });

  it("ok:false when live budget has already been reduced to <= the snapshot budget (stale)", async () => {
    // The snapshot says 10000; live says 4000 — already been reduced.
    // The precondition: live budget should match snapshot (no one else cut it).
    // If live < snapshot it was already cut; abort.
    const alreadyCutCampaign = {
      ...activeCampaign,
      daily_budget_cents: 4000, // someone already cut this
    };
    const sb = makeSb({ ad_campaign_dim: { data: [alreadyCutCampaign], error: null } });
    const reduceCand: Candidate = {
      ...baseCandidate,
      detector_id: "ad_tax_overload",
      daily_budget_cents: 10000, // view snapshot when alert was evaluated
    };
    const result = await preconditionFresh({
      kind: "reduce_campaign_budget",
      candidate: reduceCand,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/precondition_stale.*budget already/i);
  });

  it("ok:false on DB error (fail-safe)", async () => {
    const sb = makeSb({
      ad_campaign_dim: { data: null, error: { message: "timeout" } },
    });
    const reduceCand: Candidate = { ...baseCandidate, detector_id: "ad_tax_overload" };
    const result = await preconditionFresh({
      kind: "reduce_campaign_budget",
      candidate: reduceCand,
      sb,
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stockoutPauseAllowed (I10) — fail-safe schema gaps
// ---------------------------------------------------------------------------

const stockoutAlert = {
  id: "alert-stockout",
  detector_id: "sku_stockout_vs_spend",
  entity_ref: { sku_id: "sku-uuid-1", sku: "PP-SUMMIT-LOGO-TEE-M" },
  status: "open",
  dollar_impact: 50,
};

/** Build a sku_id-based inventory response from inventory_level_fact. */
function makeInvSb(opts: {
  campaignStatus?: string;
  campaignSyncedAt?: string;
  // inventory_level_fact rows
  inventoryRows?: Array<{ sku_id: string; location_id: string; available: number; observed_at: string }>;
}): SupabaseClient {
  const recentSyncedAt = opts.campaignSyncedAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const campaignRow = opts.campaignStatus !== undefined
    ? [{
        id: "camp-uuid",
        status: opts.campaignStatus,
        daily_budget_cents: 10000,
        last_synced_at: recentSyncedAt,
      }]
    : [];

  const defaultInvRow = {
    sku_id: "sku-uuid-1",
    location_id: "loc-1",
    available: 0,
    observed_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  };
  const invRows = opts.inventoryRows ?? [defaultInvRow];

  return {
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.in = vi.fn(self);
      chain.gt = vi.fn(self);
      chain.order = vi.fn(self);
      chain.limit = vi.fn(self);
      chain.maybeSingle = vi.fn(async () => {
        if (table === "ad_campaign_dim" && campaignRow.length > 0) {
          return { data: campaignRow[0], error: null };
        }
        return { data: null, error: null };
      });
      chain.then = (resolve: (r: DbResult) => unknown) => {
        let data: unknown[] = [];
        if (table === "inventory_level_fact") {
          data = invRows;
        } else if (table === "ad_campaign_dim") {
          data = campaignRow;
        }
        return Promise.resolve(resolve({ data, error: null }));
      };
      return chain;
    }),
  } as unknown as SupabaseClient;
}

describe("stockoutPauseAllowed (I10)", () => {
  const SHOP_ID = "00000000-0000-0000-0000-000000000010";

  // I10 requires inventory_policy='deny' and inventory_tracked=true, but these
  // columns DON'T EXIST in sku_dim. The function must fail-safe to ok:false.
  it("ok:false (fail-safe) because inventory_policy is not in schema — cannot verify not a preorder/backorder product", async () => {
    const sb = makeInvSb({
      campaignStatus: "ACTIVE",
      inventoryRows: [
        {
          sku_id: "sku-uuid-1",
          location_id: "loc-1",
          available: 0,
          observed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ],
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    // FAIL-SAFE: inventory_policy not available in schema → cannot confirm 'deny' → ok:false
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/inventory_policy|not available|fail.?safe|campaign_id/i);
  });

  it("ok:false when inventory_level_fact shows a sellable variant still in stock (available > 0)", async () => {
    const sb = makeInvSb({
      campaignStatus: "ACTIVE",
      inventoryRows: [
        {
          sku_id: "sku-uuid-1",
          location_id: "loc-1",
          available: 5, // still in stock at loc-1
          observed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ],
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    expect(result.ok).toBe(false);
    // Reason must mention the specific gate that failed
    expect(result.reason).toBeDefined();
  });

  it("ok:false when stock observation is older than 60 min (stale facts — subsumed by inventory_policy fail-safe)", async () => {
    // Even with stale stock data, the function returns ok:false. Since inventory_policy
    // is not in the schema, the fail-safe fires before the staleness check would run.
    // The test verifies ok:false regardless of which gate fires first.
    const sb = makeInvSb({
      campaignStatus: "ACTIVE",
      inventoryRows: [
        {
          sku_id: "sku-uuid-1",
          location_id: "loc-1",
          available: 0,
          observed_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), // 90 min ago
        },
      ],
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    expect(result.ok).toBe(false);
    // Reason is either stale_facts OR inventory_policy_not_available (both valid fail-safe responses)
    expect(result.reason).toBeDefined();
  });

  it("ok:false when campaign is not actively spending (PAUSED)", async () => {
    const sb = makeInvSb({
      campaignStatus: "PAUSED",
      inventoryRows: [
        {
          sku_id: "sku-uuid-1",
          location_id: "loc-1",
          available: 0,
          observed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ],
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    expect(result.ok).toBe(false);
    // Either precondition_stale (campaign not spending) or inventory_policy fail-safe
    expect(result.reason).toBeDefined();
  });

  it("ok:false when no inventory rows found (cannot confirm out-of-stock)", async () => {
    const sb = makeInvSb({
      campaignStatus: "ACTIVE",
      inventoryRows: [], // no data
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("ok:false when alert has no sku_id in entity_ref (cannot identify SKU)", async () => {
    const noSkuAlert = { ...stockoutAlert, entity_ref: {} };
    const sb = makeInvSb({ campaignStatus: "ACTIVE" });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: noSkuAlert,
      sb,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("ok:false when DB throws (fail-safe: treat thrown read as ok:false)", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("network failure");
      },
    } as unknown as SupabaseClient;
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb: throwingSb,
    });
    expect(result.ok).toBe(false);
  });

  // NOTE: stockoutPauseAllowed can ONLY return ok:true when:
  //   1. sku_id present in entity_ref
  //   2. inventory_policy = 'deny' (NOT IN SCHEMA → fail-safe ok:false always)
  //   3. inventory tracking on (NOT IN SCHEMA → fail-safe)
  //   4. all variants at 0 available across all locations
  //   5. fresh (<= 60 min)
  //   6. campaign actively spending
  //
  // Because inventory_policy and inventory_tracked are NOT in the schema,
  // stockoutPauseAllowed ALWAYS returns ok:false in the current schema.
  // This is the correct fail-safe behavior: when we can't verify the condition,
  // we don't allow the autonomous action.
  it("always returns ok:false in current schema (inventory_policy not synced — documented fail-safe)", async () => {
    // Even with perfect stock data (all 0, fresh, active campaign),
    // the function returns ok:false because inventory_policy cannot be verified.
    const sb = makeInvSb({
      campaignStatus: "ACTIVE",
      inventoryRows: [
        {
          sku_id: "sku-uuid-1",
          location_id: "loc-1",
          available: 0,
          observed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago (fresh)
        },
      ],
    });
    const result = await stockoutPauseAllowed({
      shopId: SHOP_ID,
      alert: stockoutAlert,
      sb,
    });
    // inventory_policy not in schema → fail-safe → ok:false
    expect(result.ok).toBe(false);
  });
});
