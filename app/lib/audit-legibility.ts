// app/lib/audit-legibility.ts
//
// Single shared "brain" for the audit log. Turns an enriched AuditEntry into a
// display-ready AuditLegibility consumed by BOTH surfaces: the Polaris extension
// (app/routes/app.audit.tsx) and the dashboard (via adaptAudit). Parity by
// construction — match the contract, render natively on each side.
//
// PURE: imports only ./types and ./labels. Never import a *.server module here;
// the client-only dashboard bundle imports this file.

import type { ActionKind, AuditEntry, CostSource } from "./types";
import { DETECTOR_LABELS, MARGIN_BASIS_LABELS, actorLabel } from "./labels";

export type ActionMode = "auto" | "manual";
export type MarginBasis = "measured" | "alert_estimate" | "snapshot" | "none";

export interface AuditLegibility {
  mode: ActionMode;
  actorDisplay: string;
  marginBasis: MarginBasis;
  marginBasisLabel: string;
  costLineage: CostSource[];
  why: string;
  whyDetail?: string;
}

// Actions whose booked figure is ad-spend dollars stopped — lineage is the ad
// platform. (Mirrors VALUE_RECOVERING budget kinds in audit-impact.ts.)
export const AD_SPEND_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign", "reduce_campaign_budget", "reallocate_budget", "exclude_geo",
]);
// Actions whose booked figure involves unit margin (price − COGS) — lineage is
// the COGS source (+ Shopify price). Used server-side to resolve cost_sources.
export const MARGIN_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "create_po_draft", "reallocate_inventory",
]);
// Actions that recover value (so a 0 figure is unexpected, not "none"). Mirrors
// audit-impact.ts VALUE_RECOVERING exactly — keep in sync.
const VALUE_RECOVERING: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign", "reduce_campaign_budget", "reallocate_budget",
  "exclude_geo", "reallocate_inventory", "create_po_draft",
]);

function hasBudgetStates(e: AuditEntry): boolean {
  const pre = e.pre_state as Record<string, unknown> | null;
  const post = e.post_state as Record<string, unknown> | null;
  const n = (o: Record<string, unknown> | null, k: string) => o && typeof o[k] === "number";
  // plain budget states (pause/reduce) or reallocate's {source:{...}} shape
  return Boolean(
    n(pre, "daily_budget_cents") || n(post, "daily_budget_cents") ||
    n((pre?.source ?? null) as Record<string, unknown> | null, "daily_budget_cents"),
  );
}

function estimateSnapshot(e: AuditEntry): boolean {
  const post = e.post_state as Record<string, unknown> | null;
  const pre = e.pre_state as Record<string, unknown> | null;
  return typeof (post?.estimate_cents ?? pre?.estimate_cents) === "number";
}

/** Provenance of dollar_impact_at_exec, derived from the SAME inputs the figure
 *  was computed from (insertAuditWithIdempotency): alert_id → at-stake estimate;
 *  else budget pre/post delta → measured; else estimate snapshot; else none. */
export function marginBasisFor(e: AuditEntry): MarginBasis {
  const recovering = VALUE_RECOVERING.has(e.action_kind);
  if (!recovering && (e.dollar_impact_at_exec ?? 0) === 0) return "none";
  if (e.alert_id) return "alert_estimate";
  if (hasBudgetStates(e)) return "measured";
  if (estimateSnapshot(e)) return "snapshot";
  return "none";
}

function deriveWhy(e: AuditEntry, mode: ActionMode): { why: string; whyDetail?: string } {
  if (e.undo_of) return { why: `Reversal of ${e.undo_of.slice(0, 8)}`, whyDetail: undefined };
  const detector = DETECTOR_LABELS[e.detector_id] ?? "";
  if (mode === "auto") {
    if (e.trigger_reason) {
      const r = e.trigger_reason;
      return { why: r.length > 64 ? `${r.slice(0, 61)}…` : r, whyDetail: r };
    }
    return { why: detector ? `Autopilot — ${detector}` : "Autopilot", whyDetail: detector || undefined };
  }
  if (e.alert_id && detector) return { why: `Resolved: ${detector}`, whyDetail: detector };
  const surface = e.actor === "merchant:web-dashboard" ? "dashboard" : "campaigns page";
  return { why: `Manual — ${surface}`, whyDetail: undefined };
}

export function auditLegibility(e: AuditEntry): AuditLegibility {
  const mode: ActionMode = e.actor.startsWith("autopilot") ? "auto" : "manual";
  const basis = marginBasisFor(e);
  const { why, whyDetail } = deriveWhy(e, mode);
  return {
    mode,
    actorDisplay: actorLabel(e.actor),
    marginBasis: basis,
    marginBasisLabel: MARGIN_BASIS_LABELS[basis],
    costLineage: e.cost_sources ?? [],
    why,
    whyDetail,
  };
}
