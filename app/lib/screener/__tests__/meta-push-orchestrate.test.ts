import { describe, it, expect, vi } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";
import { pushVariantToMeta } from "../meta-push.server";
import type { CreativeScreenRun, Variant } from "../types";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

const SHOP = "demo.myshopify.com";
const VARIANT: Variant = {
  mode: "copy",
  input: {
    imageUrl: "https://img.example/x.png",
    headline: "Glow serum",
    primaryText: "Hydrate overnight.",
    cta: "SHOP_NOW",
    destinationUrl: "https://shop.example/x",
    audience: "skincare",
  },
  rationale: "fixes hook",
  composite: 80,
  delta: 10,
  summary: "stronger hook",
};
const RUN: CreativeScreenRun = {
  id: "run_1",
  status: "done",
  source: "meta_ad",
  metaAdId: "ad_src",
  assumedSpendCents: 50_000,
  scorecard: null,
  error: null,
  createdAt: "2026-06-09",
  completedAt: "2026-06-09",
  creativeInput: null,
  variants: [VARIANT],
};

function metaSource() {
  return {
    get: vi.fn(async () => ({
      adset: { id: "adset_1" },
      creative: { object_story_spec: { page_id: "page_1" } },
    })),
    post: vi
      .fn()
      .mockResolvedValueOnce({ id: "creative_1" }) // POST /adcreatives
      .mockResolvedValueOnce({ id: "ad_new" }), // POST /ads
  };
}

describe("pushVariantToMeta", () => {
  it("creates a PAUSED ad in the source adset, then audits + records idempotency", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // idempotency check: not pushed yet
      { data: { id: "audit_1" }, error: null }, // action_audit insert
      { data: null, error: null }, // action_idempotency insert
    ]);
    const client = metaSource();
    const res = await pushVariantToMeta(
      { shop: SHOP, run: RUN, variantIndex: 0 },
      { client, adAccountId: "act_123" },
    );

    expect(res).toMatchObject({ ok: true, adId: "ad_new", alreadyPushed: false, error: null });

    // Reads the source ad's adset + page.
    expect(client.get).toHaveBeenCalledWith("/ad_src", {
      fields: "adset{id},creative{object_story_spec}",
    });
    // Creates the creative then the ad, PAUSED, in the source adset.
    const [creativePath] = client.post.mock.calls[0];
    const [adPath, adBody] = client.post.mock.calls[1];
    expect(creativePath).toBe("/act_123/adcreatives");
    expect(adPath).toBe("/act_123/ads");
    expect(adBody.status).toBe("PAUSED");
    expect(adBody.adset_id).toBe("adset_1");
    expect(JSON.parse(adBody.creative)).toEqual({ creative_id: "creative_1" });

    // Audit row uses the new action_kind and records the created ids.
    const inserts = getRecorded("insert");
    expect(inserts[0][0]).toMatchObject({
      action_kind: "push_creative",
      outcome: "succeeded",
      post_state: { ad_id: "ad_new", creative_id: "creative_1" },
    });
    expect(inserts[1][0]).toMatchObject({
      idempotency_key: "screener_push:run_1:0",
      audit_id: "audit_1",
    });
  });

  it("still reports success when the audit write fails after the ad is created", async () => {
    setSupabaseResponses([
      { data: null, error: null }, // idempotency check: not pushed
      { data: null, error: { message: "db unavailable" } }, // audit insert fails
    ]);
    const client = metaSource();
    const res = await pushVariantToMeta(
      { shop: SHOP, run: RUN, variantIndex: 0 },
      { client, adAccountId: "act_123" },
    );
    expect(res).toMatchObject({ ok: true, adId: "ad_new", alreadyPushed: false });
  });

  it("is idempotent: a prior push returns the existing ad id without calling Meta", async () => {
    setSupabaseResponses([
      { data: { audit_id: "audit_1" }, error: null }, // idempotency check: already pushed
      { data: { post_state: { ad_id: "ad_existing" } }, error: null }, // audit lookup
    ]);
    const client = metaSource();
    const res = await pushVariantToMeta(
      { shop: SHOP, run: RUN, variantIndex: 0 },
      { client, adAccountId: "act_123" },
    );
    expect(res).toMatchObject({ ok: true, adId: "ad_existing", alreadyPushed: true });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("rejects a manual (non-Meta) run without calling Meta", async () => {
    const client = metaSource();
    const res = await pushVariantToMeta(
      { shop: SHOP, run: { ...RUN, source: "manual", metaAdId: null }, variantIndex: 0 },
      { client, adAccountId: "act_123" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Meta/i);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range variant index", async () => {
    const client = metaSource();
    const res = await pushVariantToMeta(
      { shop: SHOP, run: RUN, variantIndex: 9 },
      { client, adAccountId: "act_123" },
    );
    expect(res.ok).toBe(false);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("returns an error DTO (no throw) when Meta rejects the request", async () => {
    setSupabaseResponses([{ data: null, error: null }]); // idempotency check: not pushed
    const client = {
      get: vi.fn(async () => ({ error: { message: "Unsupported request", code: 100 } })),
      post: vi.fn(),
    };
    const res = await pushVariantToMeta(
      { shop: SHOP, run: RUN, variantIndex: 0 },
      { client, adAccountId: "act_123" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unsupported request/);
    expect(client.post).not.toHaveBeenCalled();
  });
});
