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
 *  1. Derive `hasCampaign` from `alert.campaign_id`.
 *  2. Ask `recommendedAction` for the best non-snooze action applicable to this alert.
 *  3. Skip if null (no real action available — campaign-gated on a non-campaign alert,
 *     or the only option is to snooze/review).
 *  4. Look up the pair's Beta counters from `pairRows`; default to {alpha:0, beta:0} on
 *     a cold-start pair (no calibration data yet).
 *  5. Compute confidence via `pairConfidence` with `peerP50=null` (no RPC in this slice).
 *  6. Carry `dollar_impact`, `title`, and `narrative` (as `reasoning`) from the alert.
 *
 * The caller (queue.list facade) is responsible for supplying only open alerts.
 */
export function buildActionQueue(
  alerts: Alert[],
  pairRows: Map<string, { alpha: number; beta: number }>,
): QueueProposal[] {
  const out: QueueProposal[] = [];
  for (const a of alerts) {
    const hasCampaign = Boolean(a.campaign_id);
    const action = recommendedAction(a.detector_id, { hasCampaign });
    if (!action) continue;
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
