// Execute a budget reallocation: move N cents/day of daily budget from one
// campaign to another, possibly across platforms. Composite two-step action
// with ONE append-only action_audit row (one row per merchant intent).
// Ordering fails safe: the source is reduced FIRST, so any failure leaves the
// merchant under-spending, never over-spending. A permanent failure on the
// destination increase compensates by restoring the source budget (visibly);
// a transient destination failure parks `retrying` with DEST-side replay
// params so the single-adapter retry drain (retry.server.ts) can resume it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { isRetriableFailure } from "../ads/actions";
import { actionAdapterForShop } from "../ads/action-registry.server";
import {
  insertAuditWithIdempotency,
  priorExecutionForKey,
  type ExecutedAudit,
} from "./execute.server";

export interface ReallocateInput {
  alertId: string | null;
  sourceCampaignId: string; // ad_campaign_dim uuid
  destCampaignId: string; // ad_campaign_dim uuid
  amountCents: number; // daily-budget cents moved source -> dest
  idempotencyKey: string;
  actor?: string;
}

interface CampaignRow {
  id: string;
  external_id: string;
  platform: string;
  name: string;
  status: string;
  daily_budget_cents: number | null;
}

async function loadOwnedCampaign(
  sb: SupabaseClient,
  shopId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, shop_id, external_id, platform, name, status, daily_budget_cents")
    .eq("id", campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  return (data as CampaignRow | null) ?? null;
}

export async function executeReallocation(
  shopId: string,
  input: ReallocateInput,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // 1. Idempotency — same contract as executeAction: a replayed key returns
  // the REAL prior outcome (may still be `retrying` or `failed`), never a
  // hardcoded success (rule 12).
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return prior;

  // 2. Validation + ownership. Failures THROW with no audit row — like the
  // executeAction ownership guard, nothing was attempted on any platform.
  if (input.sourceCampaignId === input.destCampaignId) {
    throw new Error("source and destination must be different campaigns");
  }
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    throw new Error("amount must be a positive number of cents");
  }
  const source = await loadOwnedCampaign(sb, shopId, input.sourceCampaignId);
  if (!source) {
    throw new Error(`campaign ${input.sourceCampaignId} not found for shop (ownership check failed)`);
  }
  const dest = await loadOwnedCampaign(sb, shopId, input.destCampaignId);
  if (!dest) {
    throw new Error(`campaign ${input.destCampaignId} not found for shop (ownership check failed)`);
  }
  if (source.daily_budget_cents == null || dest.daily_budget_cents == null) {
    throw new Error("both campaigns must have a daily budget");
  }
  if (input.amountCents >= source.daily_budget_cents) {
    throw new Error("amount must leave the source budget above zero (pause the campaign instead)");
  }

  const sourceNewCents = source.daily_budget_cents - input.amountCents;
  const destNewCents = dest.daily_budget_cents + input.amountCents;
  const preState = {
    source: { daily_budget_cents: source.daily_budget_cents },
    dest: { daily_budget_cents: dest.daily_budget_cents },
  };
  const postState = {
    source: { daily_budget_cents: sourceNewCents },
    dest: { daily_budget_cents: destNewCents },
  };

  // 3. Resolve BOTH adapters before touching either platform — a missing
  // integration on either side fails fast with zero side effects.
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let step: "reduce_source" | "increase_dest" = "reduce_source";
  let compensation: "succeeded" | "failed" | undefined;

  const sourceAdapter = await actionAdapterForShop(shopId, source.platform as Platform);
  const destAdapter =
    dest.platform === source.platform
      ? sourceAdapter
      : await actionAdapterForShop(shopId, dest.platform as Platform);

  if (!sourceAdapter) {
    outcome = "failed";
    lastError = `${source.platform} not connected`;
  } else if (!destAdapter) {
    outcome = "failed";
    lastError = `${dest.platform} not connected`;
  } else {
    // 4a. Reduce source FIRST. Any failure here is terminal: nothing changed
    // on either platform, and the single-adapter retry drain can only resume
    // the dest step — so we fail visibly and let the merchant retry.
    try {
      await sourceAdapter.setDailyBudget(source.external_id, sourceNewCents);
      step = "increase_dest";
    } catch (err) {
      outcome = "failed";
      lastError = err instanceof Error ? err.message : String(err);
    }
    // 4b. Increase dest. Transient → park for the retry cron; permanent →
    // compensate by restoring the source budget, recording the result.
    if (outcome === "succeeded") {
      try {
        await destAdapter.setDailyBudget(dest.external_id, destNewCents);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (isRetriableFailure(err)) {
          outcome = "retrying";
        } else {
          outcome = "failed";
          try {
            await sourceAdapter.setDailyBudget(source.external_id, source.daily_budget_cents);
            compensation = "succeeded";
          } catch (cErr) {
            compensation = "failed";
            const cMsg = cErr instanceof Error ? cErr.message : String(cErr);
            lastError = `${lastError}; compensation failed: ${cMsg}`;
          }
        }
      }
    }
  }

  // 5. ONE append-only audit row + idempotency. Replay fields (external_id,
  // platform, daily_budget_cents) are DEST-side so the retry drain resumes
  // the increase step with its existing single-adapter shape.
  const params: Record<string, unknown> = {
    campaign_id: input.sourceCampaignId, // source side — existing cooldown lookups match it
    // Human-readable identifiers so audit surfaces (target column derives from
    // params) can label the row without resolving uuids.
    campaign_name: source.name,
    target: `${source.platform} · ${source.name} → ${dest.platform} · ${dest.name}`,
    source_campaign_id: input.sourceCampaignId,
    source_external_id: source.external_id,
    source_platform: source.platform,
    source_prev_budget_cents: source.daily_budget_cents,
    source_new_budget_cents: sourceNewCents,
    dest_campaign_id: input.destCampaignId,
    dest_external_id: dest.external_id,
    dest_platform: dest.platform,
    dest_new_budget_cents: destNewCents,
    amount_cents: input.amountCents,
    external_id: dest.external_id,
    platform: dest.platform,
    daily_budget_cents: destNewCents,
    step,
  };
  if (compensation) params.compensation = compensation;

  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: "reallocate_budget",
      params,
      outcome,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
    },
    sb,
  );
}
