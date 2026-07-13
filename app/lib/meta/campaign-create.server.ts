// Create the merchant's first campaign on Meta: campaign -> ad set -> creative
// + ad, ALL PAUSED so nothing spends until the merchant turns it on. Writes go
// through the retriable-aware `check` + `withRetry` so brief throttles back
// off and Meta-permanent errors (token/permission) fail terminally. If the ad
// set or the ad fails after the campaign was created, we roll back by
// deleting the campaign so a half-built object is never left live on the ad
// account. The MetaClient is injected so tests pass a fake post/get (mirrors
// meta/__tests__/duplicate-campaign.test.ts).

import { ActionError } from "../ads/actions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaClient, type MetaResponse } from "./campaigns.server";
import { createPausedAd, type MetaWriteConn } from "./ad-create.server";
import type { CreativeInput } from "~/lib/screener/types";

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Mirrors the canonical list in meta/actions.server.ts. That module's `check` is
// NOT exported, so this write module keeps its own retriable-aware copy by repo
// convention (campaigns.server + actions.server + ad-create.server already each
// define their own).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    const codeStr = code != null ? ` (code ${code})` : "";
    throw new ActionError("meta", `${r.error.message}${codeStr}`, {
      retriable: !(code != null && META_PERMANENT_CODES.has(code)),
    });
  }
  return r;
}

export interface FirstCampaignInput {
  name: string;
  dailyBudgetCents: number; // pre-clamped by the route; asserted again here
  countryCode: string; // e.g. "US"
  creative: CreativeInput;
}

/**
 * Thrown when the post-failure rollback delete of the orphaned campaign
 * itself fails. Carries the campaign id so the caller (the Task 13 route) can
 * mark the run 'failed' (needs manual cleanup on Meta) rather than
 * 'rolled_back'. The original failure reason is preserved in the message so
 * nothing about the real cause is lost.
 */
export class RollbackFailedError extends Error {
  readonly orphanCampaignId: string;
  constructor(orphanCampaignId: string, originalMessage: string) {
    super(`rollback failed for orphaned Meta campaign ${orphanCampaignId}; original error: ${originalMessage}`);
    this.name = "RollbackFailedError";
    this.orphanCampaignId = orphanCampaignId;
  }
}

/**
 * Build the merchant's first campaign: POST campaign, then ad set, then
 * (via createPausedAd) the creative + ad. Everything is created PAUSED. If
 * the ad set or ad step fails, the campaign is deleted before the original
 * error is rethrown — we never leave a partial funnel live on the account.
 */
export async function createFirstCampaign(
  conn: MetaWriteConn,
  input: FirstCampaignInput,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<{ campaignId: string; adSetId: string; adId: string }> {
  const { client, adAccountId } = conn;

  if (input.dailyBudgetCents < 500 || input.dailyBudgetCents > 20000) {
    throw new Error("dailyBudgetCents out of range 500-20000");
  }

  const campaignRes = await withRetry(
    async () =>
      check(
        await client.post(`/${adAccountId}/campaigns`, {
          name: input.name,
          objective: "OUTCOME_SALES",
          status: "PAUSED",
          special_ad_categories: "[]",
        }),
      ),
    retry,
  );
  const campaignId = String((campaignRes as { id?: unknown }).id ?? "");
  if (!campaignId) throw new Error("Meta did not return a campaign id");

  try {
    const adSetRes = await withRetry(
      async () =>
        check(
          await client.post(`/${adAccountId}/adsets`, {
            name: `${input.name} — Ad set`,
            campaign_id: campaignId,
            daily_budget: String(input.dailyBudgetCents),
            billing_event: "IMPRESSIONS",
            optimization_goal: "LINK_CLICKS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            status: "PAUSED",
            targeting: JSON.stringify({ geo_locations: { countries: [input.countryCode] } }),
          }),
        ),
      retry,
    );
    const adSetId = String((adSetRes as { id?: unknown }).id ?? "");
    if (!adSetId) throw new Error("Meta did not return an ad set id");

    const { adId } = await createPausedAd(client, { adAccountId, adSetId, creative: input.creative });

    return { campaignId, adSetId, adId };
  } catch (err) {
    const originalMessage = err instanceof Error ? err.message : String(err);
    try {
      await withRetry(async () => check(await client.post(`/${campaignId}`, { status: "DELETED" })), retry);
    } catch (rollbackErr) {
      // Log so the failure is visible in server logs, then surface a typed
      // error carrying both the orphan id and the ORIGINAL reason — never
      // mask why campaign creation actually failed.
      console.error(
        `createFirstCampaign: rollback delete failed for orphaned campaign ${campaignId}`,
        rollbackErr,
      );
      throw new RollbackFailedError(campaignId, originalMessage);
    }
    throw err;
  }
}
