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
import { GRADUATABLE_V1, graduationVerdict } from "./graduation";
import { trustDelta, ZERO_APPROVE_RECEIPT, type ApproveReceipt } from "./delta";
import { recomputeShopCalibration } from "./recompute.server";

/**
 * Action kinds with a working undo branch (mirror of the set in
 * graduation.server.ts). Needed for the justGraduated verdict — graduation
 * requires a reversible action with an undo path.
 */
const HAS_UNDO_BRANCH: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
]);

const PAIR_COLS =
  "alpha, beta, clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold, graduated";

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

export async function recordApproval(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  sb: SupabaseClient,
): Promise<ApproveReceipt> {
  try {
    // 1. Read the pair row BEFORE the bump (so we can diff confidence + detect a
    //    fresh graduation). A cold-start pair has no row → treat as alpha/beta 0.
    const beforeRow = await readPairRow(sb, shopId, detectorId, actionKind);
    const before = { alpha: num(beforeRow?.alpha), beta: num(beforeRow?.beta) };
    const wasGraduatedBefore = Boolean(beforeRow?.graduated);

    // 2. The atomic bump (write behavior unchanged from the original).
    const { error } = await sb.rpc("calibration_record_approval", {
      p_shop_id: shopId,
      p_detector_id: detectorId,
      p_action_kind: actionKind,
    });
    if (error) {
      console.error(`[calibration] recordApproval failed: ${error.message}`);
      return ZERO_APPROVE_RECEIPT;
    }

    // 3. Read the pair row AFTER the bump.
    const afterRow = await readPairRow(sb, shopId, detectorId, actionKind);
    const after = { alpha: num(afterRow?.alpha), beta: num(afterRow?.beta) };

    // 4. Confidence delta (peerP50 = null — the synchronous skipPeerPrior path,
    //    matching the recompute job and the Action Queue so the two never diverge).
    const { before: confBefore, after: confAfter, delta } = trustDelta(
      detectorId,
      actionKind,
      before,
      after,
    );

    const cleanApprovals = num(afterRow?.clean_approvals);
    const graduationThreshold = num(afterRow?.graduation_threshold);
    const graduatable = GRADUATABLE_V1.has(actionKind);

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
