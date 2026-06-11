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
  const succeeded = entries.filter(
    (e) => e.outcome === "succeeded" && !e.undo_of && !(e.id && undone.has(e.id)),
  );
  return {
    cents: succeeded.reduce((s, e) => s + (e.dollar_impact_at_exec || 0), 0),
    count: succeeded.length,
  };
}
