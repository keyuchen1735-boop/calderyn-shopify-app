// Records a merchant approval as the positive learning signal for a
// (detector, action) pair. Atomic via the calibration_record_approval SQL fn.
// Never throws: the action it follows has already succeeded, so a bump failure
// must not surface as an action failure (it is logged and the next nightly
// recompute self-heals from the append-only audit anyway).
//
// Returns a "trust receipt" (the confidence the approval gained, whether the
// pair just graduated, etc.) so the UI can render a post-approve confirmation.
// The receipt is purely a READ around the existing RPC — the write behavior of
// calibration_record_approval is unchanged. On ANY failure the zero receipt is
// returned (all zeros / false); the action result is always authoritative.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { calibrationActionKind } from "./action-kind";
import { GRADUATABLE, graduationVerdict, effectiveGraduationThreshold } from "./graduation";
import { trustDelta, ZERO_APPROVE_RECEIPT, type ApproveReceipt, type PairEv } from "./delta";
import { recomputeShopCalibration } from "./recompute.server";
import { HAS_UNDO_BRANCH } from "./undo-branches";

const PAIR_COLS =
  "alpha, beta, clean_approvals, consecutive_clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold, graduated, net_positive_outcomes, last_outcome_sign, last_detection";

async function readPairRow(
  sb: SupabaseClient,
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from("pair_calibration")
    .select(PAIR_COLS)
    .eq("shop_id", shopId)
    .eq("detector_id", detectorId)
    .eq("action_kind", actionKind)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function refreshShopCalibrationHeadline(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  try {
    await recomputeShopCalibration(shopId, { sb }, { skipPeerPrior: true, forceVisibleStep: true });
  } catch (err) {
    console.error(
      `[calibration] approval headline recompute failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface RecordApprovalOpts {
  /** The succeeded action_audit row id — enables once-per-audit dedup so an
   * idempotency replay / double-submit never double-bumps alpha. */
  auditId?: string | null;
  /** The alert that drove the action, stored on the ledger row. */
  alertId?: string | null;
}

const pairEvFromRow = (row: Record<string, unknown> | null): PairEv => ({
  alpha: num(row?.alpha),
  beta: num(row?.beta),
  lastDetection: row?.last_detection == null ? null : num(row?.last_detection),
  consecutiveCleanApprovals: num(row?.consecutive_clean_approvals),
});

export async function recordApproval(
  shopId: string,
  detectorId: string,
  rawActionKind: ActionKind,
  sb: SupabaseClient,
  opts?: RecordApprovalOpts,
): Promise<ApproveReceipt> {
  try {
    // Normalize a gateway kind to the action_kind it is audited + calibrated
    // under (reallocate_spend_sku → reallocate_budget) BEFORE any enum-typed read
    // or RPC, so the approval lands on the same pair the autopilot graduation gate
    // reads, and never raises 22P02 on the non-enum gateway kind.
    const actionKind = calibrationActionKind(rawActionKind);
    // 1. Read the pair row BEFORE the bump (so we can diff confidence + detect a
    //    fresh graduation). A cold-start pair has no row → treat as alpha/beta 0.
    const beforeRow = await readPairRow(sb, shopId, detectorId, actionKind);
    const before = pairEvFromRow(beforeRow);
    const wasGraduatedBefore = Boolean(beforeRow?.graduated);

    // 1b. Once-per-audit dedup: an append-only approve ledger row keyed
    // (shop_id, audit_id, 'approve'). A duplicate means this exact audit's
    // approval was already counted (double-submit / idempotency replay) —
    // skip the alpha bump and return a no-movement receipt. Unlike the
    // failure ledger, a ledger WRITE ERROR falls through to the bump (dedup
    // lost, logged): approval replays are bounded to merchant double-submits,
    // and silently dropping positive signals would hurt learning more.
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
            decision: "approve",
          },
          { onConflict: "shop_id,audit_id,decision", ignoreDuplicates: true },
        )
        .select("id");
      if (ledgerErr) {
        console.error(
          `[calibration] approve-ledger write failed for audit ${opts.auditId}: ${ledgerErr.message} — recording without replay protection`,
        );
      } else if ((ledger ?? []).length === 0) {
        const conf = trustDelta(detectorId, actionKind, before, before).before;
        return {
          delta: 0,
          before: conf,
          after: conf,
          cleanApprovals: num(beforeRow?.clean_approvals),
          graduatable: GRADUATABLE.has(actionKind),
          graduationThreshold: effectiveGraduationThreshold(
            actionKind,
            num(beforeRow?.graduation_threshold),
          ),
          justGraduated: false,
        };
      } else {
        ledgerRowId = String((ledger ?? [])[0]?.id ?? "") || null;
      }
    }

    // 2. The atomic bump (write behavior unchanged from the original).
    const { error } = await sb.rpc("calibration_record_approval", {
      p_shop_id: shopId,
      p_detector_id: detectorId,
      p_action_kind: actionKind,
    });
    if (error) {
      console.error(`[calibration] recordApproval failed: ${error.message}`);
      // Compensate: the ledger row was written BEFORE the bump so a concurrent
      // double-submit can't double-count — but a failed bump must not leave the
      // row behind, or every retry would dedup against it and this audit's
      // positive signal would be permanently lost. Best-effort delete.
      if (ledgerRowId) {
        try {
          await sb.from("action_feedback").delete().eq("shop_id", shopId).eq("id", ledgerRowId);
        } catch (delErr) {
          console.error(
            `[calibration] approve-ledger rollback failed for audit ${opts?.auditId}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
          );
        }
      }
      return ZERO_APPROVE_RECEIPT;
    }

    // 3. Read the pair row AFTER the bump.
    const afterRow = await readPairRow(sb, shopId, detectorId, actionKind);
    const after = pairEvFromRow(afterRow);

    // 4. Confidence delta (peerP50 = null — the synchronous skipPeerPrior path,
    //    matching the recompute job and the Action Queue so the two never diverge).
    const { before: confBefore, after: confAfter, delta } = trustDelta(
      detectorId,
      actionKind,
      before,
      after,
    );

    const cleanApprovals = num(afterRow?.clean_approvals);
    // The tier-floored bar the pair must actually clear (spec §3: 75/88/95) —
    // reported on the receipt so the UI's "N points from autopilot" is honest.
    const graduationThreshold = effectiveGraduationThreshold(
      actionKind,
      num(afterRow?.graduation_threshold),
    );
    const graduatable = GRADUATABLE.has(actionKind);

    // 5. justGraduated = the AFTER row now clears every graduation gate AND the
    //    pair was NOT already graduated before this approval. Uses the same
    //    graduationVerdict the live isGraduated check uses, so the answer agrees.
    const verdict = graduationVerdict({
      detectorId,
      actionKind,
      lastConf: confAfter,
      gradThreshold: graduationThreshold || 100,
      cleanApprovals,
      consecutiveUndos: num(afterRow?.consecutive_undos),
      merchantDisabled: Boolean(afterRow?.merchant_disabled),
      onProbation: false, // approval-time best-effort; the nightly recompute is authoritative
      hasUndoBranch: HAS_UNDO_BRANCH.has(actionKind),
      netPositiveOutcomes: num(afterRow?.net_positive_outcomes),
      lastOutcomeSign: (num(afterRow?.last_outcome_sign) as -1 | 0 | 1),
    });
    const justGraduated = verdict.graduated && !wasGraduatedBefore;

    await refreshShopCalibrationHeadline(shopId, sb);

    return {
      delta,
      before: confBefore,
      after: confAfter,
      cleanApprovals,
      graduatable,
      graduationThreshold,
      justGraduated,
    };
  } catch (err) {
    console.error(
      `[calibration] recordApproval threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ZERO_APPROVE_RECEIPT;
  }
}
