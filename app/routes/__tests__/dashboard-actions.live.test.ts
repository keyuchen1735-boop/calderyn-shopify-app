/**
 * LIVE dashboard-surface test — drives the REAL /dashboard/api route actions
 * (CSRF origin guard → validation → executor gateway → Meta Graph API → audit)
 * with only the dashboard session stubbed. Skipped in CI and normal `npm test`;
 * runs only when META_LIVE_TEST=1.
 *
 * Run (loads secrets from .env.local for decrypt + Supabase service role):
 *   set -a; source .env.local; set +a
 *   META_LIVE_TEST=1 \
 *   META_LIVE_SHOP_ID=24c18b19-3a4f-4651-9446-969726c30223 \
 *   META_LIVE_SOURCE_CAMPAIGN_ID=<external id of a safe CBO test campaign> \
 *   META_LIVE_DEST_CAMPAIGN_ID=<external id of a second safe CBO test campaign> \
 *   META_LIVE_MUTATE=1 \
 *   npx vitest run app/routes/__tests__/dashboard-actions.live.test.ts
 *
 * Same safety contract as execute.live.test.ts: mutating tests require the
 * explicit source test-campaign id (a paused, ad-set-free CBO campaign — these
 * tests only touch the source) and restore original status/budget in finally
 * blocks.
 */
import { describe, it, expect, vi } from "vitest";
import { getSupabase } from "~/lib/supabase.server";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { metaActionAdapterForShop } from "~/lib/meta/actions.server";
import { newIdempotencyKey } from "~/lib/ids";
import {
  LIVE,
  MUTATE,
  liveShopId as shopId,
  liveSourceCampaignId as sourceExternalId,
  budgetCentsOrThrow,
  waitFor,
} from "~/lib/__tests__/live-helpers";

const MUTATE_READY = MUTATE && Boolean(sourceExternalId);

// The ONLY stub: the dashboard session (cookie auth). Everything downstream —
// CSRF check, validation, executeAction, Meta call, audit insert — is real.
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: async () => ({ shopId: process.env.META_LIVE_SHOP_ID }),
}));

// requireSameOrigin reads DASHBOARD_PUBLIC_URL at call time; default it for
// the live run ONLY — vitest reuses worker processes across files, so an
// unconditional module-level env write could leak into env-fallback tests.
if (LIVE && !process.env.DASHBOARD_PUBLIC_URL) {
  process.env.DASHBOARD_PUBLIC_URL = "https://dashboard.live-test.invalid";
}
const ALLOWED_ORIGIN = LIVE ? new URL(process.env.DASHBOARD_PUBLIC_URL!).origin : "";

function actionRequest(path: string, body: unknown, origin = ALLOWED_ORIGIN): Request {
  return new Request(`${ALLOWED_ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!LIVE)("dashboard API surface (LIVE)", () => {
  it("rejects a cross-origin action POST before touching anything (CSRF)", async () => {
    const { action } = await import("../dashboard.api.campaigns.$id.action");
    const req = actionRequest("/dashboard/api/campaigns/x/action", {}, "https://evil.example");
    const res = await action({ request: req, params: { id: "x" }, context: {} } as never).catch(
      (thrown: Response) => thrown,
    );
    expect((res as Response).status).toBe(403);
  });

  describe.skipIf(!MUTATE_READY)("mutating actions (reversible)", () => {
    it(
      "POST resume_campaign activates the real Meta campaign through the dashboard route",
      { timeout: 60000 },
      async () => {
        const { action } = await import("../dashboard.api.campaigns.$id.action");
        const dimId = (await resolveCampaignDimId(getSupabase(), shopId, "meta", sourceExternalId))!;
        const adapter = (await metaActionAdapterForShop(shopId))!;
        // Establish the pre-state rather than asserting it — order-independent.
        await adapter.pause(sourceExternalId);
        await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused");

        try {
          const res = await action({
            request: actionRequest(`/dashboard/api/campaigns/${dimId}/action`, {
              type: "resume_campaign",
              idempotency_key: newIdempotencyKey(),
            }),
            params: { id: dimId },
            context: {},
          } as never);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { audit_id?: string; outcome?: string };
          expect(body.outcome).toBe("succeeded");
          expect(body.audit_id).toBeTruthy();

          expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "active")).toBe(
            "active",
          );
        } finally {
          await adapter.pause(sourceExternalId);
        }
        expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused")).toBe(
          "paused",
        );
      },
    );

    it(
      "POST pause_campaign pauses the real Meta campaign through the dashboard route",
      { timeout: 60000 },
      async () => {
        const { action } = await import("../dashboard.api.campaigns.$id.action");
        const dimId = (await resolveCampaignDimId(getSupabase(), shopId, "meta", sourceExternalId))!;
        const adapter = (await metaActionAdapterForShop(shopId))!;
        await adapter.resume(sourceExternalId);
        await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "active");

        try {
          const res = await action({
            request: actionRequest(`/dashboard/api/campaigns/${dimId}/action`, {
              type: "pause_campaign",
              idempotency_key: newIdempotencyKey(),
            }),
            params: { id: dimId },
            context: {},
          } as never);
          expect(res.status).toBe(200);
          expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused")).toBe(
            "paused",
          );
        } finally {
          await adapter.pause(sourceExternalId);
        }
      },
    );

    it(
      "POST reduce_campaign_budget rewrites the real Meta budget, then the undo route restores it",
      { timeout: 90000 },
      async () => {
        const { action } = await import("../dashboard.api.campaigns.$id.action");
        const { action: undoRoute } = await import("../dashboard.api.audit.$id.undo");
        const dimId = (await resolveCampaignDimId(getSupabase(), shopId, "meta", sourceExternalId))!;
        const adapter = (await metaActionAdapterForShop(shopId))!;
        const originalCents = await budgetCentsOrThrow(adapter, sourceExternalId);
        const probeCents = originalCents === 850 ? 750 : 850;

        try {
          const res = await action({
            request: actionRequest(`/dashboard/api/campaigns/${dimId}/action`, {
              type: "reduce_campaign_budget",
              idempotency_key: newIdempotencyKey(),
              daily_budget_cents: probeCents,
            }),
            params: { id: dimId },
            context: {},
          } as never);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { audit_id: string };
          expect(
            await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, probeCents),
          ).toBe(probeCents);

          // Undo through the REAL dashboard undo route — the restore IS the test.
          const undoRes = await undoRoute({
            request: actionRequest(`/dashboard/api/audit/${body.audit_id}/undo`, {}),
            params: { id: body.audit_id },
            context: {},
          } as never);
          expect(undoRes.status).toBe(200);
          expect(
            await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, originalCents),
          ).toBe(originalCents);
        } finally {
          await adapter.setDailyBudget(sourceExternalId, originalCents);
        }
      },
    );
  });
});
