// Single-flight guard for the nightly moat trainer (cron.moat-train).
//
// SEAM (spec OQ-2/OQ-3): this is the swappable lock owner. The shipped version
// is a NO-OP that always grants — the trainer's upsert is idempotent by PK
// (detector_id, shop_id_pseudonym), so a concurrent run is correctness-safe; the
// real run-row lock (a `moat.train_run` row with an expires_at TTL, per the spec
// §6 mechanism B) is deferred until the #3 trainer entrypoint is reconciled, to
// avoid committing new schema before the seam is settled. Swap the bodies here —
// the route already calls acquire/release around the trainer invocation, so the
// route does not change when the real lock lands.
//
// TODO(moat OQ-3): replace with a conditional UPDATE on a `moat.train_run`
// single-row lock (locked_at/expires_at) once OQ-2 (lock ownership) is decided.

// Minimal structural type so this helper does not couple to the concrete
// Supabase client shape; the route passes its real client, tests pass {}.
type SupabaseLike = Record<string, unknown>;

export async function acquireTrainLock(_sb: SupabaseLike): Promise<boolean> {
  // No-op: always grant. (Real impl: rows-affected === 1 on the conditional
  // UPDATE means acquired; 0 means a run is already in progress -> return false.)
  return true;
}

export async function releaseTrainLock(_sb: SupabaseLike): Promise<void> {
  // No-op: nothing to release. (Real impl: clear locked_at on the lock row.)
}
