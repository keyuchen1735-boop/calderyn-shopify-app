// app/lib/actions/po-action.server.ts
// Draft a purchase order from a shop-scoped alert + merchant qty/cost, snapshot
// it into the audit row, and acknowledge the alert. Shared by the embedded admin
// and the dashboard (parity). The SKU + line title come from the trusted alert
// record; only the qty/cost shape the local document (no external side effect),
// and they are strictly validated. The PDF is rendered on demand from the
// snapshot by the audit po.pdf routes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { acknowledgeAlert } from "../alerts.server";
import { buildPoDraft } from "../po/draft.server";
import { resolveSkuForDiscontinue } from "./discontinue.server";
import { suggestedReorderQty } from "./reorder-qty";
import type { ActionKind, Alert, AuditEntry } from "../types";

export interface PoActionClient {
  alerts: { get(id: string, signal?: AbortSignal): Promise<Alert> };
  actions: {
    execute(opts: {
      alertId: string | null;
      kind: ActionKind;
      params: Record<string, unknown>;
      idempotencyKey: string;
    }): Promise<AuditEntry>;
  };
}

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

export async function executeCreatePoDraft(opts: {
  client: PoActionClient;
  sb: SupabaseClient;
  shopId: string;
  shopDomain: string;
  alertId: string;
  idempotencyKey: string;
  /** Raw merchant input (validated here): a positive whole number of units. */
  quantity: string;
  /** Raw merchant input: a non-negative dollar amount, or "" for TBD. */
  unitCost: string;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, sb, shopId, shopDomain, alertId, idempotencyKey, quantity, unitCost, signal } =
    opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes("create_po_draft")) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"create_po_draft" is not a permitted action for this alert.`,
    });
  }

  // A one-click Approve sends no quantity; default to a computed reorder
  // suggestion from the alert's velocity/lead-time so the card works without a
  // typed number. A typed quantity always wins. If no suggestion can be derived
  // (no usable velocity), qtyRaw stays "" and the validation below fails visibly.
  const typed = quantity.trim();
  const qtyRaw = typed === "" ? String(suggestedReorderQty(alert.evidence ?? {}) ?? "") : typed;
  const qty = Number(qtyRaw);
  if (!/^\d+$/.test(qtyRaw) || qty <= 0 || qty > 1_000_000) {
    throw new CalderynError({
      code: "invalid_po_quantity",
      status: 422,
      message: "Order quantity must be a positive whole number.",
    });
  }

  const costRaw = unitCost.trim();
  let unitCostCents: number | null = null;
  if (costRaw !== "") {
    const dollars = Number(costRaw);
    if (!Number.isFinite(dollars) || dollars < 0) {
      throw new CalderynError({
        code: "invalid_po_unit_cost",
        status: 422,
        message: "Unit cost must be a non-negative dollar amount, or blank for TBD.",
      });
    }
    unitCostCents = Math.round(dollars * 100);
  }

  if (!alert.sku) {
    throw new CalderynError({
      code: "invalid_po_target",
      status: 422,
      message: "This alert has no SKU to draft a purchase order against.",
    });
  }

  // A discontinued SKU must never be re-orderable (rule 12).
  const target = await resolveSkuForDiscontinue(sb, shopId, alert.sku);
  if (target?.alreadyFlagged) {
    throw new CalderynError({
      code: "sku_discontinued",
      status: 409,
      message:
        "This product is marked Do Not Reorder. Restore it (undo the discontinue) before drafting a purchase order.",
    });
  }

  const ev = alert.evidence ?? {};
  const title = str(ev.title) || str(ev.sku_title) || alert.sku;

  const po = buildPoDraft({
    alertId,
    detectorId: alert.detector_id,
    shopDomain,
    sku: alert.sku,
    title,
    quantity: qty,
    unitCostCents,
    now: new Date(),
  });

  const audit = await client.actions.execute({
    alertId,
    kind: "create_po_draft",
    params: { po },
    idempotencyKey,
  });
  const acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
