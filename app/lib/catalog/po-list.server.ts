// Purchase-order list read: a dedicated paginated view over the shop's
// create_po_draft action_audit rows. Each row's params snapshot (when the
// draft succeeded) carries the full PO payload, so the list can show the PO
// number, first-line sku, line count, and total straight from the audit trail
// — and gate the PDF download on the same predicate the PDF route 404s on.
import { getSupabase } from "../supabase.server";

/** Wire shape of one audit row as this module reads it. */
export interface PoAuditRow {
  id: string;
  action_kind: string;
  outcome: string;
  params: unknown;
  last_error: string | null;
  created_at: string;
}

export interface PurchaseOrderRow {
  id: string;
  poNumber: string | null;
  sku: string | null;
  lineCount: number;
  totalCents: number | null;
  outcome: string;
  createdAt: string;
  lastError: string | null;
  hasPdf: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Map one raw audit row to a list row. Pure and exported so the mapping —
 *  including the PDF-availability predicate, which must mirror the PDF
 *  route's 404 check exactly (create_po_draft AND a params.po snapshot) —
 *  is unit-testable without a database. */
export function mapPoRow(raw: PoAuditRow): PurchaseOrderRow {
  const params = asObject(raw.params);
  const poValue = params ? params.po : null;
  const po = asObject(poValue);
  const lines = po && Array.isArray(po.lines) ? po.lines : [];
  const firstLine = asObject(lines[0]);
  const sku = firstLine && typeof firstLine.sku === "string" && firstLine.sku ? firstLine.sku : null;
  const poNumber = po && typeof po.po_number === "string" && po.po_number ? po.po_number : null;
  const totalCents =
    po && typeof po.total_cents === "number" && Number.isFinite(po.total_cents)
      ? po.total_cents
      : null;
  return {
    id: raw.id,
    poNumber,
    sku,
    lineCount: lines.length,
    totalCents,
    outcome: raw.outcome,
    createdAt: raw.created_at,
    lastError: raw.last_error,
    hasPdf: raw.action_kind === "create_po_draft" && poValue != null,
  };
}

export async function listPurchaseOrders(
  shopId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: PurchaseOrderRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(0, opts.offset ?? 0);
  const { data, error, count } = await getSupabase()
    .from("action_audit")
    .select("id, outcome, params, last_error, created_at", { count: "exact" })
    .eq("shop_id", shopId)
    .eq("action_kind", "create_po_draft")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return {
    // action_kind isn't selected — the filter above already pins it, so the
    // predicate input is the filtered literal.
    rows: (data ?? []).map((row) =>
      mapPoRow({
        id: String(row.id),
        action_kind: "create_po_draft",
        outcome: String(row.outcome),
        params: row.params,
        last_error: row.last_error == null ? null : String(row.last_error),
        created_at: String(row.created_at),
      }),
    ),
    total: count ?? 0,
  };
}
