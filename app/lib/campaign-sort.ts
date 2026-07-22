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

/** Campaign table columns a merchant can order by from the header row. */
export interface CampaignSortable extends StatusBearing {
  name: string;
  daily_budget_cents: number;
  spend_7d: number;
  roas_7d: number;
  calderynScore: { value: number | null } | null;
}

/** The table's default ordering: active campaigns above paused, highest 7-day
 *  spend first within each group. No column represents it (Status sorts purely
 *  by state), so it is the header cycle's third-click destination. */
export const DEFAULT_CAMPAIGN_SORT = { sort: "default", dir: "desc" } as const;

/** Per-day spend used by the Daily column: the set budget when there is one,
 *  otherwise the 7-day average. Rows with neither sort last in both directions
 *  rather than pretending to be zero. */
function perDayCents(c: CampaignSortable): number | null {
  if (c.daily_budget_cents > 0) return c.daily_budget_cents;
  return c.spend_7d > 0 ? Math.round(c.spend_7d / 7) : null;
}

/**
 * Order the campaign table for a header-sort state. Unlike the default, an
 * explicit column sort spans the whole table rather than ordering within the
 * active/paused groups — asking for "highest ROAS" and getting the best paused
 * campaign buried under every active one would not answer the question. Status
 * is still available as its own column.
 *
 * Missing values (no score yet, no spend and no budget) sink to the bottom in
 * both directions: they are unknowns, not zeroes, and floating them to the top
 * of an ascending sort would bury the real answer.
 */
export function orderCampaigns<T extends CampaignSortable>(
  items: T[],
  state: { sort: string; dir: "asc" | "desc" },
): T[] {
  if (state.sort === "default") {
    return sortActiveFirst(items, (a, b) => b.spend_7d - a.spend_7d);
  }
  const mul = state.dir === "asc" ? 1 : -1;
  // Name is the tiebreak on every column so equal-valued rows hold one stable
  // order instead of whatever the previous sort left behind.
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  /** Compare two possibly-missing numbers, keeping missing ones at the bottom
   *  regardless of direction. */
  const byNullableNumber = (a: number | null, b: number | null): number => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return mul * (a - b);
  };
  return [...items].sort((a, b) => {
    switch (state.sort) {
      case "campaign":
        return mul * byName(a, b);
      case "status":
        return mul * (statusRank(a) - statusRank(b)) || byName(a, b);
      case "daily":
        return byNullableNumber(perDayCents(a), perDayCents(b)) || byName(a, b);
      case "roas":
        return mul * (a.roas_7d - b.roas_7d) || byName(a, b);
      case "score":
        return (
          byNullableNumber(
            a.calderynScore?.value ?? null,
            b.calderynScore?.value ?? null,
          ) || byName(a, b)
        );
      default:
        return byName(a, b);
    }
  });
}
