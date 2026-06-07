// QuickBooks → COGS ingestion.
//
// Pure transforms (parseInventoryItems, reconcileCost) are unit-tested without
// a DB. The orchestrator syncQuickbooksCogs (added below) wires them to Supabase.

export type QboItemCost = { id: string; sku: string; unitCostCents: number };

// Loose shape of the QBO Item query payload (raw-API-payload exception to
// no-`any`: precise optionals, never `any`).
type RawItem = { Id?: string; Sku?: string; PurchaseCost?: number; Type?: string };
type ItemsQueryResponse = { QueryResponse?: { Item?: RawItem[] } };

/** Extract inventory item costs, dropping anything without a SKU + positive cost. */
export function parseInventoryItems(json: unknown): QboItemCost[] {
  const items = (json as ItemsQueryResponse)?.QueryResponse?.Item ?? [];
  const out: QboItemCost[] = [];
  for (const it of items) {
    const sku = (it.Sku ?? "").trim();
    const cost = typeof it.PurchaseCost === "number" ? it.PurchaseCost : 0;
    if (!it.Id || !sku || cost <= 0) continue;
    out.push({ id: String(it.Id), sku, unitCostCents: Math.round(cost * 100) });
  }
  return out;
}

export type CostAction =
  | { kind: "noop" }
  | { kind: "insert" }
  | { kind: "update_then_insert"; closeId: string };

/** Decide how to fold an incoming cost into the current open cogs_fact row. */
export function reconcileCost(
  existingOpen: { id: string; unit_cost_cents: number } | null,
  incomingCents: number,
): CostAction {
  if (!existingOpen) return { kind: "insert" };
  if (existingOpen.unit_cost_cents === incomingCents) return { kind: "noop" };
  return { kind: "update_then_insert", closeId: existingOpen.id };
}
