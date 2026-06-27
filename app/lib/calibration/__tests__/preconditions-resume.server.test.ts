// TDD: autopilot Slice B (auto-resume on stockout-clear) — live precondition
// re-checks before an autonomous resume_campaign.
//
// MONEY-PATH INVARIANT: resuming a campaign restarts spend, so every gate is
// fail-safe — a missing datum or DB error returns ok:false (skip → stays queued),
// never ok:true.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  preconditionFresh,
  stockoutClearedResumeAllowed,
} from "../preconditions.server";
import type { Candidate } from "../../actions/autopilot-targeting.server";

type DbResult<T = unknown> = { data: T; error: null } | { data: null; error: { message: string } };

const recent = (minAgo: number) => new Date(Date.now() - minAgo * 60 * 1000).toISOString();

const resumeCandidate: Candidate = {
  alert_id: "alert-resume-1",
  detector_id: "sku_stockout_cleared",
  dollar_impact: 200,
  campaign_id: "camp-uuid",
  campaign_spend_cents: 0, // paused → near-zero recent spend
  daily_budget_cents: 10000,
};

// ---------------------------------------------------------------------------
// preconditionFresh — resume_campaign (campaign must be PAUSED, the inverse of pause)
// ---------------------------------------------------------------------------

function makeCampaignSb(campaign: Record<string, unknown> | null): SupabaseClient {
  return {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.maybeSingle = vi.fn(async () =>
        campaign ? { data: campaign, error: null } : { data: null, error: null },
      );
      return chain;
    }),
  } as unknown as SupabaseClient;
}

describe("preconditionFresh — resume_campaign", () => {
  it("ok:true when the campaign is currently paused and freshly synced", async () => {
    const sb = makeCampaignSb({
      id: "camp-uuid",
      status: "PAUSED",
      daily_budget_cents: 10000,
      last_synced_at: recent(30),
    });
    const r = await preconditionFresh({ kind: "resume_campaign", candidate: resumeCandidate, sb, nowMs: Date.now() });
    expect(r.ok).toBe(true);
  });

  it("ok:false when the campaign is already active (someone resumed it)", async () => {
    const sb = makeCampaignSb({
      id: "camp-uuid",
      status: "ACTIVE",
      daily_budget_cents: 10000,
      last_synced_at: recent(30),
    });
    const r = await preconditionFresh({ kind: "resume_campaign", candidate: resumeCandidate, sb, nowMs: Date.now() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/precondition_stale|not paused/i);
  });

  it("ok:false when campaign sync is stale (> 24h)", async () => {
    const sb = makeCampaignSb({
      id: "camp-uuid",
      status: "PAUSED",
      daily_budget_cents: 0,
      last_synced_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const r = await preconditionFresh({ kind: "resume_campaign", candidate: resumeCandidate, sb, nowMs: Date.now() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale_facts/);
  });

  it("ok:false on a DB read error (fail-safe)", async () => {
    const sb = {
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = vi.fn(self);
        chain.eq = vi.fn(self);
        chain.maybeSingle = vi.fn(async () => ({ data: null, error: { message: "timeout" } }));
        return chain;
      }),
    } as unknown as SupabaseClient;
    const r = await preconditionFresh({ kind: "resume_campaign", candidate: resumeCandidate, sb, nowMs: Date.now() });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stockoutClearedResumeAllowed — full live re-check (I4/I10 analogue for resume)
// ---------------------------------------------------------------------------

const resumeAlert = {
  id: "alert-resume-1",
  detector_id: "sku_stockout_cleared",
  entity_ref: { campaign_id: "camp-uuid", sku_id: "sku-uuid-1", sku: "SC-1" },
};

/** Mock returning per-table data: ad_campaign_dim (maybeSingle), action_audit
 *  (order/limit/maybeSingle = latest action on the campaign), inventory_level_fact (then). */
function makeResumeSb(opts: {
  campaign?: Record<string, unknown> | null;
  latestAction?: Record<string, unknown> | null;
  inventoryRows?: Array<{ sku_id: string; location_id: string; available: number; observed_at: string }>;
  errorTable?: string;
}): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.in = vi.fn(self);
      chain.filter = vi.fn(self);
      chain.gt = vi.fn(self);
      chain.order = vi.fn(self);
      chain.limit = vi.fn(self);
      chain.maybeSingle = vi.fn(async () => {
        if (opts.errorTable === table) return { data: null, error: { message: "db down" } };
        if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
        if (table === "action_audit") return { data: opts.latestAction ?? null, error: null };
        return { data: null, error: null };
      });
      chain.then = (resolve: (r: DbResult) => unknown) => {
        if (opts.errorTable === table) return Promise.resolve(resolve({ data: null, error: { message: "db down" } }));
        const data = table === "inventory_level_fact" ? (opts.inventoryRows ?? []) : [];
        return Promise.resolve(resolve({ data, error: null }));
      };
      return chain;
    }),
  } as unknown as SupabaseClient;
}

const pausedCampaign = { id: "camp-uuid", status: "PAUSED", last_synced_at: recent(30) };
const autopilotPause = { action_kind: "pause_campaign", actor_user_id: "autopilot", created_at: recent(60 * 24 * 5) };
const restocked = [{ sku_id: "sku-uuid-1", location_id: "loc-1", available: 60, observed_at: recent(20) }];

describe("stockoutClearedResumeAllowed", () => {
  const SHOP_ID = "00000000-0000-0000-0000-000000000010";

  it("ok:true when paused, Calderyn's pause is the latest action, and stock is fresh & above buffer", async () => {
    const sb = makeResumeSb({ campaign: pausedCampaign, latestAction: autopilotPause, inventoryRows: restocked });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(true);
  });

  it("ok:false when the campaign is already active again", async () => {
    const sb = makeResumeSb({
      campaign: { id: "camp-uuid", status: "ACTIVE", last_synced_at: recent(30) },
      latestAction: autopilotPause,
      inventoryRows: restocked,
    });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when the latest action on the campaign was NOT Calderyn's pause (merchant takeover)", async () => {
    const sb = makeResumeSb({
      campaign: pausedCampaign,
      latestAction: { action_kind: "reduce_campaign_budget", actor_user_id: "merchant", created_at: recent(60) },
      inventoryRows: restocked,
    });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when stock is still below the buffer", async () => {
    const sb = makeResumeSb({
      campaign: pausedCampaign,
      latestAction: autopilotPause,
      inventoryRows: [{ sku_id: "sku-uuid-1", location_id: "loc-1", available: 12, observed_at: recent(20) }],
    });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when bufferUnits is missing/zero (fail-safe: unverifiable restock threshold)", async () => {
    const sb = makeResumeSb({ campaign: pausedCampaign, latestAction: autopilotPause, inventoryRows: restocked });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 0, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when the stock observation is stale (> 60 min)", async () => {
    const sb = makeResumeSb({
      campaign: pausedCampaign,
      latestAction: autopilotPause,
      inventoryRows: [{ sku_id: "sku-uuid-1", location_id: "loc-1", available: 60, observed_at: recent(90) }],
    });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when the alert has no campaign_id or sku_id", async () => {
    const sb = makeResumeSb({ campaign: pausedCampaign, latestAction: autopilotPause, inventoryRows: restocked });
    const r = await stockoutClearedResumeAllowed({
      shopId: SHOP_ID,
      alert: { ...resumeAlert, entity_ref: {} },
      bufferUnits: 30,
      sb,
    });
    expect(r.ok).toBe(false);
  });

  it("ok:false on a DB error reading the campaign (fail-safe)", async () => {
    const sb = makeResumeSb({ errorTable: "ad_campaign_dim", latestAction: autopilotPause, inventoryRows: restocked });
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb });
    expect(r.ok).toBe(false);
  });

  it("ok:false when the read throws (fail-safe wrapper)", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("network failure");
      },
    } as unknown as SupabaseClient;
    const r = await stockoutClearedResumeAllowed({ shopId: SHOP_ID, alert: resumeAlert, bufferUnits: 30, sb: throwingSb });
    expect(r.ok).toBe(false);
  });
});
