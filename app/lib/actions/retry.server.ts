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

/**
 * Result of replaying one audit row's action. Mirrors the monorepo
 * executor contract so ported executors slot in without signature churn.
 */
export interface ExecuteResult {
  ok: boolean;
  retriable?: boolean;
  error?: string;
  post_state?: unknown;
  external_call_id?: string | null;
}

export interface ActionExecutor {
  execute(params: unknown, ctx: unknown): Promise<ExecuteResult>;
}

/**
 * Executor registry keyed by `action_kind`. INTENTIONALLY EMPTY.
 *
 * TODO(slice-6+): port the monorepo executors
 * (`apps/web/app/lib/executors`) and register them here keyed by the
 * `action_kind` enum. Until then every due row is SKIPPED (left
 * untouched) because there is no executor to replay.
 */
export const EXECUTOR_REGISTRY: Record<string, ActionExecutor> = {};

interface AuditRow {
  id: string;
  shop_id: string;
  action_kind: string;
  attempts: number;
  outcome: string;
  completed_at: string | null;
}

export interface DrainOptions {
  /** For tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override the batch bound (tests). */
  maxRows?: number;
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
    .select("id, shop_id, action_kind, attempts, outcome, completed_at")
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

      const executor = EXECUTOR_REGISTRY[raw.action_kind];
      if (!executor) {
        // Empty registry — INERT skeleton: leave the row UNTOUCHED. A due
        // `retrying` row must never be marked `failed` just because no
        // executor exists yet — `failed` is terminal, so that would
        // permanently destroy a legitimate retry before the executor
        // layer ships. Count it as skipped (rule 12: visible, non-
        // destructive). No DB write happens on this path.
        result.skipped += 1;
        continue;
      }

      // Reached only once EXECUTOR_REGISTRY is populated (the executor
      // port). The actual replay + success/failure bookkeeping is wired
      // here in the follow-up.
      result.processed += 1;
      result.errors.push(
        `executor for ${raw.action_kind} present but replay not yet wired`,
      );
    } catch (err) {
      // Per-row isolation: collect, never abort the batch (rule 12).
      result.errors.push(
        `row ${raw.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
