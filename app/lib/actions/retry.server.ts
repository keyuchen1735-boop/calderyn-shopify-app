// app/lib/actions/retry.server.ts
//
// Slice 5 — action-retry drain (queue-less, PostgREST-only).
//
// Ported in shape from the monorepo `workers/action-retry`. The
// `EXECUTOR_REGISTRY` below now covers the executable campaign kinds
// (pause/resume/reduce/reallocate budget), so this cron actively REPLAYS
// due `retrying` rows from `action_audit` against the per-shop adapter:
// it selects due rows, re-resolves the adapter, replays the action, and
// marks the row `succeeded` (with recovered dollars backfilled) or, on a
// permanent failure / attempt-cap, terminally `failed` (running any
// registered compensator first).
//
// Kinds with NO registered executor (e.g. snooze_alert) carry no platform
// replay: the drain leaves those rows UNTOUCHED (counted as `skipped`). A
// due `retrying` row is never marked `failed` just for lacking an executor
// — `failed` is terminal, so that would permanently kill a legitimate
// retry (rule 12: visible, non-destructive skip).
//
// Enum values are the LIVE `action_outcome` enum:
//   succeeded | failed | pending | retrying
// `action_kind` is the LIVE `action_kind` enum (pause_campaign,
// reduce_campaign_budget, exclude_geo, reallocate_inventory,
// create_po_draft, snooze_alert).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import type { ActionAdapter } from "../ads/actions";
import { isRetriableFailure } from "../ads/actions";
import { actionAdapterForShop } from "../ads/action-registry.server";
import type { ActionKind } from "../types";
import { acknowledgeAlert } from "../alerts.server";
import { recoveredCentsFromStates } from "../audit-impact";
import { recoveredDollarsForAlertAction } from "./execute.server";

export const MAX_ATTEMPTS = 5;

/** Bound the batch per tick to stay well under the function timeout. */
export const MAX_RETRY_ROWS = 20;

/**
 * Exponential backoff in seconds for a row that has already been
 * attempted `attempts` times: 30, 60, 120, 240, 480, capped at 600.
 * Pure — the cron gates on `completed_at < now() - backoff` in code
 * (rule 5: scheduling math is deterministic, not the model's job).
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(2, attempts - 1), 600);
}

/** The replay-relevant slice of an audit row's persisted `params`. */
export interface ReplayParams {
  external_id: string;
  platform: Platform;
  daily_budget_cents?: number | null;
  // reallocate_budget extras: dest-side replay is covered by the three fields
  // above (written dest-side at park time); these carry the source side for
  // post_state and terminal compensation.
  source_external_id?: string;
  source_platform?: Platform;
  source_prev_budget_cents?: number | null;
  source_new_budget_cents?: number | null;
}

/**
 * Re-issues one `action_kind` against an already-resolved adapter and
 * returns the post-state to persist on success. Throws on platform failure
 * (classified by `isRetriableFailure` in the drain).
 */
export type ActionReplayer = (
  adapter: ActionAdapter,
  params: ReplayParams,
) => Promise<{ post_state: unknown }>;

/**
 * Executor registry keyed by `action_kind`. Covers the three executable
 * campaign kinds that `executeAction` (execute.server.ts) can enqueue as
 * `retrying`. Non-campaign kinds (snooze_alert, exclude_geo, …) have no
 * platform replay and are intentionally absent — the drain skips them.
 */
export const EXECUTOR_REGISTRY: Record<string, ActionReplayer> = {
  pause_campaign: async (adapter, p) => {
    await adapter.pause(p.external_id);
    return { post_state: { status: "paused", daily_budget_cents: p.daily_budget_cents ?? null } };
  },
  resume_campaign: async (adapter, p) => {
    await adapter.resume(p.external_id);
    return { post_state: { status: "active", daily_budget_cents: p.daily_budget_cents ?? null } };
  },
  reduce_campaign_budget: async (adapter, p) => {
    await adapter.setDailyBudget(p.external_id, p.daily_budget_cents ?? 0);
    return { post_state: { status: "active", daily_budget_cents: p.daily_budget_cents ?? null } };
  },
  // Parked reallocations resume at the DEST-increase step only; the source
  // reduce already happened before the row was parked (reallocate.server.ts).
  reallocate_budget: async (adapter, p) => {
    await adapter.setDailyBudget(p.external_id, p.daily_budget_cents ?? 0);
    return {
      post_state: {
        source: { daily_budget_cents: p.source_new_budget_cents ?? null },
        dest: { daily_budget_cents: p.daily_budget_cents ?? null },
      },
    };
  },
};

/**
 * Consulted ONLY on the terminal-failure path. A parked reallocation has
 * already reduced its source budget; if the dest increase fails for good,
 * restore the source rather than leaving the merchant silently under-spending.
 * The result is recorded on the row's params either way (rule 12).
 */
export type ActionCompensator = (
  resolveAdapter: (shopId: string, platform: Platform) => Promise<ActionAdapter | null>,
  shopId: string,
  params: ReplayParams,
) => Promise<{ compensation: "succeeded" | "failed"; note: string }>;

export const COMPENSATOR_REGISTRY: Record<string, ActionCompensator> = {
  reallocate_budget: async (resolveAdapter, shopId, p) => {
    try {
      if (!p.source_platform || !p.source_external_id) {
        throw new Error("missing source replay params");
      }
      const adapter = await resolveAdapter(shopId, p.source_platform);
      if (!adapter) throw new Error(`${p.source_platform} not connected`);
      await adapter.setDailyBudget(p.source_external_id, p.source_prev_budget_cents ?? 0);
      return { compensation: "succeeded", note: "source budget restored" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { compensation: "failed", note: `compensation failed: ${msg}` };
    }
  },
};

interface AuditRow {
  id: string;
  shop_id: string;
  alert_id: string | null;
  action_kind: string;
  attempts: number;
  outcome: string;
  completed_at: string | null;
  pre_state: unknown;
  params: ReplayParams | null;
}

export interface DrainOptions {
  /** For tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override the batch bound (tests). */
  maxRows?: number;
  /**
   * Resolve the per-shop action adapter. Defaults to the live registry;
   * injected in tests to avoid real platform/DB calls.
   */
  resolveAdapter?: (
    shopId: string,
    platform: Platform,
  ) => Promise<ActionAdapter | null>;
}

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  /** Due rows left untouched because no executor is registered yet. */
  skipped: number;
  errors: string[];
}

/**
 * Drain due `retrying` rows from `action_audit`. Cron-shaped: NO pg-boss
 * re-enqueue — the next tick re-selects whatever is still due.
 *
 * Selection: outcome='retrying' AND attempts < MAX_ATTEMPTS, bounded.
 * Backoff gating (`completed_at < now() - backoff(attempts)`) is applied
 * in code per-row because the threshold depends on each row's attempts.
 * Per-row isolation: one row's failure never aborts the batch (rule 12).
 */
export async function drainActionRetries(
  sb: SupabaseClient,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const now = opts.now ?? (() => new Date());
  const maxRows = opts.maxRows ?? MAX_RETRY_ROWS;
  const resolveAdapter = opts.resolveAdapter ?? actionAdapterForShop;

  const result: DrainResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
    skipped: 0,
    errors: [],
  };

  const { data: rows, error: selErr } = await sb
    .from("action_audit")
    .select("id, shop_id, alert_id, action_kind, attempts, outcome, completed_at, pre_state, params")
    .eq("outcome", "retrying")
    .lt("attempts", MAX_ATTEMPTS)
    .order("completed_at", { ascending: true })
    .limit(maxRows);

  if (selErr) {
    result.errors.push(`select action_audit: ${selErr.message}`);
    return result;
  }

  const nowMs = now().getTime();

  for (const raw of (rows ?? []) as AuditRow[]) {
    try {
      // Already-succeeded short-circuit (defensive; the filter excludes
      // these, but a fetched row could race ahead).
      if (raw.outcome === "succeeded") {
        result.succeeded += 1;
        continue;
      }

      // Backoff gate (rule 5): skip rows not yet due.
      if (raw.completed_at) {
        const dueAtMs =
          new Date(raw.completed_at).getTime() +
          backoffSeconds(raw.attempts) * 1000;
        if (nowMs < dueAtMs) {
          continue;
        }
      }

      const replayer = EXECUTOR_REGISTRY[raw.action_kind];
      if (!replayer || !raw.params) {
        // No platform replay for this kind (e.g. snooze_alert), or the row
        // carries no params to replay. Leave it UNTOUCHED — a due `retrying`
        // row must never be marked `failed` for lack of an executor, since
        // `failed` is terminal (rule 12: visible, non-destructive skip).
        result.skipped += 1;
        continue;
      }

      result.processed += 1;
      const nextAttempts = raw.attempts + 1;

      // Replay against the resolved adapter. A throw here is isolated to this
      // row and classified transient-by-default (rule 5).
      let ok = false;
      let postState: unknown = null;
      let replayError: string | null = null;
      let terminal = false;
      try {
        const adapter = await resolveAdapter(raw.shop_id, raw.params.platform);
        if (!adapter) throw new Error(`${raw.params.platform} not connected`);
        const out = await replayer(adapter, raw.params);
        ok = true;
        postState = out.post_state;
      } catch (err) {
        replayError = err instanceof Error ? err.message : String(err);
        // Permanent failure, or attempt cap reached → terminal `failed`.
        terminal = !isRetriableFailure(err) || nextAttempts >= MAX_ATTEMPTS;
      }

      const update: Record<string, unknown> = {
        attempts: nextAttempts,
        completed_at: now().toISOString(),
      };
      if (ok) {
        update.outcome = "succeeded";
        update.post_state = postState;
        update.last_error = null;
        // The row was inserted with dollar_impact_at_exec=0 (it was parked as
        // `retrying`, not succeeded). Backfill the recovered dollars now or a
        // retry-recovered action never counts toward the Recovered total:
        // alert-driven rows claw back the alert's at-stake dollars, no-alert
        // rows recover what their own budget states prove they stopped.
        update.dollar_impact_at_exec = raw.alert_id
          ? await recoveredDollarsForAlertAction(sb, raw.alert_id, raw.action_kind, raw.shop_id)
          : recoveredCentsFromStates(
              raw.action_kind as ActionKind,
              raw.pre_state,
              postState,
            ) / 100;
      } else {
        update.outcome = terminal ? "failed" : "retrying";
        update.last_error = replayError;
        if (terminal) {
          const compensate = COMPENSATOR_REGISTRY[raw.action_kind];
          if (compensate && raw.params) {
            const comp = await compensate(resolveAdapter, raw.shop_id, raw.params);
            update.params = { ...raw.params, compensation: comp.compensation };
            update.last_error = `${replayError}; ${comp.note}`;
          }
        }
      }

      const { error: updErr } = await sb
        .from("action_audit")
        .update(update)
        .eq("id", raw.id);
      if (updErr) {
        result.errors.push(`update ${raw.id}: ${updErr.message}`);
        continue;
      }

      // The synchronous execute path only acknowledges on an immediate
      // success; a success replayed here must do it too, or the alert
      // stays open after the action actually executed (rule 12).
      if (ok && raw.alert_id && !(await acknowledgeAlert(sb, raw.shop_id, raw.alert_id))) {
        result.errors.push(`acknowledge alert ${raw.alert_id} (audit ${raw.id}) failed`);
      }

      if (ok) result.succeeded += 1;
      else if (terminal) result.failed += 1;
      else result.retrying += 1;
    } catch (err) {
      // Per-row isolation: collect, never abort the batch (rule 12).
      result.errors.push(
        `row ${raw.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
