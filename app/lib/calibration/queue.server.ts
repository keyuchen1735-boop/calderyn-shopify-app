// Action Queue builder for Calderyn Calibration (Slice 2).
// Pure function — no I/O. The facade in calderyn.server.ts loads open alerts +
// pair_calibration rows, then calls this to produce the ranked proposal list.

import type { Alert, QueueProposal } from "../types";
import { recommendedAction } from "../labels";
import { pairConfidence } from "./confidence";

/**
 * Build a ranked list of action proposals from open alerts.
 *
 * For each alert:
 *  1. Skip if `alert.id` is in `rejectedAlertIds` (merchant already said no).
 *  2. Derive `hasCampaign` from `alert.campaign_id`.
 *  3. Ask `recommendedAction` for the best non-snooze action applicable to this alert.
 *  4. Skip if null (no real action available — campaign-gated on a non-campaign alert,
 *     or the only option is to snooze/review).
 *  5. Skip if the `${detector}:${action}` pair is in `mutedPairs` (merchant learned rule).
 *  6. Look up the pair's Beta counters from `pairRows`; default to {alpha:0, beta:0} on
 *     a cold-start pair (no calibration data yet).
 *  7. Compute confidence via `pairConfidence` with `peerP50=null` (no RPC in this slice).
 *  8. Carry `dollar_impact`, `title`, and `narrative` (as `reasoning`) from the alert.
 *
 * The caller (queue.list facade) is responsible for supplying only open alerts.
 */
export function buildActionQueue(
  alerts: Alert[],
  pairRows: Map<string, { alpha: number; beta: number }>,
  rejectedAlertIds: Set<string> = new Set(),
  mutedPairs: Set<string> = new Set(),
): QueueProposal[] {
  const out: QueueProposal[] = [];
  for (const a of alerts) {
    if (rejectedAlertIds.has(a.id)) continue;
    const hasCampaign = Boolean(a.campaign_id);
    const action = recommendedAction(a.detector_id, { hasCampaign });
    if (!action) continue;
    if (mutedPairs.has(`${a.detector_id}:${action}`)) continue;
    const ev = pairRows.get(`${a.detector_id}:${action}`) ?? { alpha: 0, beta: 0 };
    out.push({
      alertId: a.id,
      detector_id: a.detector_id,
      action_kind: action,
      title: a.title,
      dollar_impact: a.dollar_impact,
      confidence: pairConfidence(a.detector_id, action, ev, null),
      reasoning: a.narrative,
    });
  }
  return out;
}
