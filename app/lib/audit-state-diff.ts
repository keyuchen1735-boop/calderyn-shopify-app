// app/lib/audit-state-diff.ts
//
// Turns an action's recorded pre/post state into human-readable before→after
// rows for the audit detail panel — never the raw JSON blob. PURE and shared by
// BOTH surfaces (the Polaris extension and the dashboard) so the two render the
// same words and money formatting. Imports only ./format (client-safe).

import { fmtMoneyDec } from "./format";

export interface StateDiffRow {
  label: string;
  /** Formatted "before" value, or null when the action has no prior state (a creation). */
  before: string | null;
  /** Formatted "after" value, or null when there is no resulting state (a failure). */
  after: string | null;
}

/** Read a number at a nested path (object keys or array indices), else null. */
function num(obj: unknown, ...path: string[]): number | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

function str(obj: unknown, key: string): string | null {
  const v = (obj as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v ? v : null;
}

const money = (cents: number | null): string | null => (cents == null ? null : fmtMoneyDec(cents));
const units = (n: number | null): string | null =>
  n == null ? null : `${n.toLocaleString("en-US")} units`;

/**
 * Human before→after rows for an audit row's pre/post state. Only emits fields
 * that carry a value and actually changed; recognises the budget/status,
 * reallocation, inventory, and PO-draft shapes. Any unknown/complex shape
 * returns `[]` so the detail panel simply omits the section (never raw JSON).
 */
export function stateDiff(actionKind: string, preState: unknown, postState: unknown): StateDiffRow[] {
  const pre = preState as Record<string, unknown> | null;
  const post = postState as Record<string, unknown> | null;
  const rows: StateDiffRow[] = [];
  const push = (label: string, before: string | null, after: string | null) => {
    // No resulting state = a failed action; its failure reason is shown instead,
    // so don't render a lone "before". (Creations use rows.push directly below.)
    if (after == null) return;
    if (before === after) return; // unchanged — don't show
    rows.push({ label, before, after });
  };

  switch (actionKind) {
    case "reallocate_budget":
      push(
        "Source daily budget",
        money(num(pre, "source", "daily_budget_cents")),
        money(num(post, "source", "daily_budget_cents")),
      );
      push(
        "Dest daily budget",
        money(num(pre, "dest", "daily_budget_cents")),
        money(num(post, "dest", "daily_budget_cents")),
      );
      break;

    case "pause_campaign":
    case "resume_campaign":
    case "reduce_campaign_budget":
    case "update_campaign_budget":
      push("Status", str(pre, "status"), str(post, "status"));
      push("Daily budget", money(num(pre, "daily_budget_cents")), money(num(post, "daily_budget_cents")));
      break;

    case "reallocate_inventory":
      push(
        "Source stock",
        units(num(pre, "from_location_available")),
        units(num(post, "from_location_available")),
      );
      break;

    case "create_po_draft": {
      // A PO draft is a creation — no "before". The undo row carries the PO in
      // pre_state, the original in post_state, so read whichever holds it.
      const src = post && post.po ? post : pre;
      const total = num(src, "po", "total_cents");
      const qty = num(src, "po", "lines", "0", "quantity");
      if (total != null) rows.push({ label: "PO total", before: null, after: fmtMoneyDec(total) });
      if (qty != null) rows.push({ label: "Quantity", before: null, after: `${qty.toLocaleString("en-US")} units` });
      break;
    }

    case "duplicate_campaign": {
      // A duplicate is a creation — no "before". The new campaign's ids live
      // in post_state.
      const externalId = str(post, "copied_campaign_external_id");
      if (externalId != null) rows.push({ label: "Copy created", before: null, after: externalId });
      break;
    }
  }

  return rows;
}
