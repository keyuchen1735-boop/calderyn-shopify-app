// Action Queue builder for Calderyn Calibration (Slice 2).
// Pure function — no I/O. The facade in calderyn.server.ts loads open alerts +
// pair_calibration rows, then calls this to produce the ranked proposal list.

import type { ActionKind, Alert, QueueProposal } from "../types";
import { recommendedAction } from "../labels";
import { pairConfidence, NO_BRAINER } from "./confidence";
import { transferPlanFromEvidence } from "../shopify/inventory.server";
import { derivePoQuantity } from "../po/draft.server";
import { isValidRegion } from "../ads/actions";

/**
 * Can the Action Queue actually EXECUTE `action` on THIS alert right now?
 *
 * recommendedAction picks the best-fit kind for the detector, but a given alert
 * may lack the inputs that kind's executor reads (every input is re-derived from
 * the trusted alert record, never the form body). Surfacing an Approve button
 * that then 422s is a rule-12 dead button, so the queue gates every proposal on
 * the SAME preconditions the executors enforce:
 *   - campaign kinds (pause/resume/reduce/increase): a resolvable campaign id
 *   - exclude_geo: a campaign id AND a valid region bucket
 *   - reallocate_inventory: a complete transfer plan in evidence
 *   - create_po_draft: a SKU and a derivable positive reorder quantity
 * Any other kind recommendedAction can emit (reallocate_budget, the free-ship
 * kinds) has no inline queue executor — it reviews/deep-links on another surface,
 * so it is never an approvable proposal here.
 *
 * Keep in sync with the executor preconditions in routes/app.alerts.$id.tsx and
 * actions/execute.server.ts.
 */
function queueActionRunnable(action: ActionKind, a: Alert): boolean {
  const ev = a.evidence ?? {};
  const campaignId =
    a.campaign_id || (typeof ev.campaign_id === "string" ? ev.campaign_id : "");
  switch (action) {
    case "pause_campaign":
    case "resume_campaign":
    case "reduce_campaign_budget":
    case "increase_campaign_budget":
      return Boolean(campaignId);
    case "exclude_geo":
      return Boolean(campaignId) && isValidRegion(ev.region);
    case "reallocate_inventory":
      return transferPlanFromEvidence(ev) !== null;
    case "create_po_draft":
      return Boolean(a.sku) && (derivePoQuantity(ev) ?? 0) > 0;
    default:
      return false;
  }
}

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
 *  6. Skip if the `${detector}:${action}` pair is in `autonomyPairs` (I5 no-double-actor:
 *     pairs RUNNING autonomously — graduated AND merchant-enabled — must not also
 *     appear as approvable proposals so merchant-approve and autopilot cannot both
 *     fire for the same alert. A graduated-but-not-enabled pair is NOT in this set,
 *     so it stays as a suggestion until the merchant opts in — Slice C warm-up).
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
  /** I5 / Slice C: pairs RUNNING autonomously (graduated AND merchant-enabled)
   *  must not appear in the queue (autopilot handles them). A graduated-but-not-
   *  enabled pair is absent here, so it stays as a suggestion (warm-up). */
  autonomyPairs: Set<string> = new Set(),
  /** Alert ids on a running pair whose specific move exceeds the merchant's
   *  autonomy cap: autopilot blocks these (block-not-clamp), so unlike the rest of
   *  their pair they stay approvable in the queue, flagged `over_autopilot_cap`. */
  overCapAlertIds: Set<string> = new Set(),
): QueueProposal[] {
  const out: QueueProposal[] = [];
  for (const a of alerts) {
    if (rejectedAlertIds.has(a.id)) continue;
    const hasCampaign = Boolean(a.campaign_id);
    const action = recommendedAction(a.detector_id, { hasCampaign });
    if (!action) continue;

    // Rule 12: never surface an Approve button the queue can't actually run on
    // this alert's data (missing campaign/region, no transfer plan, no reorder
    // qty, or a kind with no inline queue executor). Such proposals 422 on
    // approve; skip them rather than offer a dead button.
    if (!queueActionRunnable(action, a)) continue;

    const pairKey = `${a.detector_id}:${action}`;
    const isMuted = mutedPairs.has(pairKey);
    const isNoBrainer = NO_BRAINER.has(pairKey);

    // I8 no-brainer mute-resistance: a muted NO_BRAINER pair is NOT silently
    // suppressed — it stays in the queue as "always ask" (always_ask: true).
    // A muted normal pair is excluded entirely (existing behavior).
    if (isMuted && !isNoBrainer) continue;

    // I5 / Slice C: pairs RUNNING autonomously (graduated AND merchant-enabled)
    // are handled by autopilot and must not appear as proposals — EXCEPT an alert
    // whose specific move exceeds the autonomy cap, which autopilot blocks
    // (block-not-clamp) and therefore still needs manual approval. A graduated-but-
    // not-enabled pair is absent from autonomyPairs, so it stays as a suggestion.
    const isAutonomy = autonomyPairs.has(pairKey);
    const isOverCap = isAutonomy && overCapAlertIds.has(a.id);
    if (isAutonomy && !isOverCap) continue;

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
    // Flag an over-cap graduated move so the UI shows it needs approval because
    // it exceeds the merchant's autopilot limit (not the usual learning path).
    if (isOverCap) proposal.over_autopilot_cap = true;
    out.push(proposal);
  }
  return out;
}

/**
 * Derive which graduated reallocate_inventory alerts exceed the merchant's
 * per-move unit cap, from each alert's own evidence (the transfer-plan delta —
 * exact, no Shopify I/O). These are exactly the moves autopilot blocks
 * (block-not-clamp), so the queue keeps them approvable (via `overCapAlertIds`).
 *
 * A null `maxUnitsPerMove` means unlimited, so nothing is over-cap. Only pairs
 * RUNNING autonomously (graduated AND merchant-enabled) `(detector,
 * reallocate_inventory)` are considered — a pair that is not running already shows
 * in the queue normally and needs no flag. Pure.
 */
export function inventoryOverCapAlertIds(
  alerts: Alert[],
  autonomyPairs: Set<string>,
  maxUnitsPerMove: number | null,
): Set<string> {
  const out = new Set<string>();
  if (maxUnitsPerMove == null) return out;
  for (const a of alerts) {
    const action = recommendedAction(a.detector_id, { hasCampaign: Boolean(a.campaign_id) });
    if (action !== "reallocate_inventory") continue;
    if (!autonomyPairs.has(`${a.detector_id}:reallocate_inventory`)) continue;
    const plan = transferPlanFromEvidence(a.evidence ?? {});
    if (!plan) continue;
    if (Math.abs(plan.delta) > maxUnitsPerMove) out.add(a.id);
  }
  return out;
}
