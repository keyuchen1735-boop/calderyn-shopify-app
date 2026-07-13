import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction, type ExecuteDeps } from "../execute.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaClient, MetaResponse } from "../../meta/campaigns.server";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

function fakeSb(opts: { idempotent?: { audit_id: string }; campaign?: Record<string, unknown> | null }) {
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.update = vi.fn((payload: unknown) => {
      calls.updates.push({ table, payload });
      return chain;
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
      if (table === "action_audit") return { data: { id: "aud1", outcome: "succeeded" }, error: null };
      return { data: null, error: null };
    });
    // insert().select("id").single(): the ad_campaign_dim mirror insert yields
    // the new dim row id; the audit insert yields the audit id.
    chain.single = vi.fn(async () => ({
      data: { id: table === "ad_campaign_dim" ? "dim-copy-1" : "aud1" },
      error: null,
    }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const metaCampaign = {
  id: CAMP,
  shop_id: SHOP,
  external_id: "120",
  platform: "meta",
  status: "active",
  daily_budget_cents: 5000,
  name: "Summer Push",
};

// The write client is injected (same seam as push_creative_draft), so the REAL
// duplicateCampaign runs against this fake Graph client and we assert the wire call.
function fakeMetaConn(post?: MetaClient["post"]) {
  const client: MetaClient = {
    get: vi.fn(async () => ({} as MetaResponse)),
    post: post ?? vi.fn(async () => ({ copied_campaign_id: "999" } as unknown as MetaResponse)),
  };
  return { client, adAccountId: "act_1" };
}

function fakeDeps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    resolveMetaWriteClient: vi.fn(async () => fakeMetaConn()),
    ...over,
  };
}

describe("executeAction — duplicate_campaign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deep-copies the campaign paused, mirrors the copy into ad_campaign_dim, and audits it", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const conn = fakeMetaConn();
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => conn) });
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "duplicate_campaign", campaignId: CAMP, idempotencyKey: "d1" },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(conn.client.post).toHaveBeenCalledTimes(1);
    const [path, body] = (conn.client.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, string>];
    expect(path).toBe("/120/copies");
    expect(body.deep_copy).toBe("true");
    expect(body.status_option).toBe("PAUSED");
    const mirror = calls.inserts.find((i) => i.table === "ad_campaign_dim");
    expect(mirror?.rows as Record<string, unknown>).toMatchObject({
      shop_id: SHOP,
      external_id: "999",
      platform: "meta",
      name: "Summer Push (copy)",
      status: "paused",
      daily_budget_cents: 5000,
    });
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect(audit?.rows as Record<string, unknown>).toMatchObject({
      action_kind: "duplicate_campaign",
      outcome: "succeeded",
      post_state: { copied_campaign_external_id: "999", copied_campaign_dim_id: "dim-copy-1" },
      dollar_impact_at_exec: 0,
    });
    // duplicating creates a NEW campaign — it must NOT mutate the original's row
    expect(calls.updates.filter((u) => u.table === "ad_campaign_dim")).toEqual([]);
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("is a no-op on a replayed idempotency key (does not copy a second time)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign: metaCampaign });
    const conn = fakeMetaConn();
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => conn) });
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "duplicate_campaign", campaignId: CAMP, idempotencyKey: "d1" },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(conn.client.post).not.toHaveBeenCalled();
  });

  it("records a failed audit on a non-Meta campaign with merchant-facing copy (no platform call)", async () => {
    const { sb, calls } = fakeSb({ campaign: { ...metaCampaign, platform: "google" } });
    const conn = fakeMetaConn();
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => conn) });
    await executeAction(
      SHOP,
      { alertId: null, kind: "duplicate_campaign", campaignId: CAMP, idempotencyKey: "d2" },
      sb,
      deps,
    );
    expect(conn.client.post).not.toHaveBeenCalled();
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    const rows = audit?.rows as Record<string, unknown>;
    expect(rows.outcome).toBe("failed");
    expect(rows.post_state).toBeNull();
    // Copy must not blame the platform — no platform call was ever made.
    expect(String(rows.last_error)).toMatch(/only available for Meta campaigns/i);
    expect(String(rows.last_error)).not.toMatch(/rejected/i);
  });

  it("records a failed audit (fail-fast) when Meta is not connected", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => null) });
    await executeAction(
      SHOP,
      { alertId: null, kind: "duplicate_campaign", campaignId: CAMP, idempotencyKey: "d3" },
      sb,
      deps,
    );
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    const rows = audit?.rows as Record<string, unknown>;
    expect(rows.outcome).toBe("failed");
    expect(String(rows.last_error)).toMatch(/not connected/i);
  });
});
