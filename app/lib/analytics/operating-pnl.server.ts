import { getSupabase } from "../supabase.server";
import { quickbooksClientForShop } from "../quickbooks/client.server";
import { readPaged } from "../db/read-paged.server";
import {
  allocateOperatingExpenses,
  parseQuickBooksCashFlow,
  parseQuickBooksReport,
  type OperatingPnlData,
} from "./operating-pnl";

const SALE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];
const IMPORTED_SALE_STATES = ["paid", "partially_paid", "partially_refunded", "refunded"]
  .flatMap((value) => [value, value.toUpperCase()]);
const ROW_CAP = 10_000;
const IN_CHUNK = 200;

type ProductAccumulator = {
  id: string;
  title: string;
  sku: string | null;
  imageUrl: string | null;
  netRevenueCents: number;
  cogsCents: number;
};

function netLineRevenue(
  rows: Array<Record<string, unknown>>,
  orderKey: string,
  gross: (row: Record<string, unknown>) => number,
  discounts: Map<string, number>,
): Map<Record<string, unknown>, number> {
  const result = new Map<Record<string, unknown>, number>();
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const orderId = String(row[orderKey]);
    groups.set(orderId, [...(groups.get(orderId) ?? []), row]);
  }
  for (const [orderId, lines] of groups) {
    const total = lines.reduce((sum, line) => sum + gross(line), 0);
    const discount = Math.min(Math.max(0, discounts.get(orderId) ?? 0), total);
    let allocated = 0;
    lines.forEach((line, index) => {
      const share = index === lines.length - 1
        ? discount - allocated
        : total === 0 ? 0 : Math.round(discount * gross(line) / total);
      allocated += share;
      result.set(line, gross(line) - share);
    });
  }
  return result;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function loadOperatingPnl(
  shopId: string,
  days = 30,
  now = new Date(),
): Promise<OperatingPnlData> {
  const connection = await quickbooksClientForShop(shopId);
  const endDate = day(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const startDate = day(start);
  if (!connection) {
    return { connected: false, currency: "USD", startDate, endDate, statement: null, netCashFlowCents: null, products: [] };
  }

  const [profitAndLoss, cashFlow, currency, products] = await Promise.all([
    connection.client.queryReport("ProfitAndLoss", {
      startDate, endDate, accountingMethod: "Accrual", summarizeBy: "Days",
    }),
    connection.client.queryReport("CashFlow", { startDate, endDate, accountingMethod: "Cash" }),
    connection.client.queryHomeCurrency(),
    loadProductContributions(shopId, start.toISOString()),
  ]);
  const statement = parseQuickBooksReport(profitAndLoss);
  // Allocate every below-gross QuickBooks cost (operating expenses, other
  // expenses and tax), so the per-product number is net P&L rather than a
  // contribution-margin proxy that silently stops above the bottom line.
  const belowGrossCostsCents = statement.incomeCents - statement.cogsCents - statement.netIncomeCents;
  const allocated = allocateOperatingExpenses(products, belowGrossCostsCents)
    .map((product) => ({
      ...product,
      netMarginPct: product.netRevenueCents === 0
        ? null
        : product.netOperatingProfitCents / product.netRevenueCents * 100,
    }))
    .sort((a, b) => b.netOperatingProfitCents - a.netOperatingProfitCents);

  return {
    connected: true,
    currency: currency ?? "USD",
    startDate,
    endDate,
    statement,
    netCashFlowCents: parseQuickBooksCashFlow(cashFlow),
    products: allocated,
  };
}

async function loadProductContributions(
  shopId: string,
  sinceIso: string,
): Promise<Array<ProductAccumulator & { contributionCents: number }>> {
  const sb = getSupabase();
  const [nativeOrders, importedOrders, nativeRefunds, importedRefunds] = await Promise.all([
    readPaged<{ id: string; subtotal_cents: number }>("orders", shopId, ROW_CAP, (from, to) =>
      sb.from("orders").select("id, subtotal_cents").eq("shop_id", shopId).in("state", SALE_STATES).gte("created_at", sinceIso).range(from, to)),
    readPaged<{ id: string; discount_cents: number }>("imported_order", shopId, ROW_CAP, (from, to) =>
      sb.from("imported_order").select("id, discount_cents").eq("shop_id", shopId).in("financial_status", IMPORTED_SALE_STATES).gte("processed_at", sinceIso).range(from, to)),
    readPaged<{ sku_id: string | null; subtotal_cents: number }>("refund_fact", shopId, ROW_CAP, (from, to) =>
      sb.from("refund_fact").select("sku_id, subtotal_cents").eq("shop_id", shopId).like("external_id", "gid://calderyn/%").gte("processed_at", sinceIso).range(from, to)),
    readPaged<{ sku_id: string | null; subtotal_cents: number }>("imported_refund", shopId, ROW_CAP, (from, to) =>
      sb.from("imported_refund").select("sku_id, subtotal_cents").eq("shop_id", shopId).gte("processed_at", sinceIso).range(from, to)),
  ]);
  const nativeIds = nativeOrders.map((row) => String(row.id));
  const importedIds = importedOrders.map((row) => String(row.id));
  const importedDiscounts = new Map(importedOrders.map((row) => [String(row.id), Number(row.discount_cents ?? 0)]));
  const nativeLines: Array<Record<string, unknown>> = [];
  for (let i = 0; i < nativeIds.length; i += IN_CHUNK) {
    nativeLines.push(...await readPaged<Record<string, unknown>>("order_line", shopId, ROW_CAP, (from, to) =>
      sb.from("order_line").select("order_id, variant_id, title_snapshot, quantity, unit_price_cents, unit_cost_cents_snapshot").eq("shop_id", shopId).in("order_id", nativeIds.slice(i, i + IN_CHUNK)).range(from, to)));
  }
  const nativeGross = new Map<string, number>();
  for (const row of nativeLines) {
    const orderId = String(row.order_id);
    const gross = Number(row.quantity ?? 0) * Number(row.unit_price_cents ?? 0);
    nativeGross.set(orderId, (nativeGross.get(orderId) ?? 0) + gross);
  }
  const nativeDiscounts = new Map(nativeOrders.map((row) => [
    String(row.id),
    Math.max(0, (nativeGross.get(String(row.id)) ?? 0) - Number(row.subtotal_cents ?? 0)),
  ]));
  const importedLines: Array<Record<string, unknown>> = [];
  for (let i = 0; i < importedIds.length; i += IN_CHUNK) {
    importedLines.push(...await readPaged<Record<string, unknown>>("imported_order_line", shopId, ROW_CAP, (from, to) =>
      sb.from("imported_order_line").select("imported_order_id, sku_id, quantity, total_cents, unit_cost_cents_snapshot").eq("shop_id", shopId).in("imported_order_id", importedIds.slice(i, i + IN_CHUNK)).range(from, to)));
  }

  const ids = [...new Set([
    ...nativeLines.map((row) => String(row.variant_id)),
    ...importedLines.flatMap((row) => row.sku_id ? [String(row.sku_id)] : []),
    ...nativeRefunds.flatMap((row) => row.sku_id ? [String(row.sku_id)] : []),
    ...importedRefunds.flatMap((row) => row.sku_id ? [String(row.sku_id)] : []),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const skuRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const read = await sb.from("sku_dim").select("id, sku, title, image_url").eq("shop_id", shopId).in("id", ids.slice(i, i + IN_CHUNK));
    if (read.error) throw new Error(`sku_dim read failed: ${read.error.message}`);
    skuRows.push(...(read.data ?? []));
  }
  const catalog = new Map(skuRows.map((row) => [String(row.id), row]));
  const products = new Map<string, ProductAccumulator>();
  const nativeNet = netLineRevenue(nativeLines, "order_id", (row) => Number(row.quantity ?? 0) * Number(row.unit_price_cents ?? 0), nativeDiscounts);
  const importedNet = netLineRevenue(importedLines, "imported_order_id", (row) => Number(row.total_cents ?? 0), importedDiscounts);
  const add = (id: string, fallbackTitle: string, quantity: number, revenue: number, unitCost: unknown) => {
    const sku = catalog.get(id);
    const current = products.get(id) ?? {
      id,
      title: String(sku?.title ?? fallbackTitle),
      sku: typeof sku?.sku === "string" ? sku.sku : null,
      imageUrl: typeof sku?.image_url === "string" ? sku.image_url : null,
      netRevenueCents: 0,
      cogsCents: 0,
    };
    current.netRevenueCents += revenue;
    if (unitCost != null) current.cogsCents += quantity * Number(unitCost);
    products.set(id, current);
  };
  for (const row of nativeLines) {
    const quantity = Number(row.quantity ?? 0);
    add(String(row.variant_id), String(row.title_snapshot ?? "Untitled product"), quantity,
      nativeNet.get(row) ?? 0, row.unit_cost_cents_snapshot);
  }
  for (const row of importedLines) {
    const id = row.sku_id ? String(row.sku_id) : `unknown:${products.size}`;
    add(id, "Untitled product", Number(row.quantity ?? 0), importedNet.get(row) ?? 0, row.unit_cost_cents_snapshot);
  }
  for (const row of [...nativeRefunds, ...importedRefunds]) {
    if (!row.sku_id) continue;
    add(String(row.sku_id), "Untitled product", 0, -Number(row.subtotal_cents ?? 0), null);
  }
  return [...products.values()].map((product) => ({
    ...product,
    contributionCents: product.netRevenueCents - product.cogsCents,
  }));
}
