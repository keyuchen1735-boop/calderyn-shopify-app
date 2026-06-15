// Undoing an audited action must immediately pull its dollars back out of the
// "Recovered" total. recovered() claws back an original only when a row carries
// undo_of = originalId, so the optimistic update has to add that undo row (using
// the id the server returned), not just flip the original to "Reverted".

import { describe, it, expect } from "vitest";
import { applyUndo } from "../undo";
import { recovered } from "~/lib/recovered";
import type { AuditVM } from "../view-models";

function entry(id: string, cents: number, over: Partial<AuditVM> = {}): AuditVM {
  return {
    id,
    action_kind: "pause_campaign",
    verb: "Paused campaign",
    target: "Prospecting",
    detail: "",
    dollar_impact_at_exec: cents,
    outcome: "succeeded",
    actor: "merchant",
    when: new Date().toISOString(),
    created_at: new Date().toISOString(),
    undo_eligible: true,
    undo_of: null,
    pre: "—",
    post: "—",
    mode: "manual",
    actorDisplay: "You",
    marginBasis: "none",
    marginBasisLabel: "No booked margin",
    costLineage: [],
    why: "Manual — dashboard",
    ...over,
  };
}

describe("applyUndo", () => {
  it("adds an undo row so recovered() claws back the original immediately", () => {
    const original = entry("au-1", 12_000);
    expect(recovered([original]).cents).toBe(12_000);

    const after = applyUndo([original], original, "au-2");
    expect(recovered(after).cents).toBe(0);
  });

  it("flips the original to not-undo-eligible and Reverted", () => {
    const after = applyUndo([entry("au-1", 12_000)], entry("au-1", 12_000), "au-2");
    const o = after.find((a) => a.id === "au-1")!;
    expect(o.undo_eligible).toBe(false);
    expect(o.post).toBe("Reverted");
  });

  it("tags the new row with undo_of and the returned id", () => {
    const after = applyUndo([entry("au-1", 12_000)], entry("au-1", 12_000), "au-2");
    const undoRow = after.find((a) => a.id === "au-2")!;
    expect(undoRow.undo_of).toBe("au-1");
  });

  it("does not duplicate the undo row when the poller already added it", () => {
    const original = entry("au-1", 12_000);
    const pollerUndo = entry("au-2", -12_000, { undo_of: "au-1" });
    const after = applyUndo([pollerUndo, original], original, "au-2");
    expect(after.filter((a) => a.id === "au-2").length).toBe(1);
  });
});
