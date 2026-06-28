import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction, type ExecuteDeps } from "../execute.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreativeInput } from "~/lib/screener/types";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

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
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
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

const metaCampaign = { id: CAMP, shop_id: SHOP, external_id: "120", platform: "meta", status: "active", daily_budget_cents: 5000 };

function fakeDeps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    resolveMetaWriteClient: vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" })),
    listCampaignAdSets: vi.fn(async () => [{ id: "as1", name: "Prospecting", status: "ACTIVE" }]),
    createPausedAd: vi.fn(async () => ({ adId: "ad_777" })),
    ...over,
  };
}

describe("executeAction — push_creative_draft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a paused ad and writes a succeeded audit with created_ad_id (no campaign mirror)", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const deps = fakeDeps();
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h1", creative: CREATIVE },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(deps.createPausedAd).toHaveBeenCalledWith({}, { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE });
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect(audit?.rows as Record<string, unknown>).toMatchObject({
      action_kind: "push_creative_draft",
      outcome: "succeeded",
      post_state: { created_ad_id: "ad_777", status: "PAUSED", adset_id: "as1" },
      dollar_impact_at_exec: 0,
    });
    // a creative draft creates a NEW object — it must NOT mutate ad_campaign_dim
    expect(calls.updates.filter((u) => u.table === "ad_campaign_dim")).toEqual([]);
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("refuses (throws) when the creative is missing", async () => {
    const { sb } = fakeSb({ campaign: metaCampaign });
    await expect(
      executeAction(SHOP, { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h2" }, sb, fakeDeps()),
    ).rejects.toThrow(/creative/i);
  });

  it("is a no-op on a replayed idempotency key (does not create a second ad)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign: metaCampaign });
    const deps = fakeDeps();
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h1", creative: CREATIVE },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(deps.createPausedAd).not.toHaveBeenCalled();
  });

  it("records a failed audit on a non-Meta campaign (no ad created)", async () => {
    const { sb, calls } = fakeSb({ campaign: { ...metaCampaign, platform: "google" } });
    const deps = fakeDeps();
    await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h3", creative: CREATIVE },
      sb,
      deps,
    );
    expect(deps.createPausedAd).not.toHaveBeenCalled();
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).outcome).toBe("failed");
    expect((audit?.rows as Record<string, unknown>).post_state).toBeNull();
  });

  it("records a failed audit (fail-fast) when Meta is not connected", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => null) });
    await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h4", creative: CREATIVE },
      sb,
      deps,
    );
    expect(deps.createPausedAd).not.toHaveBeenCalled();
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).outcome).toBe("failed");
  });
});
