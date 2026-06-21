// Per-shop autopilot concurrency lock (Slice 5 I6).
//
// MECHANISM: TTL-row in autopilot_run_lock (shop_id PK, locked_at timestamptz).
// A tick acquires the lock by issuing a plain INSERT via supabase-js. The
// shop_id primary-key unique constraint means exactly ONE concurrent insert wins;
// any other concurrent insert loses with a Postgres 23505 unique-violation error
// (NOT a silent 0-row result — supabase-js does not issue ON CONFLICT DO NOTHING).
// We branch on insertErr.code === "23505" to detect "lock held by another tick".
// An orphaned row (from a crashed tick) expires after LOCK_TTL_MS; acquire detects
// those by reading the locked_at timestamp and cleans them up before re-inserting.
//
// WHY NOT pg_try_advisory_lock?
// Supabase uses PgBouncer in Transaction mode. Advisory locks are session-scoped.
// In Transaction mode the underlying Postgres connection is returned to the pool
// at the end of each statement, so the advisory lock is immediately released and
// provides zero protection across multiple queries in the same "logical session".
// The TTL-row approach works correctly over any connection pool.
//
// FAIL-SAFE CONTRACT (money-path):
//   - acquireAutopilotLock: if the RPC/DB call ERRORS with anything other than
//     23505, we return { acquired: false }. A failed lock acquisition means the
//     tick is SKIPPED, not run unlocked. Running unlocked on a DB error would
//     risk the exact double-action the lock prevents — so we conservatively skip.
//   - releaseAutopilotLock: FENCED — deletes only the row whose locked_at matches
//     the timestamp this tick wrote. This prevents a slow tick from releasing a
//     successor's lock after the TTL-based cleanup re-inserted. Best-effort: logs
//     but never throws. The TTL ensures an orphaned row expires within LOCK_TTL_MS.
//
// USAGE in runAutopilotForShop:
//   const lock = await acquireAutopilotLock(shopId, sb);
//   if (!lock.acquired) return SKIPPED_LOCKED_SUMMARY;
//   try {
//     ... do the work ...
//   } finally {
//     await releaseAutopilotLock(shopId, lock.acquiredAt!, sb);
//   }

import type { SupabaseClient } from "@supabase/supabase-js";

/** TTL for an autopilot run lock row: 10 minutes. A normal run completes well
 *  within this window; anything older is treated as orphaned and cleaned up. */
export const LOCK_TTL_MS = 10 * 60 * 1000;

export interface LockResult {
  acquired: boolean;
  /** Why the lock was NOT acquired (present when acquired=false). */
  reason?: string;
  /**
   * The locked_at ISO timestamp this tick wrote to the lock row.
   * Present only when acquired=true. Pass to releaseAutopilotLock so the
   * release is FENCED: it deletes only the row this tick owns, preventing a
   * slow tick from wiping a successor's lock after TTL-based cleanup.
   */
  acquiredAt?: string;
}

/**
 * Try to acquire the per-shop autopilot run lock.
 *
 * Returns { acquired: true } if we inserted the lock row successfully.
 * Returns { acquired: false } if another tick holds a fresh lock, or if the
 * DB call errors (fail-safe: don't run unlocked).
 *
 * If an orphaned (expired) row is found, we delete it and re-insert.
 */
export async function acquireAutopilotLock(
  shopId: string,
  sb: SupabaseClient,
): Promise<LockResult> {
  try {
    // Plain INSERT via supabase-js. The shop_id PK unique constraint means
    // exactly one concurrent insert wins; the loser receives a Postgres 23505
    // unique-violation error (not a silent 0-row result).
    const lockedAt = new Date().toISOString();
    const { data: inserted, error: insertErr } = await sb
      .from("autopilot_run_lock")
      .insert({ shop_id: shopId, locked_at: lockedAt })
      .select("locked_at")
      .maybeSingle();

    if (insertErr) {
      // 23505 = unique_violation: another tick holds the lock row. Check its
      // age to determine if it's live or orphaned (expired).
      if (insertErr.code === "23505" || insertErr.message?.includes("duplicate")) {
        return await _checkExistingLock(shopId, sb);
      }
      // Any other DB error: fail-safe skip.
      console.error(`[autopilot-lock] acquire DB error for shop ${shopId}: ${insertErr.message}`);
      return { acquired: false, reason: `db_error: ${insertErr.message}` };
    }

    if (inserted) {
      // Insert succeeded — we own the lock. Return acquiredAt for fenced release.
      return { acquired: true, acquiredAt: inserted.locked_at as string };
    }

    // maybeSingle returned null without an error: unexpected (insert returned no row).
    // Fall through to check the existing row.
    return await _checkExistingLock(shopId, sb);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot-lock] acquire threw for shop ${shopId}: ${msg}`);
    // Fail-safe: a thrown error means we skip the tick rather than run unlocked.
    return { acquired: false, reason: `threw: ${msg}` };
  }
}

/** Internal: read the existing lock row and determine if it's expired. */
async function _checkExistingLock(
  shopId: string,
  sb: SupabaseClient,
): Promise<LockResult> {
  const { data: existing, error: readErr } = await sb
    .from("autopilot_run_lock")
    .select("locked_at")
    .eq("shop_id", shopId)
    .maybeSingle();

  if (readErr) {
    console.error(`[autopilot-lock] read existing lock error for shop ${shopId}: ${readErr.message}`);
    return { acquired: false, reason: `db_error: ${readErr.message}` };
  }

  if (!existing) {
    // Race: the row was released between our failed insert and this read.
    // Try a fresh insert.
    try {
      const retryLockedAt = new Date().toISOString();
      const { data: retry, error: retryErr } = await sb
        .from("autopilot_run_lock")
        .insert({ shop_id: shopId, locked_at: retryLockedAt })
        .select("locked_at")
        .maybeSingle();
      if (retryErr || !retry) {
        return { acquired: false, reason: "retry_insert_failed" };
      }
      return { acquired: true, acquiredAt: retry.locked_at as string };
    } catch {
      return { acquired: false, reason: "retry_insert_threw" };
    }
  }

  const lockedAtMs = new Date(existing.locked_at).getTime();
  const ageMs = Date.now() - lockedAtMs;

  if (ageMs < LOCK_TTL_MS) {
    // A live lock: another tick holds it (or very recently started). Skip.
    const ageSeconds = Math.round(ageMs / 1000);
    console.info(
      `[autopilot-lock] shop ${shopId} locked by another tick (age=${ageSeconds}s, ttl=${LOCK_TTL_MS / 1000}s); skipping`,
    );
    return { acquired: false, reason: `locked_by_concurrent_tick (age=${ageSeconds}s)` };
  }

  // Expired/orphaned lock: clean it up and re-insert.
  console.warn(`[autopilot-lock] cleaning orphaned lock for shop ${shopId} (age=${Math.round(ageMs / 1000)}s)`);
  await sb.from("autopilot_run_lock").delete().eq("shop_id", shopId);

  // Re-insert; if another tick races us here, one of them gets a 23505.
  const cleanupLockedAt = new Date().toISOString();
  const { data: cleanup, error: cleanupErr } = await sb
    .from("autopilot_run_lock")
    .insert({ shop_id: shopId, locked_at: cleanupLockedAt })
    .select("locked_at")
    .maybeSingle();
  if (cleanupErr || !cleanup) {
    return { acquired: false, reason: "cleanup_reinsert_failed" };
  }
  return { acquired: true, acquiredAt: cleanup.locked_at as string };
}

/**
 * Release the per-shop autopilot run lock.
 *
 * FENCED: deletes only the row whose locked_at matches acquiredAt (the
 * timestamp this tick wrote during acquire). This prevents a slow-finishing
 * tick from deleting a successor's lock row after TTL-based cleanup has
 * already reclaimed and re-inserted the lock for a new tick.
 *
 * Best-effort: logs but never throws. The TTL ensures an orphaned row
 * expires automatically within LOCK_TTL_MS even if this fails.
 */
export async function releaseAutopilotLock(
  shopId: string,
  acquiredAt: string,
  sb: SupabaseClient,
): Promise<void> {
  try {
    const { error } = await sb
      .from("autopilot_run_lock")
      .delete()
      .eq("shop_id", shopId)
      .eq("locked_at", acquiredAt);
    if (error) {
      console.error(`[autopilot-lock] release failed for shop ${shopId}: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot-lock] release threw for shop ${shopId}: ${msg}`);
  }
}
