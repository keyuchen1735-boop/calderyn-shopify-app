/**
 * LIVE extension-surface test — drives the REAL app.campaigns._index action
 * (form validation → dim resolution → executor gateway → Meta Graph API →
 * audit) with only Shopify admin auth and UI modules stubbed. Skipped in CI
 * and normal `npm test`; runs only when META_LIVE_TEST=1.
 *
 * Run (loads secrets from .env.local for decrypt + Supabase service role):
 *   set -a; source .env.local; set +a
 *   META_LIVE_TEST=1 \
 *   META_LIVE_SHOP_DOMAIN=calderyn-shop-tester.myshopify.com \
 *   META_LIVE_SHOP_ID=24c18b19-3a4f-4651-9446-969726c30223 \
 *   META_LIVE_SOURCE_CAMPAIGN_ID=<external id of a safe CBO test campaign> \
 *   META_LIVE_DEST_CAMPAIGN_ID=<external id of a second safe CBO test campaign> \
 *   META_LIVE_MUTATE=1 \
 *   npx vitest run app/routes/__tests__/campaigns-action.live.test.ts
 *
 * Same safety contract as execute.live.test.ts: mutating tests require BOTH
 * explicit test-campaign ids (paused, ad-set-free CBO campaigns) and restore
 * original status/budget in finally blocks.
 */
import { describe, it, expect, vi } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import { metaActionAdapterForShop } from "~/lib/meta/actions.server";
import { newIdempotencyKey } from "~/lib/ids";
import {
  LIVE,
  MUTATE,
  liveShopDomain as shopDomain,
  liveShopId as shopId,
  liveSourceCampaignId as sourceExternalId,
  liveDestCampaignId as destExternalId,
  budgetCentsOrThrow,
  waitFor,
} from "~/lib/__tests__/live-helpers";

const MUTATE_READY = MUTATE && Boolean(shopDomain && sourceExternalId && destExternalId);

// UI stubs so importing the route module doesn't pull the real component tree.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    BlockStack: Stub,
    Banner: Stub,
    Box: Stub,
    Button: Stub,
    ButtonGroup: Stub,
    Card: Stub,
    DataTable: Stub,
    InlineStack: Stub,
    Link: Stub,
    Modal: Stub,
    Page: Stub,
    Select: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));

// The ONLY behavioral stub: Shopify admin auth. Everything downstream is real.
vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: process.env.META_LIVE_SHOP_DOMAIN } }),
  },
}));

function formRequest(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://app.live-test.invalid/app/campaigns", { method: "POST", body: form });
}

describe.skipIf(!LIVE || !MUTATE_READY)("extension campaigns action surface (LIVE)", () => {
  it(
    "edit_budget intent rewrites the real Meta daily budget through the route action",
    { timeout: 60000 },
    async () => {
      const { action } = await import("../app.campaigns._index");
      const adapter = (await metaActionAdapterForShop(shopId))!;
      const originalCents = await budgetCentsOrThrow(adapter, sourceExternalId);
      const probeCents = originalCents === 650 ? 550 : 650;

      try {
        const res = toResponse(await action({
          request: formRequest({
            intent: "edit_budget",
            campaignId: sourceExternalId,
            campaignName: "CALDERYN LIVE TEST A",
            platform: "Meta",
            dailyBudgetCents: String(probeCents),
            idempotencyKey: newIdempotencyKey(),
          }),
          params: {},
          context: {},
        } as never));
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);

        expect(
          await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, probeCents),
        ).toBe(probeCents);
      } finally {
        await adapter.setDailyBudget(sourceExternalId, originalCents);
      }
      expect(
        await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, originalCents),
      ).toBe(originalCents);
    },
  );

  it(
    "resume then pause intents flip the real Meta campaign status through the route action",
    { timeout: 90000 },
    async () => {
      const { action } = await import("../app.campaigns._index");
      const adapter = (await metaActionAdapterForShop(shopId))!;
      // Establish the pre-state rather than asserting it — order-independent.
      await adapter.pause(sourceExternalId);
      await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused");

      const post = (intent: "pause" | "resume") =>
        action({
          request: formRequest({
            intent,
            campaignId: sourceExternalId,
            campaignName: "CALDERYN LIVE TEST A",
            platform: "Meta",
            idempotencyKey: newIdempotencyKey(),
          }),
          params: {},
          context: {},
        } as never);

      try {
        const resumeBody = (await toResponse(await post("resume")).json()) as { ok: boolean };
        expect(resumeBody.ok).toBe(true);
        expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "active")).toBe(
          "active",
        );

        const pauseBody = (await toResponse(await post("pause")).json()) as { ok: boolean };
        expect(pauseBody.ok).toBe(true);
        expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused")).toBe(
          "paused",
        );
      } finally {
        await adapter.pause(sourceExternalId);
      }
    },
  );

  it(
    "reallocate intent moves real Meta budget source→dest through the route action",
    { timeout: 90000 },
    async () => {
      const { action } = await import("../app.campaigns._index");
      const adapter = (await metaActionAdapterForShop(shopId))!;
      const srcBefore = await budgetCentsOrThrow(adapter, sourceExternalId);
      const destBefore = await budgetCentsOrThrow(adapter, destExternalId);
      const amountCents = 150;

      try {
        const res = toResponse(await action({
          request: formRequest({
            intent: "reallocate",
            campaignId: sourceExternalId,
            campaignName: "CALDERYN LIVE TEST A",
            platform: "Meta",
            destCampaignId: destExternalId,
            destPlatform: "Meta",
            destName: "CALDERYN LIVE TEST B",
            amountCents: String(amountCents),
            idempotencyKey: newIdempotencyKey(),
          }),
          params: {},
          context: {},
        } as never));
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);

        expect(
          await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, srcBefore - amountCents),
        ).toBe(srcBefore - amountCents);
        expect(
          await waitFor(async () => (await adapter.getState(destExternalId)).dailyBudgetCents, destBefore + amountCents),
        ).toBe(destBefore + amountCents);
      } finally {
        await adapter.setDailyBudget(sourceExternalId, srcBefore);
        await adapter.setDailyBudget(destExternalId, destBefore);
      }
    },
  );
});
