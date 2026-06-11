// Recovered dollars — succeeded actions, excluding undo rows themselves
// (an undo is bookkeeping, not new money recovered). Shared by the embedded
// admin home (app/routes/app._index.tsx) and the web dashboard stat row
// (app/components/dashboard/screens/Dashboard.tsx) so the two surfaces can
// never disagree on the number.

export interface RecoveredInput {
  outcome: string;
  dollar_impact_at_exec: number;
  undo_of?: string | null;
}

export function recovered(entries: RecoveredInput[]): {
  cents: number;
  count: number;
} {
  const succeeded = entries.filter(
    (e) => e.outcome === "succeeded" && !e.undo_of,
  );
  return {
    cents: succeeded.reduce((s, e) => s + (e.dollar_impact_at_exec || 0), 0),
    count: succeeded.length,
  };
}

export interface DailyUsedInput extends RecoveredInput {
  created_at: string;
}

// Daily action budget used: the dollars (in cents) that value-recovering actions
// clawed back since the start of the current day. Same inclusion rule as
// `recovered` (succeeded, excluding undo bookkeeping rows) but windowed to today,
// so the "Daily action budget" meter on the dashboard/extension actually moves
// when you act on something. `entries` must already be in cents; `startOfDayIso`
// is the start-of-day cutoff (UTC, matching guardrail enforcement).
//
// Compare by parsed epoch, not string: Postgres serializes created_at as
// `...+00:00` with microseconds while the cutoff is `...Z` with milliseconds, so
// a byte-wise `>=` would wrongly drop rows in the first second of the day.
export function dailyActionBudgetUsedCents(
  entries: DailyUsedInput[],
  startOfDayIso: string,
): number {
  const cutoff = Date.parse(startOfDayIso);
  const today = entries.filter((e) => Date.parse(e.created_at) >= cutoff);
  return recovered(today).cents;
}
