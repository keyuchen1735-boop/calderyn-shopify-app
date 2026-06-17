// One-line, plain-language reason for the "Suggested: scale" hint, shared by the
// Polaris admin and the dashboard so both surfaces show identical hover copy.
// No jargon ("earning N× on ad spend", not "ROAS"); sets the "if it holds"
// expectation because the upside is a projection, not a promise.

/**
 * @param roas  campaign return on ad spend (revenue ÷ spend). null/≤0 omits the
 *   performance clause (e.g. a live-Meta row with no local ROAS).
 * @param pct  budget-increase percent the suggestion would apply (e.g. 20).
 * @param projectedUpsideCents  projected incremental monthly margin, in cents.
 */
export function scaleReason(
  roas: number | null,
  pct: number,
  projectedUpsideCents: number,
): string {
  const upside = `$${Math.round(projectedUpsideCents / 100).toLocaleString("en-US")}`;
  const lead =
    roas != null && Number.isFinite(roas) && roas > 0
      ? `Winning campaign earning ${roas.toFixed(1)}× on ad spend.`
      : `Winning campaign.`;
  return `${lead} Raising its budget ${pct}% projects about +${upside}/mo more profit if it keeps performing.`;
}
