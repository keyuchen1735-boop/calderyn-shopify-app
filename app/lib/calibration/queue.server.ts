// Action Queue builder for Calderyn Calibration (Slice 2).
// Pure function — no I/O. The facade in calderyn.server.ts loads open alerts +
// pair_calibration rows, then calls this to produce the ranked proposal list.

import type { Alert, QueueProposal } from "../types";
import { recommendedAction } from "../labels";
import { pairConfidence, NO_BRAINER } from "./confidence";

/**
 * Build a ranked list of action proposals from open alerts.
 *
 * For each alert:
 *  1. Skip if `alert.id` is in `rejectedAlertIds` (merchant already said no).
 *  2. Derive `hasCampaign` from `alert.campaign_id`.
 *  3. Ask `recommendedAction` for the best non-snooze action applicable to this alert.
 *  4. Skip if null (no real action available — campaign-gated on a non-campaign alert,
 *     or the only option is to snooze/review).
 *  5. Muted-pair handling (I8 no-brainer mute-resistance):
 *     - If the pair is in `mutedPairs` AND it is a NO_BRAINER pair → keep in the queue
 *       but mark `always_ask: true` (mute downgrades to "always ask", not silent suppress).
 *     - If the pair is in `mutedPairs` AND it is a normal (non-no-brainer) pair → skip
 *       (existing behavior: merchant has said "I handle this").
 *  6. Skip if the `${detector}:${action}` pair is in `graduatedPairs` (I5 no-double-actor:
 *     graduated pairs auto-run via autopilot; they must not also appear as approvable
 *     proposals so merchant-approve and autopilot cannot both fire for the same alert).
 *  7. Look up the pair's Beta counters from `pairRows`; default to {alpha:0, beta:0} on
 *     a cold-start pair (no calibration data yet).
 *  8. Compute confidence via `pairConfidence` with `peerP50=null` (no RPC in this slice).
 *  9. Carry `dollar_impact`, `title`, and `narrative` (as `reasoning`) from the alert.
 *
 * The caller (queue.list facade) is responsible for supplying only open alerts.
 */
export function buildActionQueue(
  alerts: Alert[],
  pairRows: Map<string, { alpha: number; beta: number }>,
  rejectedAlertIds: Set<string> = new Set(),
  mutedPairs: Set<string> = new Set(),
  /** I5: pairs where graduated=true must not appear in the queue (autopilot handles them). */
  graduatedPairs: Set<string> = new Set(),
): QueueProposal[] {
  const out: QueueProposal[] = [];
  for (const a of alerts) {
    if (rejectedAlertIds.has(a.id)) continue;
    const hasCampaign = Boolean(a.campaign_id);
    const action = recommendedAction(a.detector_id, { hasCampaign });
    if (!action) continue;

    const pairKey = `${a.detector_id}:${action}`;
    const isMuted = mutedPairs.has(pairKey);
    const isNoBrainer = NO_BRAINER.has(pairKey);

    // I8 no-brainer mute-resistance: a muted NO_BRAINER pair is NOT silently
    // suppressed — it stays in the queue as "always ask" (always_ask: true).
    // A muted normal pair is excluded entirely (existing behavior).
    if (isMuted && !isNoBrainer) continue;

    // I5: graduated pairs are handled by autopilot; must not appear as proposals.
    if (graduatedPairs.has(pairKey)) continue;

    const ev = pairRows.get(pairKey) ?? { alpha: 0, beta: 0 };
    const proposal: QueueProposal = {
      alertId: a.id,
      detector_id: a.detector_id,
      action_kind: action,
      title: a.title,
      dollar_impact: a.dollar_impact,
      confidence: pairConfidence(a.detector_id, action, ev, null),
      reasoning: a.narrative,
    };
    // Flag the proposal so the UI can render an "always ask" badge / skip
    // the graduation UI path for this pair (I8).
    if (isMuted && isNoBrainer) proposal.always_ask = true;
    out.push(proposal);
  }
  return out;
}
