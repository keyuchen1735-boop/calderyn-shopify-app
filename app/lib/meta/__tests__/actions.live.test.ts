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
 * reversible pause→resume and budget mutations run only with META_LIVE_MUTATE=1
 * and always restore the campaign's original status + daily budget in a finally
 * block.
 *
 * Target a specific campaign by setting META_TEST_CAMPAIGN_ID=<id>; when unset
 * the read + mutate tests fall back to the account's first campaign
 * (campaigns[0]). Prefer pointing META_TEST_CAMPAIGN_ID at a safe, paused,
 * ad-set-free CBO test campaign so the full pause↔resume↔budget cycle is
 * exercisable without risking real spend.
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
const targetCampaignId = process.env.META_TEST_CAMPAIGN_ID ?? "";

/**
 * Resolve the campaign id under test: the explicit META_TEST_CAMPAIGN_ID when
 * set, otherwise the account's first listed campaign. Returns null when no
 * campaign is available (so read-only tests can no-op gracefully).
 */
async function resolveTargetCampaignId(
  client: Parameters<typeof listCampaigns>[0],
  adAccountId: string,
): Promise<string | null> {
  if (targetCampaignId) return targetCampaignId;
  const campaigns = await listCampaigns(client, adAccountId);
  return campaigns[0]?.id ?? null;
}

/**
 * Poll getState until the daily budget reflects `expectedCents`. Meta's
 * read-after-write is eventually consistent, so an immediate read can return the
 * stale value. Returns the last observed value (== expected on success, or the
 * final read on timeout so the caller's assertion shows the real mismatch).
 */
async function waitForBudgetCents(
  adapter: { getState: (id: string) => Promise<{ dailyBudgetCents: number | null }> },
  campaignId: string,
  expectedCents: number,
  timeoutMs = 10000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = (await adapter.getState(campaignId)).dailyBudgetCents;
    if (last === expectedCents || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

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
    const campaignId = await resolveTargetCampaignId(conn!.client, conn!.adAccountId);
    if (campaignId === null) return;
    const adapter = await metaActionAdapterForShop(shopId);
    expect(adapter).not.toBeNull();
    const state = await adapter!.getState(campaignId);
    expect(["active", "paused"]).toContain(state.status);
  });

  it.skipIf(!MUTATE)("pause→resume a campaign, then restore original status (reversible)", async () => {
    const conn = await metaClientForShop(shopDomain);
    const campaignId = await resolveTargetCampaignId(conn!.client, conn!.adAccountId);
    expect(campaignId).not.toBeNull();
    const adapter = (await metaActionAdapterForShop(shopId))!;

    const original = (await getCampaignStatus(conn!.client, campaignId!)).toUpperCase();
    try {
      await adapter.pause(campaignId!);
      expect((await adapter.getState(campaignId!)).status).toBe("paused");
      await adapter.resume(campaignId!);
      expect((await adapter.getState(campaignId!)).status).toBe("active");
    } finally {
      if (original === "PAUSED") await adapter.pause(campaignId!);
      else await adapter.resume(campaignId!);
    }
    expect((await getCampaignStatus(conn!.client, campaignId!)).toUpperCase()).toBe(original);
  });

  it.skipIf(!MUTATE)("setDailyBudget reflects via getState, then restores original budget (reversible)", async () => {
    const conn = await metaClientForShop(shopDomain);
    const campaignId = await resolveTargetCampaignId(conn!.client, conn!.adAccountId);
    expect(campaignId).not.toBeNull();
    const adapter = (await metaActionAdapterForShop(shopId))!;

    // Requires a campaign-level (CBO) budget; getState returns null otherwise.
    const before = await adapter.getState(campaignId!);
    expect(before.dailyBudgetCents).not.toBeNull();
    const originalCents = before.dailyBudgetCents!;
    // Pick a clearly different value (still tiny — campaign never delivers).
    const probeCents = originalCents === 600 ? 700 : 600;
    try {
      await adapter.setDailyBudget(campaignId!, probeCents);
      expect(await waitForBudgetCents(adapter, campaignId!, probeCents)).toBe(probeCents);
    } finally {
      await adapter.setDailyBudget(campaignId!, originalCents);
    }
    expect(await waitForBudgetCents(adapter, campaignId!, originalCents)).toBe(originalCents);
  });
});
