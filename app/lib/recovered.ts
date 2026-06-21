// Recovered dollars — succeeded actions, excluding both undo rows themselves
// (an undo is bookkeeping, not new money recovered) AND the original actions
// those undos reverse (undoing pulls the recovered dollars back out). Shared by
// the embedded admin home (app/routes/app._index.tsx) and the web dashboard
// stat row (app/components/dashboard/screens/Dashboard.tsx) so the two surfaces
// can never disagree on the number.

export interface RecoveredInput {
  id?: string;
  outcome: string;
  dollar_impact_at_exec: number;
  undo_of?: string | null;
}

export function recovered(entries: RecoveredInput[]): {
  cents: number;
  count: number;
} {
  // Ids of original actions that have since been undone. An undo row carries
  // `undo_of` = the reversed action's id, so its impact must be clawed back.
  const undone = new Set(
    entries.map((e) => e.undo_of).filter((id): id is string => Boolean(id)),
  );
  // Only actions that actually recovered money count toward "Recovered $X across
  // N actions" — a succeeded snooze/neutral-resume recovers $0 and must not
  // inflate N (else "$0 across 2 actions" reads as a contradiction). P1-4.
  const recovering = entries.filter(
    (e) =>
      e.outcome === "succeeded" &&
      !e.undo_of &&
      !(e.id && undone.has(e.id)) &&
      (e.dollar_impact_at_exec || 0) > 0,
  );
  return {
    cents: recovering.reduce((s, e) => s + (e.dollar_impact_at_exec || 0), 0),
    count: recovering.length,
  };
}

export interface RecoveredWindowInput extends RecoveredInput {
  created_at: string;
}

// `recovered`, windowed to entries on/after `sinceIso`. Same inclusion rule
// (succeeded, undo bookkeeping rows excluded, undone originals clawed back) but
// bounded to a time window, so a tile labelled "Recovered (7d)" sums the
// trailing 7 days rather than everything the audit feed returns (up to 90d), and
// the daily action budget meter only counts today.
//
// Compare by parsed epoch, not string: Postgres serializes created_at as
// `...+00:00` with microseconds while the cutoff is `...Z` with milliseconds, so
// a byte-wise `>=` would wrongly drop rows in the first second of the window.
export function recoveredWithin(
  entries: RecoveredWindowInput[],
  sinceIso: string,
): { cents: number; count: number } {
  const cutoff = Date.parse(sinceIso);
  return recovered(entries.filter((e) => Date.parse(e.created_at) >= cutoff));
}

// Daily action budget used: the dollars (in cents) that value-recovering actions
// clawed back since the start of the current day — the same windowing as
// `recoveredWithin`. `entries` must already be in cents; `startOfDayIso` is the
// start-of-day cutoff (UTC, matching guardrail enforcement).
export type DailyUsedInput = RecoveredWindowInput;
export function dailyActionBudgetUsedCents(
  entries: DailyUsedInput[],
  startOfDayIso: string,
): number {
  return recoveredWithin(entries, startOfDayIso).cents;
}
