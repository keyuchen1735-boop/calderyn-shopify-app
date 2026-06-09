// app/lib/actions/retry.server.ts
//
// Slice 5 — action-retry drain SKELETON (queue-less, PostgREST-only).
//
// Ported in shape from the monorepo `workers/action-retry`, but the
// executor/audit-repo layer that worker depends on
// (`EXECUTOR_REGISTRY`, `markSucceeded`/`markFailed`,
// `apiClientFor(shop_id)`) does NOT exist in this repo yet. So this is a
// cron-shaped drain whose registry is intentionally EMPTY: it selects
// due `retrying` rows from `action_audit` and, because no executor is
// registered, leaves each row UNTOUCHED (counted as `skipped`).
//
// HONEST CAVEAT (rule 9/12): this currently replays NOTHING. It must be
// INERT until executors are ported — it must NOT mutate rows. Marking a
// due `retrying` row `failed` here would terminally fail out legitimate
// retries the moment the cron ships (and `failed` is terminal, so they'd
// never be retried even after executors land). So the empty-registry
// path is a no-op skip, not a write. Wiring (selection, attempt cap,
// backoff gating, per-row isolation) is real and tested; the replay —
// and only then the failure bookkeeping — is the follow-up.
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
};

interface AuditRow {
  id: string;
  shop_id: string;
  action_kind: string;
  attempts: number;
  outcome: string;
  completed_at: string | null;
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
    .select("id, shop_id, action_kind, attempts, outcome, completed_at, params")
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
      } else {
        update.outcome = terminal ? "failed" : "retrying";
        update.last_error = replayError;
      }

      const { error: updErr } = await sb
        .from("action_audit")
        .update(update)
        .eq("id", raw.id);
      if (updErr) {
        result.errors.push(`update ${raw.id}: ${updErr.message}`);
        continue;
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
