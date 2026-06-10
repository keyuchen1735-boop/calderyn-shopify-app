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
