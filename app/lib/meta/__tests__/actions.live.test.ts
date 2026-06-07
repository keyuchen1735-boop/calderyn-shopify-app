/**
 * LIVE Meta action-layer test — exercises the REAL adapter against the live
 * Graph API using the shop's stored (encrypted) OAuth token. Skipped in CI and
 * normal `npm test`; runs only when META_LIVE_TEST=1.
 *
 * Run (loads secrets from .env.local for decrypt + Supabase service role):
 *   set -a; source .env.local; set +a
 *   META_LIVE_TEST=1 \
 *   META_LIVE_SHOP_DOMAIN=calderyn-shop-tester.myshopify.com \
 *   META_LIVE_SHOP_ID=24c18b19-3a4f-4651-9446-969726c30223 \
 *   META_LIVE_MUTATE=1 \
 *   npx vitest run app/lib/meta/__tests__/actions.live.test.ts
 *
 * Read-only by default (resolve client → list campaigns → getState). The
 * reversible pause→resume mutation runs only with META_LIVE_MUTATE=1 and always
 * restores the campaign's original status in a finally block.
 */
import { writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { metaClientForShop } from "../client.server";
import { metaActionAdapterForShop } from "../actions.server";
import { listCampaigns, getCampaignStatus } from "../campaigns.server";

const LIVE = process.env.META_LIVE_TEST === "1";
const MUTATE = process.env.META_LIVE_MUTATE === "1";
const shopDomain = process.env.META_LIVE_SHOP_DOMAIN ?? "";
const shopId = process.env.META_LIVE_SHOP_ID ?? "";

describe.skipIf(!LIVE)("Meta action layer (LIVE)", () => {
  it("resolves a live client + ad account for the connected shop", async () => {
    const conn = await metaClientForShop(shopDomain);
    expect(conn).not.toBeNull();
    expect(conn!.adAccountId).toMatch(/^act_/);
  });

  it("lists the account's existing campaigns (read-only)", async () => {
    const conn = await metaClientForShop(shopDomain);
    const campaigns = await listCampaigns(conn!.client, conn!.adAccountId);
    if (process.env.META_LIVE_OUT) {
      writeFileSync(
        process.env.META_LIVE_OUT,
        JSON.stringify({ adAccountId: conn!.adAccountId, count: campaigns.length, campaigns }, null, 2),
      );
    }
    expect(Array.isArray(campaigns)).toBe(true);
  });

  it("reads campaign state through the action adapter (read-only)", async () => {
    const conn = await metaClientForShop(shopDomain);
    const campaigns = await listCampaigns(conn!.client, conn!.adAccountId);
    if (campaigns.length === 0) return;
    const adapter = await metaActionAdapterForShop(shopId);
    expect(adapter).not.toBeNull();
    const state = await adapter!.getState(campaigns[0].id);
    expect(["active", "paused"]).toContain(state.status);
  });

  it.skipIf(!MUTATE)("pause→resume a campaign, then restore original status (reversible)", async () => {
    const conn = await metaClientForShop(shopDomain);
    const campaigns = await listCampaigns(conn!.client, conn!.adAccountId);
    expect(campaigns.length).toBeGreaterThan(0);
    const target = campaigns[0];
    const adapter = (await metaActionAdapterForShop(shopId))!;

    const original = (await getCampaignStatus(conn!.client, target.id)).toUpperCase();
    try {
      await adapter.pause(target.id);
      expect((await adapter.getState(target.id)).status).toBe("paused");
      await adapter.resume(target.id);
      expect((await adapter.getState(target.id)).status).toBe("active");
    } finally {
      if (original === "PAUSED") await adapter.pause(target.id);
      else await adapter.resume(target.id);
    }
    expect((await getCampaignStatus(conn!.client, target.id)).toUpperCase()).toBe(original);
  });
});
