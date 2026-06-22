// app/lib/actions/remediation-reason.ts
// Deterministic audit reasoning for an autopilot remediation action. Built
// ENTIRELY from the stored RemediationPlan + detector — no model call at
// execution time (spec §"Decisions" item 2). The string is persisted to
// action_audit.trigger_reason so the merchant sees why autopilot acted and how
// the recommended move ranked against the runner-up.
import type { DetectorId } from "../types";
import type { MoveKind, RemediationPlan } from "../remediation/types";

function usd(cents: number): string {
  const dollars = Math.round(cents / 100);
  return "$" + Math.abs(dollars).toLocaleString("en-US");
}

/** One plain-language line: which move, why (structural verdict), projected 30d
 *  dollars, and the next-best alternative's dollars when one exists (so the
 *  ranking is legible in the log). Never empty, never multi-line. */
export function remediationReason(
  plan: RemediationPlan,
  recommended: MoveKind,
  detectorId: DetectorId,
): string {
  const rec = plan.moves.find((m) => m.kind === recommended);
  const recCents = rec?.dollarImpactCents ?? 0;

  const verdict = plan.structurallyDead
    ? "structurally dead (loses money at zero ad spend)"
    : "viable product, ad/return-driven loss";

  // Runner-up = the highest-$ move that is neither the recommendation nor snooze.
  const runnerUp = plan.moves.find(
    (m) => m.kind !== recommended && m.kind !== "snooze",
  );

  const head =
    `Autopilot recommended ${recommended} for ${detectorId} ` +
    `(${verdict}); projected 30d recovery ${usd(recCents)}`;

  const tail = runnerUp
    ? ` vs ${runnerUp.kind} ${usd(runnerUp.dollarImpactCents)}.`
    : ".";

  return head + tail;
}
