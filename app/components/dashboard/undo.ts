// Optimistic audit-state update for an undo.
//
// recovered() (app/lib/recovered.ts) only claws an action's dollars back out of
// the "Recovered" total when a row carries undo_of = the original's id. So
// undoing must (a) flip the original to a reverted, non-undoable state, and
// (b) insert the undo row — using the id the server returned — so the claw-back
// is immediate rather than waiting on the next 15s poll (or never, if live sync
// is off). The live poller later emits the real server row with the same id;
// the id-dedup here keeps it from being added twice.

import type { AuditVM } from "./view-models";

export function applyUndo(
  audit: AuditVM[],
  entry: AuditVM,
  undoRowId: string,
): AuditVM[] {
  const flagged = audit.map((a) =>
    a.id === entry.id ? { ...a, undo_eligible: false, post: "Reverted" } : a,
  );
  // The poll may have already surfaced the server's undo row — don't duplicate.
  if (flagged.some((a) => a.id === undoRowId)) return flagged;

  const now = new Date().toISOString();
  const undoRow: AuditVM = {
    ...entry,
    id: undoRowId,
    undo_of: entry.id,
    dollar_impact_at_exec: -entry.dollar_impact_at_exec,
    outcome: "succeeded",
    undo_eligible: false,
    actor: "You",
    when: now,
    created_at: now,
    pre: entry.post,
    post: "Reverted",
  };
  return [undoRow, ...flagged];
}
