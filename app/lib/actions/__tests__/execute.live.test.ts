/**
 * LIVE executor-gateway test — exercises the REAL action pipeline (Supabase
 * ownership → adapter registry → Meta Graph API → action_audit) against the
 * live ad account. Skipped in CI and normal `npm test`; runs only when
 * META_LIVE_TEST=1.
 *
 * Run (loads secrets from .env.local for decrypt + Supabase service role):
 *   set -a; source .env.local; set +a
 *   META_LIVE_TEST=1 \
 *   META_LIVE_SHOP_ID=24c18b19-3a4f-4651-9446-969726c30223 \
 *   META_LIVE_SOURCE_CAMPAIGN_ID=<external id of a safe CBO test campaign> \
 *   META_LIVE_DEST_CAMPAIGN_ID=<external id of a second safe CBO test campaign> \
 *   META_LIVE_MUTATE=1 \
 *   npx vitest run app/lib/actions/__tests__/execute.live.test.ts
 *
 * Read-only by default (ingest sync + dim resolution). Mutating slices run
 * only with META_LIVE_MUTATE=1 AND explicit source/dest campaign ids — there
 * is deliberately no campaigns[0] fallback here, because these tests flip
 * status and rewrite budgets. Point them ONLY at paused, ad-set-free CBO test
 * campaigns (no ad sets = nothing can ever deliver). Every mutating test
 * restores the campaign's original status/budget in a finally block.
 */
import { describe, it, expect } from "vitest";
import { metaAdapter } from "../../meta/ingest.server";
import { pollAdsDaily } from "../../ads/ingest.server";
import { resolveCampaignDimId } from "../../ads/campaign-dim.server";
import { getSupabase } from "../../supabase.server";
import { metaActionAdapterForShop } from "../../meta/actions.server";
import { newIdempotencyKey } from "../../ids";
import { executeAction } from "../execute.server";
import { executeReallocation } from "../reallocate.server";
import { undoAction } from "../undo.server";
import {
  LIVE,
  MUTATE,
  liveShopId as shopId,
  liveSourceCampaignId as sourceExternalId,
  liveDestCampaignId as destExternalId,
  budgetCentsOrThrow,
  waitFor,
} from "../../__tests__/live-helpers";

// Mutating slices refuse to run without BOTH explicit test campaign ids.
const MUTATE_READY = MUTATE && Boolean(sourceExternalId && destExternalId);

/** Resolve the dim uuid for an external id, throwing if it was never ingested. */
async function dimIdOrThrow(externalId: string): Promise<string> {
  const id = await resolveCampaignDimId(getSupabase(), shopId, "meta", externalId);
  if (!id) throw new Error(`campaign ${externalId} not ingested into ad_campaign_dim — run the sync slice first`);
  return id;
}

/** Fetch the audit row the executor reports, for contract assertions. */
async function auditRow(auditId: string) {
  const { data, error } = await getSupabase()
    .from("action_audit")
    .select("action_kind, outcome, pre_state, post_state, params, undo_of")
    .eq("id", auditId)
    .single();
  if (error) throw error;
  return data;
}

describe.skipIf(!LIVE)("executor gateway (LIVE)", () => {
  it(
    "pollAdsDaily syncs the account's campaigns into ad_campaign_dim with their budgets",
    { timeout: 60000 },
    async () => {
      const sb = getSupabase();
      const source = await metaAdapter.connect(shopId);
      expect(source).not.toBeNull();
      await pollAdsDaily(source!, "meta", shopId, sb);

      const srcDimId = await resolveCampaignDimId(sb, shopId, "meta", sourceExternalId);
      const destDimId = await resolveCampaignDimId(sb, shopId, "meta", destExternalId);
      expect(srcDimId).not.toBeNull();
      expect(destDimId).not.toBeNull();

      const { data: src } = await sb
        .from("ad_campaign_dim")
        .select("status, daily_budget_cents")
        .eq("id", srcDimId!)
        .single();
      expect(src?.daily_budget_cents).toBe(1000);
      expect(String(src?.status).toLowerCase()).toBe("paused");
    },
  );

  describe.skipIf(!MUTATE_READY)("mutating actions (reversible)", () => {
    it(
      "executeAction resume_campaign activates the real Meta campaign and records a succeeded audit",
      { timeout: 60000 },
      async () => {
        const campaignId = await dimIdOrThrow(sourceExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        // Establish the pre-state rather than asserting it — order-independent.
        await adapter.pause(sourceExternalId);
        expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused")).toBe(
          "paused",
        );

        try {
          const result = await executeAction(
            shopId,
            { alertId: null, kind: "resume_campaign", campaignId, idempotencyKey: newIdempotencyKey() },
            getSupabase(),
          );
          expect(result.outcome).toBe("succeeded");

          const live = await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "active");
          expect(live).toBe("active");

          const audit = await auditRow(result.id);
          expect(audit.action_kind).toBe("resume_campaign");
          expect(audit.outcome).toBe("succeeded");
          expect((audit.params as { external_id?: string }).external_id).toBe(sourceExternalId);
        } finally {
          await adapter.pause(sourceExternalId);
        }
        expect(await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused")).toBe("paused");
      },
    );

    it(
      "executeAction pause_campaign pauses the real Meta campaign and records a succeeded audit",
      { timeout: 60000 },
      async () => {
        const campaignId = await dimIdOrThrow(sourceExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        // Pre-state: the pause action needs a running campaign to stop.
        await adapter.resume(sourceExternalId);
        await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "active");

        try {
          const result = await executeAction(
            shopId,
            { alertId: null, kind: "pause_campaign", campaignId, idempotencyKey: newIdempotencyKey() },
            getSupabase(),
          );
          expect(result.outcome).toBe("succeeded");

          const live = await waitFor(async () => (await adapter.getState(sourceExternalId)).status, "paused");
          expect(live).toBe("paused");

          const audit = await auditRow(result.id);
          expect(audit.action_kind).toBe("pause_campaign");
          expect(audit.outcome).toBe("succeeded");
          expect((audit.post_state as { status?: string }).status).toBe("paused");
        } finally {
          await adapter.pause(sourceExternalId);
        }
      },
    );

    it(
      "executeAction reduce_campaign_budget rewrites the real Meta daily budget, then restores it",
      { timeout: 60000 },
      async () => {
        const campaignId = await dimIdOrThrow(sourceExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        const originalCents = await budgetCentsOrThrow(adapter, sourceExternalId);
        const probeCents = originalCents === 700 ? 800 : 700;

        try {
          const result = await executeAction(
            shopId,
            {
              alertId: null,
              kind: "reduce_campaign_budget",
              campaignId,
              idempotencyKey: newIdempotencyKey(),
              dailyBudgetCents: probeCents,
            },
            getSupabase(),
          );
          expect(result.outcome).toBe("succeeded");

          const live = await waitFor(
            async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents,
            probeCents,
          );
          expect(live).toBe(probeCents);

          const audit = await auditRow(result.id);
          expect(audit.action_kind).toBe("reduce_campaign_budget");
          expect((audit.post_state as { daily_budget_cents?: number }).daily_budget_cents).toBe(probeCents);
        } finally {
          await adapter.setDailyBudget(sourceExternalId, originalCents);
        }
        expect(
          await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, originalCents),
        ).toBe(originalCents);
      },
    );

    it("executeAction refuses a reduce_campaign_budget with no positive budget (no platform call)", async () => {
      const campaignId = await dimIdOrThrow(sourceExternalId);
      const adapter = (await metaActionAdapterForShop(shopId))!;
      const before = await adapter.getState(sourceExternalId);

      await expect(
        executeAction(
          shopId,
          { alertId: null, kind: "reduce_campaign_budget", campaignId, idempotencyKey: newIdempotencyKey() },
          getSupabase(),
        ),
      ).rejects.toThrow(/no positive dailyBudgetCents/);

      // The refusal happened before any platform call: the live listing is untouched.
      const after = await adapter.getState(sourceExternalId);
      expect(after).toEqual(before);
    });

    it(
      "a replayed idempotency key returns the prior audit and does not re-execute on Meta",
      { timeout: 60000 },
      async () => {
        const campaignId = await dimIdOrThrow(sourceExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        const originalCents = await budgetCentsOrThrow(adapter, sourceExternalId);
        const probeCents = originalCents === 900 ? 950 : 900;
        const key = newIdempotencyKey();
        const input = {
          alertId: null,
          kind: "reduce_campaign_budget" as const,
          campaignId,
          idempotencyKey: key,
          dailyBudgetCents: probeCents,
        };

        try {
          const first = await executeAction(shopId, input, getSupabase());
          expect(first.outcome).toBe("succeeded");
          await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, probeCents);

          // Replay with a DIFFERENT budget: if the gateway re-executed, Meta
          // would move again — instead it must return the first audit untouched.
          const replay = await executeAction(
            shopId,
            { ...input, dailyBudgetCents: probeCents + 100 },
            getSupabase(),
          );
          expect(replay.id).toBe(first.id);
          expect(replay.outcome).toBe("succeeded");
          expect((await adapter.getState(sourceExternalId)).dailyBudgetCents).toBe(probeCents);
        } finally {
          await adapter.setDailyBudget(sourceExternalId, originalCents);
        }
      },
    );

    it(
      "executeReallocation moves daily budget source→dest on the real Meta account in one audit",
      { timeout: 90000 },
      async () => {
        const sourceCampaignId = await dimIdOrThrow(sourceExternalId);
        const destCampaignId = await dimIdOrThrow(destExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        const srcBefore = await budgetCentsOrThrow(adapter, sourceExternalId);
        const destBefore = await budgetCentsOrThrow(adapter, destExternalId);
        const amountCents = 300;

        try {
          const result = await executeReallocation(
            shopId,
            { alertId: null, sourceCampaignId, destCampaignId, amountCents, idempotencyKey: newIdempotencyKey() },
            getSupabase(),
          );
          expect(result.outcome).toBe("succeeded");

          expect(
            await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, srcBefore - amountCents),
          ).toBe(srcBefore - amountCents);
          expect(
            await waitFor(async () => (await adapter.getState(destExternalId)).dailyBudgetCents, destBefore + amountCents),
          ).toBe(destBefore + amountCents);

          const audit = await auditRow(result.id);
          expect(audit.action_kind).toBe("reallocate_budget");
          expect((audit.params as { amount_cents?: number }).amount_cents).toBe(amountCents);
        } finally {
          await adapter.setDailyBudget(sourceExternalId, srcBefore);
          await adapter.setDailyBudget(destExternalId, destBefore);
        }
      },
    );

    it(
      "undoAction reverses a reallocation: both real Meta budgets return to pre-state",
      { timeout: 90000 },
      async () => {
        const sourceCampaignId = await dimIdOrThrow(sourceExternalId);
        const destCampaignId = await dimIdOrThrow(destExternalId);
        const adapter = (await metaActionAdapterForShop(shopId))!;
        const srcBefore = await budgetCentsOrThrow(adapter, sourceExternalId);
        const destBefore = await budgetCentsOrThrow(adapter, destExternalId);
        const amountCents = 200;

        try {
          const result = await executeReallocation(
            shopId,
            { alertId: null, sourceCampaignId, destCampaignId, amountCents, idempotencyKey: newIdempotencyKey() },
            getSupabase(),
          );
          expect(result.outcome).toBe("succeeded");
          await waitFor(async () => (await adapter.getState(destExternalId)).dailyBudgetCents, destBefore + amountCents);

          const undo = await undoAction(shopId, result.id, getSupabase());
          expect(
            await waitFor(async () => (await adapter.getState(sourceExternalId)).dailyBudgetCents, srcBefore),
          ).toBe(srcBefore);
          expect(
            await waitFor(async () => (await adapter.getState(destExternalId)).dailyBudgetCents, destBefore),
          ).toBe(destBefore);

          const undoRow = await auditRow(undo.id);
          expect(undoRow.undo_of).toBe(result.id);
          expect(undoRow.outcome).toBe("succeeded");
        } finally {
          // Undo is the restore; this is the fallback if it failed mid-way.
          await adapter.setDailyBudget(sourceExternalId, srcBefore);
          await adapter.setDailyBudget(destExternalId, destBefore);
        }
      },
    );

    it("executeReallocation refuses to drain the source budget (no platform calls)", async () => {
      const sourceCampaignId = await dimIdOrThrow(sourceExternalId);
      const destCampaignId = await dimIdOrThrow(destExternalId);
      const adapter = (await metaActionAdapterForShop(shopId))!;
      const srcBefore = await budgetCentsOrThrow(adapter, sourceExternalId);
      const destBefore = await budgetCentsOrThrow(adapter, destExternalId);

      await expect(
        executeReallocation(
          shopId,
          {
            alertId: null,
            sourceCampaignId,
            destCampaignId,
            amountCents: srcBefore, // would leave the source at $0
            idempotencyKey: newIdempotencyKey(),
          },
          getSupabase(),
        ),
      ).rejects.toThrow(/must leave the source budget above zero/);

      expect((await adapter.getState(sourceExternalId)).dailyBudgetCents).toBe(srcBefore);
      expect((await adapter.getState(destExternalId)).dailyBudgetCents).toBe(destBefore);
    });
  });
});
