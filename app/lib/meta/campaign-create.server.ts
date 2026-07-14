// Create the merchant's first campaign on Meta: campaign -> ad set -> creative
// + ad. The campaign is created PAUSED as the single on/off gate (a paused
// campaign gates all delivery, so nothing spends until the merchant turns it
// on); the ad set and ad are created ACTIVE so that resuming the campaign
// brings the whole funnel live in one flip. Writes go
// through the retriable-aware `check` + `withRetry` so brief throttles back
// off and Meta-permanent errors (token/permission) fail terminally. If the ad
// set or the ad fails after the campaign was created, we roll back by
// deleting the campaign so a half-built object is never left live on the ad
// account. The MetaClient is injected so tests pass a fake post/get (mirrors
// meta/__tests__/duplicate-campaign.test.ts).

import { ActionError } from "../ads/actions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaResponse } from "./campaigns.server";
import { createPausedAd, type MetaWriteConn } from "./ad-create.server";
import type { CreativeInput } from "~/lib/screener/types";

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Mirrors the canonical list in meta/actions.server.ts. That module's `check` is
// NOT exported, so this write module keeps its own retriable-aware copy by repo
// convention (campaigns.server + actions.server + ad-create.server already each
// define their own).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse, step: string): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    // Include subcode + error_user_msg when Meta sends them — they carry the
    // actually-actionable reason ("Invalid parameter" alone is useless to a
    // merchant reading the wizard's failure state).
    const codeStr =
      code != null
        ? ` (code ${code}${r.error.error_subcode != null ? `/${r.error.error_subcode}` : ""})`
        : "";
    const userMsg = r.error.error_user_msg ? ` — ${r.error.error_user_msg}` : "";
    throw new ActionError("meta", `${step}: ${r.error.message}${codeStr}${userMsg}`, {
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
 * (via createPausedAd) the creative + ad. The campaign is created PAUSED as the
 * single on/off gate; the ad set and ad are created ACTIVE so turning the
 * campaign on delivers the whole funnel. If the ad set or ad step fails, the
 * campaign is deleted before the original error is rethrown — we never leave a
 * partial funnel live on the account.
 *
 * `onCampaignCreated` (when given) is awaited with the new campaign id right
 * after the campaign POST resolves and BEFORE the ad-set step — the caller's
 * chance to bookkeep the id durably (the route writes it onto the wizard-run
 * row) so a crash mid-build never leaves an untracked object on Meta. If the
 * callback itself rejects, the build aborts before the ad set and the campaign
 * is rollback-deleted like any other partial failure: we never proceed past an
 * object our bookkeeping failed to record.
 */
export async function createFirstCampaign(
  conn: MetaWriteConn,
  input: FirstCampaignInput,
  retry: RetryOptions = DEFAULT_RETRY,
  onCampaignCreated?: (campaignId: string) => Promise<void>,
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
          // Required by Meta (error subcode 4834011) whenever the budget lives
          // on the ad set instead of the campaign. False = the merchant's
          // daily budget stays exactly on their ad set, never shared.
          is_adset_budget_sharing_enabled: "false",
        }),
        "campaign create",
      ),
    retry,
  );
  const campaignId = String((campaignRes as { id?: unknown }).id ?? "");
  if (!campaignId) throw new Error("Meta did not return a campaign id");

  try {
    // Bookkeeping checkpoint FIRST (inside the rollback scope): the id must be
    // durably recorded before any further Meta object exists. A rejection here
    // aborts before the ad set and rolls the campaign back below.
    if (onCampaignCreated) await onCampaignCreated(campaignId);

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
            status: "ACTIVE",
            targeting: JSON.stringify({ geo_locations: { countries: [input.countryCode] } }),
          }),
          "ad set create",
        ),
      retry,
    );
    const adSetId = String((adSetRes as { id?: unknown }).id ?? "");
    if (!adSetId) throw new Error("Meta did not return an ad set id");

    const { adId } = await createPausedAd(client, { adAccountId, adSetId, creative: input.creative, status: "ACTIVE" });

    return { campaignId, adSetId, adId };
  } catch (err) {
    const originalMessage = err instanceof Error ? err.message : String(err);
    try {
      await withRetry(
        async () => check(await client.post(`/${campaignId}`, { status: "DELETED" }), "rollback delete"),
        retry,
      );
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
