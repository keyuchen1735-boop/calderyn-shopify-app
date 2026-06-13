// Shared campaign ordering: active campaigns always float above paused.
// Used by both surfaces — the embedded Polaris table (app.campaigns._index)
// and the dashboard Campaigns screen — so the two stay in lockstep.

/** Anything carrying a campaign status string. Covers the embedded `Campaign`
 *  ("active" | "paused") and the dashboard `CampaignVM` (status: string). */
type StatusBearing = { status: string };

/** Status-first rank: active campaigns rank above everything else. */
function statusRank(c: StatusBearing): number {
  return c.status === "active" ? 0 : 1;
}

/**
 * Order campaigns active-first, then by the caller's existing sort. Status is
 * the PRIMARY key (the active group always sits above the paused group); the
 * `tiebreak` comparator orders rows within each group.
 */
export function sortActiveFirst<T extends StatusBearing>(
  items: T[],
  tiebreak: (a: T, b: T) => number = () => 0,
): T[] {
  return [...items].sort((a, b) => statusRank(a) - statusRank(b) || tiebreak(a, b));
}
