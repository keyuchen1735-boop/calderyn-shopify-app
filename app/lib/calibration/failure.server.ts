// Records a platform failure (executor outcome 'failed') as a negative
// learning signal for a (detector, action) pair — spec §7: a proposed action
// the platform could not land is +1 beta. Atomic via the
// calibration_record_failure SQL fn. Never throws: the caller has already
// surfaced the action failure to the merchant; a signal-write failure must not
// compound it (it is logged; the pair simply learns one event later).
//
// EXACTLY-ONCE per audit row: a terminally failed action leaves its alert
// open, so autopilot re-reaches it every tick and the idempotency layer
// replays the SAME failed audit — without dedup one real failure would bump
// beta once per tick, unbounded. When the caller supplies the audit id, an
// append-only action_feedback ledger row keyed (shop_id, audit_id, 'failure')
// is inserted first with ON CONFLICT DO NOTHING; a duplicate means the signal
// already landed and the RPC is skipped. If the ledger write itself errors we
// also skip the RPC — losing one signal is recoverable, double-counting on
// replay is not.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { calibrationActionKind } from "./action-kind";

export interface RecordActionFailureOpts {
  /** The failed action_audit row id — enables once-per-audit dedup. */
  auditId?: string | null;
  /** The alert that drove the action, stored on the ledger row for analytics. */
  alertId?: string | null;
}

export async function recordActionFailure(
  shopId: string,
  detectorId: string | null | undefined,
  rawActionKind: ActionKind,
  sb: SupabaseClient,
  opts?: RecordActionFailureOpts,
): Promise<void> {
  if (!detectorId) return;
  try {
    // Same normalization as the approval/rejection writers so the signal lands
    // on the pair the autopilot graduation gate reads (and never 22P02s on a
    // non-enum gateway kind).
    const actionKind = calibrationActionKind(rawActionKind);

    let ledgerRowId: string | null = null;
    if (opts?.auditId) {
      const { data: ledger, error: ledgerErr } = await sb
        .from("action_feedback")
        .upsert(
          {
            shop_id: shopId,
            audit_id: opts.auditId,
            alert_id: opts.alertId ?? null,
            detector_id: detectorId,
            action_kind: actionKind,
            decision: "failure",
          },
          { onConflict: "shop_id,audit_id,decision", ignoreDuplicates: true },
        )
        .select("id");
      if (ledgerErr) {
        console.error(
          `[calibration] failure-ledger write failed for audit ${opts.auditId}: ${ledgerErr.message} — skipping beta bump (no replay protection)`,
        );
        return;
      }
      if ((ledger ?? []).length === 0) {
        // Duplicate: this audit's failure was already recorded (idempotency
        // replay on a later tick / a double-submit). No second beta bump.
        return;
      }
      ledgerRowId = String((ledger ?? [])[0]?.id ?? "") || null;
    }

    const { error } = await sb.rpc("calibration_record_failure", {
      p_shop_id: shopId,
      p_detector_id: detectorId,
      p_action_kind: actionKind,
    });
    if (error) {
      console.error(
        `[calibration] recordActionFailure failed for ${detectorId}:${actionKind}: ${error.message}`,
      );
      // Compensate: a failed bump must not leave the ledger row behind, or the
      // replay that retries this audit would dedup against it and the failure
      // signal would be permanently lost. Best-effort delete.
      if (ledgerRowId) {
        try {
          await sb.from("action_feedback").delete().eq("shop_id", shopId).eq("id", ledgerRowId);
        } catch (delErr) {
          console.error(
            `[calibration] failure-ledger rollback failed for audit ${opts?.auditId}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
          );
        }
      }
    }
  } catch (err) {
    console.error(
      `[calibration] recordActionFailure threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
