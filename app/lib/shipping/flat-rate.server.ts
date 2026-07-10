// Merchant flat rates (ship_flat_rate): the shop's authoritative no-carrier rate
// source. When no live carrier (EasyPost) is connected, checkout quotes from these
// rows instead of failing — a brand-new store can take its first order with zero
// shipping setup (rate-source.server.ts falls through to the built-in bands when
// this table is empty too). Rows group by label ("Standard", "Express"): within a
// label, weight bands (max_weight_oz ascending, null = no cap) pick the price.
// Zone match: destination country === origin country → 'domestic', else
// 'international'; 'all' rows always match. Money is integer cents.
import { getSupabase } from "~/lib/supabase.server";
import type {
  NormalizedRateOption,
  RateQuoteResult,
  RateQuoteSource,
  RateRequest,
} from "~/lib/ship-cost/adapters/rate-quote";

export interface FlatRateRow {
  id: string;
  label: string;
  zone: "domestic" | "international" | "all";
  maxWeightOz: number | null;
  amountCents: number;
  estTransitDays: number | null;
  position: number;
  updatedAt: string;
}

const ZONES = new Set(["domestic", "international", "all"]);

function toRow(r: Record<string, unknown>): FlatRateRow {
  const zone = String(r.zone ?? "all");
  return {
    id: String(r.id),
    label: String(r.label ?? ""),
    zone: (ZONES.has(zone) ? zone : "all") as FlatRateRow["zone"],
    maxWeightOz: r.max_weight_oz == null ? null : Number(r.max_weight_oz),
    amountCents: Number(r.amount_cents ?? 0),
    estTransitDays: r.est_transit_days == null ? null : Number(r.est_transit_days),
    position: Number(r.position ?? 0),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function loadFlatRates(shopId: string): Promise<FlatRateRow[]> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("ship_flat_rate")
    .select("id, label, zone, max_weight_oz, amount_cents, est_transit_days, position, updated_at")
    .eq("shop_id", shopId)
    .order("position", { ascending: true })
    .order("label", { ascending: true });
  if (error) throw new Error(`ship_flat_rate read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}

export interface FlatRateInput {
  label: string;
  zone: FlatRateRow["zone"];
  maxWeightOz: number | null;
  amountCents: number;
  estTransitDays: number | null;
}

/** Position is server-assigned (append on insert, preserved on update) — deriving it
 *  client-side from a possibly-stale list would let two tabs silently reshuffle rows. */
export async function upsertFlatRate(
  shopId: string,
  input: FlatRateInput,
  id?: string,
): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();
  const row = {
    shop_id: shopId,
    label: input.label,
    zone: input.zone,
    max_weight_oz: input.maxWeightOz,
    amount_cents: input.amountCents,
    est_transit_days: input.estTransitDays,
    updated_at: new Date().toISOString(),
  };
  if (id) {
    const res = await sb.from("ship_flat_rate").update(row).eq("shop_id", shopId).eq("id", id);
    if (res.error) throw new Error(`ship_flat_rate write failed: ${res.error.message}`);
    return;
  }
  const { count, error: countError } = await sb
    .from("ship_flat_rate")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId);
  if (countError) throw new Error(`ship_flat_rate count failed: ${countError.message}`);
  const res = await sb.from("ship_flat_rate").insert({ ...row, position: count ?? 0 });
  if (res.error) throw new Error(`ship_flat_rate write failed: ${res.error.message}`);
}

export async function deleteFlatRate(shopId: string, id: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  if (!id) throw new Error("id is required");
  const { error } = await getSupabase()
    .from("ship_flat_rate")
    .delete()
    .eq("shop_id", shopId)
    .eq("id", id);
  if (error) throw new Error(`ship_flat_rate delete failed: ${error.message}`);
}

/** The band that prices a parcel within one label group: the tightest cap that still
 *  fits, else the uncapped row, else the largest cap (conservative — never cheaper
 *  because the parcel outgrew every band). */
export function pickBand(rows: FlatRateRow[], weightOz: number): FlatRateRow | null {
  const fitting = rows
    .filter((r) => r.maxWeightOz != null && weightOz <= (r.maxWeightOz as number))
    .sort((a, b) => (a.maxWeightOz as number) - (b.maxWeightOz as number));
  if (fitting.length > 0) return fitting[0];
  const uncapped = rows.find((r) => r.maxWeightOz == null);
  if (uncapped) return uncapped;
  const capped = rows
    .filter((r) => r.maxWeightOz != null)
    .sort((a, b) => (b.maxWeightOz as number) - (a.maxWeightOz as number));
  return capped[0] ?? null;
}

/** Pure options builder, exported for tests and the dashboard rate-card preview. */
export function buildFlatRateOptions(rows: FlatRateRow[], req: RateRequest): NormalizedRateOption[] {
  const weightOz = req.parcels?.[0]?.weightOz ?? 0;
  const domestic =
    (req.destination.country || "US").toUpperCase() === (req.origin.country || "US").toUpperCase();
  const zoneRows = rows.filter(
    (r) => r.zone === "all" || r.zone === (domestic ? "domestic" : "international"),
  );

  const byLabel = new Map<string, FlatRateRow[]>();
  for (const r of zoneRows) {
    const group = byLabel.get(r.label);
    if (group) group.push(r);
    else byLabel.set(r.label, [r]);
  }

  const options: NormalizedRateOption[] = [];
  for (const [label, group] of byLabel) {
    const band = pickBand(group, weightOz);
    if (!band) continue;
    options.push({
      carrier: "Standard",
      serviceCode: label,
      serviceName: label,
      amountCents: band.amountCents,
      // Informational only — the charged amount is priced in the cart currency by
      // quoteCart; mirrors the built-in fallback bands' labeling.
      currency: "USD",
      estTransitDays: band.estTransitDays,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    });
  }
  return options.sort((a, b) => a.amountCents - b.amountCents);
}

/**
 * A RateQuoteSource over the merchant's flat table. fallbackUsed stays FALSE: these
 * are the shop's authoritative configured rates, not a degraded mode. When no row
 * matches the zone, options come back empty and the ENGINE degrades to the built-in
 * bands (flagged fallbackUsed there) — a sale is never blocked. The source id folds
 * in the row COUNT and the newest updated_at so both edits (bump updated_at) and
 * deletes (drop count) bust the engine's per-source quote cache.
 */
export function buildMerchantFlatRateSource(shopId: string, rows: FlatRateRow[]): RateQuoteSource {
  const newest = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), "");
  const version = `${rows.length}:${newest}`;
  return {
    id: `merchant-flat:${shopId}:${version}`,
    getRates(req: RateRequest): Promise<RateQuoteResult> {
      const start = Date.now();
      const options = buildFlatRateOptions(rows, req);
      return Promise.resolve({
        options,
        fallbackUsed: false,
        latencyMs: Date.now() - start,
        provider: "merchant",
      });
    },
  };
}
