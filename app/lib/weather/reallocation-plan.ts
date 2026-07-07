export interface ReallocationPlan {
  sourceCampaignId: string;
  destCampaignId: string;
  amountCents: number;
}

/** Extract a budget-reallocation plan from an alert's evidence, or null if it is
 *  not a complete, actionable plan. The presence of a plan is what makes a
 *  reallocate_budget alert one-click-able, so alerts without one (e.g.
 *  ad_tax_overload) never expose the button. */
export function reallocationPlanFromEvidence(
  evidence: Record<string, unknown> | null | undefined,
): ReallocationPlan | null {
  if (!evidence) return null;
  const source = evidence.source_campaign_id;
  const dest = evidence.dest_campaign_id;
  const amount = Number(evidence.amount_cents);
  if (typeof source !== "string" || typeof dest !== "string") return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (source === dest) return null;
  return { sourceCampaignId: source, destCampaignId: dest, amountCents: amount };
}
