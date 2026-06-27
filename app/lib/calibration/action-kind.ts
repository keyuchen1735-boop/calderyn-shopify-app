// Single source of truth for normalizing an executor/gateway action kind to the
// action_kind it is AUDITED and CALIBRATED under. Pure, no I/O.
//
// reallocate_spend_sku is a SKU-scoped gateway whose executor writes
// action_audit.action_kind = 'reallocate_budget' (via executeReallocation), and
// reallocate_spend_sku is NOT a member of the action_kind Postgres enum — so it
// must never reach an enum-typed column or RPC param (it would raise 22P02).
// Every other kind is its own action_kind enum value.
//
// Used by BOTH the graduation READ (autopilot's tryRemediation gate) and the
// approval WRITE (recordApproval), so the two always key the same pair: a
// merchant approval of a SKU realloc trains the reallocate_budget pair that the
// autopilot gate later checks.
import type { ActionKind } from "../types";

export function calibrationActionKind(kind: ActionKind): ActionKind {
  return kind === "reallocate_spend_sku" ? "reallocate_budget" : kind;
}
