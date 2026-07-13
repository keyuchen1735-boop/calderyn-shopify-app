// Pure run-state logic for the first-campaign wizard's idempotent Meta create.
// Given the existing campaign_wizard_runs row (or null), decides what the POST
// route may do — the ONLY component allowed to answer "is it safe to call
// createFirstCampaign for this runId?". Kept pure (no I/O) so every branch of
// the money-safety matrix is unit-tested without a database.

/** The columns the route reads to classify a run. */
export interface WizardRunRow {
  status: string;
  meta_campaign_id: string | null;
  updated_at: string;
}

export type RunTransition =
  /** No row — insert 'creating' and create. */
  | "fresh"
  /** Finished run — return the stored ids, never touch Meta. */
  | "replay"
  /** A recent 'creating' row: another request is (or may be) mid-flight. */
  | "reject_in_progress"
  /** A dead attempt with NO Meta campaign recorded — safe to retry. */
  | "reopen"
  /** A dead attempt that DID record a Meta campaign id (orphan, paused) —
   *  creating again would double-create; a human has to look first. */
  | "needs_review";

/** How long a 'creating' row is presumed in-flight. Serverless request budget
 *  is well under this, so anything older is a crashed attempt, not a live one. */
export const CREATING_STALE_MS = 10 * 60 * 1000;

/**
 * Classify an existing wizard run for a replayed/racing POST.
 *
 * - `null` → `fresh`
 * - `created` → `replay`
 * - `creating` younger than {@link CREATING_STALE_MS} → `reject_in_progress`
 * - `creating` older (crashed attempt) → `needs_review` when a Meta campaign
 *   id was bookkept (an object may exist on Meta), else `reopen`
 * - `failed` / `rolled_back` → same orphan split: `needs_review` when a
 *   campaign id is recorded, else `reopen`
 * - any unrecognized status → `needs_review` (never touch Meta on a row we
 *   can't classify)
 *
 * Unparseable timestamps are treated as stale: a 'creating' row we can't age
 * falls through to the orphan split rather than blocking forever, and `reopen`
 * is additionally guarded by the route's compare-and-set update.
 */
export function decideRunTransition(existing: WizardRunRow | null, nowIso: string): RunTransition {
  if (!existing) return "fresh";
  if (existing.status === "created") return "replay";

  const hasOrphan = existing.meta_campaign_id != null && existing.meta_campaign_id !== "";

  if (existing.status === "creating") {
    const ageMs = Date.parse(nowIso) - Date.parse(existing.updated_at);
    if (Number.isFinite(ageMs) && ageMs < CREATING_STALE_MS) return "reject_in_progress";
    return hasOrphan ? "needs_review" : "reopen";
  }

  if (existing.status === "failed" || existing.status === "rolled_back") {
    return hasOrphan ? "needs_review" : "reopen";
  }

  return "needs_review";
}

/**
 * Deterministic JSON serialization (object keys sorted recursively), for
 * comparing a run row's stored `input` jsonb against a retry's freshly parsed
 * input. Plain `JSON.stringify` can't be used: Postgres jsonb does not
 * preserve key order, so identical payloads would stringify differently.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  const s = JSON.stringify(value);
  return s === undefined ? "null" : s;
}
