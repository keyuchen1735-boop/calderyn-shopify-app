// app/lib/sourcing/ingest.server.ts
import { getSupabase } from "~/lib/supabase.server";
import { getSupplierAdapter } from "./supplier-adapter";
import { scoreVirality, resolveScoringPhase, type ScoringPhase } from "./score";
import type { NormalizedSourceProduct } from "./types";

const MARKUP = Number(process.env.SOURCING_MARKUP || "2.5");
const TRENDING_LIMIT = Number(process.env.SOURCING_TRENDING_LIMIT || "60");

/** Deterministic suggested retail from supplier cost (rule 5). */
export function suggestedRetailCents(unitCostCents: number): number {
  return Math.round(unitCostCents * MARKUP);
}

function sig(p: NormalizedSourceProduct, kind: string): number {
  return p.signals.find((s) => s.kind === kind)?.value ?? 0;
}

export interface ScoredRow {
  product: NormalizedSourceProduct;
  firstSeenDaysAgo: number;
  score: ReturnType<typeof scoreVirality> & { phase: ScoringPhase };
}

/** Pure: turn normalized products into scored rows ready to upsert. */
export function toUpsertRows(
  products: NormalizedSourceProduct[],
  phase: ScoringPhase,
  firstSeenDaysAgo: number,
): ScoredRow[] {
  return products.map((product) => {
    const result = scoreVirality({
      orderVolume30d: sig(product, "order_volume_30d"),
      orderVolume7d: sig(product, "order_volume_7d"),
      trendIndex: sig(product, "trend_index"),
      firstSeenDaysAgo,
      unitCostCents: product.unitCostCents,
      suggestedRetailCents: suggestedRetailCents(product.unitCostCents),
      leadTimeDays: product.leadTimeDays,
    });
    return { product, firstSeenDaysAgo, score: { ...result, phase } };
  });
}

/** Count platform users for the phase gate. Tolerant: if the users table isn't
 *  wired yet, default to 0 -> the conservative "external" phase (never crash ingest). */
async function userCount(): Promise<number> {
  const { count, error } = await getSupabase()
    .from("users")
    .select("id", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

/** I/O: pull trending -> upsert supplier/source_product/signals -> upsert score -> audit. */
export async function runSourcingIngest(
  providerName?: string,
): Promise<{ fetched: number; scored: number }> {
  const sb = getSupabase();
  const adapter = getSupplierAdapter(providerName);
  const phase = resolveScoringPhase(await userCount());
  const { data: run } = await sb
    .from("sourcing_run")
    .insert({ provider: adapter.provider, phase })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  try {
    const products = await adapter.getTrending(TRENDING_LIMIT);
    let scored = 0;
    for (const row of toUpsertRows(products, phase, 0)) {
      const p = row.product;
      const { data: sup } = await sb
        .from("supplier")
        .upsert(
          {
            provider: p.supplier.provider,
            external_supplier_id: p.supplier.externalSupplierId,
            name: p.supplier.name,
            reliability_score: p.supplier.reliabilityScore,
          },
          { onConflict: "provider,external_supplier_id" },
        )
        .select("id")
        .single();

      const { data: sp } = await sb
        .from("source_product")
        .upsert(
          {
            provider: p.provider,
            external_id: p.externalId,
            title: p.title,
            category: p.category,
            image_urls: p.imageUrls,
            unit_cost_cents: p.unitCostCents,
            moq: p.moq,
            lead_time_days: p.leadTimeDays,
            supplier_id: sup?.id,
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: "provider,external_id" },
        )
        .select("id")
        .single();
      if (!sp?.id) continue;

      await sb
        .from("source_product_signal")
        .insert(p.signals.map((s) => ({ source_product_id: sp.id, kind: s.kind, value: s.value })));
      await sb
        .from("source_product_score")
        .upsert(
          { source_product_id: sp.id, score: row.score.score, phase, decay: row.score.decay },
          { onConflict: "source_product_id" },
        );
      scored += 1;
    }
    if (runId)
      await sb
        .from("sourcing_run")
        .update({ fetched: products.length, scored, finished_at: new Date().toISOString() })
        .eq("id", runId);
    return { fetched: products.length, scored };
  } catch (err) {
    // Fail visibly (rule 12): record the error on the run row, then rethrow.
    if (runId)
      await sb
        .from("sourcing_run")
        .update({ error: String(err), finished_at: new Date().toISOString() })
        .eq("id", runId);
    throw err;
  }
}
