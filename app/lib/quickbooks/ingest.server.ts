// QuickBooks → COGS ingestion.
//
// Pure transforms (parseInventoryItems, reconcileCost) are unit-tested without
// a DB. The orchestrator syncQuickbooksCogs (below) wires them to Supabase.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QboConnection } from "./client.server";

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

export interface QbSyncCounts {
  matched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedNoMatch: number;
  skippedCurrency: number;
}

/**
 * Pull current inventory item costs from QuickBooks and time-version them into
 * cogs_fact(source='quickbooks') for one shop. Idempotent: unchanged costs are
 * no-ops; a changed cost closes the prior open row and opens a new one.
 */
export async function syncQuickbooksCogs(
  shopId: string,
  conn: QboConnection,
  sb: SupabaseClient,
): Promise<QbSyncCounts> {
  const raw = await conn.client.queryItems();
  const rawIns = await sb
    .from("raw_quickbooks_poll")
    .insert({ shop_id: shopId, poll_kind: "items", payload: raw as object, polled_at: new Date().toISOString() });
  if (rawIns.error) throw rawIns.error;

  const items = parseInventoryItems(raw);
  const homeCurrency = await conn.client.queryHomeCurrency();

  const { data: skuRows, error: skuErr } = await sb
    .from("sku_dim")
    .select("id, sku, currency")
    .eq("shop_id", shopId);
  if (skuErr) throw skuErr;
  const skuToInfo = new Map<string, { id: string; currency: string | null }>();
  for (const r of (skuRows ?? []) as Array<{ id: string; sku: string | null; currency: string | null }>) {
    if (r.sku) skuToInfo.set(r.sku, { id: r.id, currency: r.currency });
  }

  const counts: QbSyncCounts = {
    matched: 0, inserted: 0, updated: 0, unchanged: 0, skippedNoMatch: 0, skippedCurrency: 0,
  };
  const now = new Date().toISOString();

  for (const item of items) {
    const info = skuToInfo.get(item.sku);
    if (!info) {
      counts.skippedNoMatch++;
      continue;
    }
    // Don't write a wrong-currency cost: when both the QB home currency and the
    // SKU's currency are known and differ, skip it (v1 does not convert FX).
    if (homeCurrency && info.currency && info.currency !== homeCurrency) {
      counts.skippedCurrency++;
      continue;
    }
    counts.matched++;
    const skuId = info.id;

    // shop_id scope on the read too (matches the close below): the
    // service-role client bypasses RLS, so the tenant filter is the guard.
    const { data: openRow, error: openErr } = await sb
      .from("cogs_fact")
      .select("id, unit_cost_cents")
      .eq("shop_id", shopId)
      .eq("sku_id", skuId)
      .eq("source", "quickbooks")
      .is("effective_to", null)
      .maybeSingle();
    if (openErr) throw openErr;

    const action = reconcileCost(
      (openRow as { id: string; unit_cost_cents: number } | null) ?? null,
      item.unitCostCents,
    );
    if (action.kind === "noop") {
      counts.unchanged++;
      continue;
    }
    if (action.kind === "update_then_insert") {
      // Scope the close by shop_id too: the service-role client bypasses RLS, so
      // a tenant filter on every write is the only cross-shop guard.
      const close = await sb
        .from("cogs_fact")
        .update({ effective_to: now })
        .eq("id", action.closeId)
        .eq("shop_id", shopId);
      if (close.error) throw close.error;
      counts.updated++;
    } else {
      counts.inserted++;
    }
    const ins = await sb.from("cogs_fact").insert({
      shop_id: shopId,
      sku_id: skuId,
      unit_cost_cents: item.unitCostCents,
      effective_from: now,
      source: "quickbooks",
      source_ref: item.id,
    });
    if (ins.error) throw ins.error;
  }
  return counts;
}
