// app/lib/sourcing/discover.server.ts
import { getSupabase } from "~/lib/supabase.server";
import { createProduct } from "~/lib/catalog/catalog.server";
import { generateStore } from "~/lib/storegen/generate.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import type { ProductInput } from "~/lib/catalog/types";
import { suggestedRetailCents } from "./ingest.server";
import type { DiscoverFeedItem, NormalizedSourceProduct, PickResult } from "./types";

/** Pure: map a viral source product to the owned-catalog ProductInput. */
export function buildProductInput(src: NormalizedSourceProduct): ProductInput {
  const retail = suggestedRetailCents(src.unitCostCents);
  return {
    title: src.title,
    status: "active",
    vendor: src.supplier.name,
    category: src.category ?? undefined,
    description: undefined,
    tags: [],
    variants: [
      {
        title: "Default",
        retailPriceCents: retail,
        unitCostCents: src.unitCostCents,
        inventoryTracked: false,
        requiresShipping: true,
        weightGrams: 0,
      },
    ],
  };
}

interface FeedRow {
  score: number | string;
  source_product: {
    id: string;
    title: string;
    category: string | null;
    image_urls: string[] | null;
    unit_cost_cents: number;
    lead_time_days: number;
    supplier: { name: string; reliability_score: number | null } | null;
  } | null;
}

/** Global read: ranked feed (source_product join latest score + supplier). */
export async function listDiscoverFeed(limit = 40): Promise<DiscoverFeedItem[]> {
  const { data, error } = await getSupabase()
    .from("source_product_score")
    .select(
      "score, source_product:source_product_id(id, title, category, image_urls, unit_cost_cents, lead_time_days, supplier:supplier_id(name, reliability_score))",
    )
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return ((data ?? []) as unknown as FeedRow[]).flatMap((row) => {
    const p = row.source_product;
    if (!p) return [];
    const retail = suggestedRetailCents(p.unit_cost_cents);
    const item: DiscoverFeedItem = {
      sourceProductId: String(p.id),
      title: String(p.title),
      category: p.category ?? null,
      imageUrl: (p.image_urls ?? [])[0] ?? null,
      unitCostCents: Number(p.unit_cost_cents),
      suggestedRetailCents: retail,
      marginPct: retail > 0 ? (retail - p.unit_cost_cents) / retail : 0,
      leadTimeDays: Number(p.lead_time_days),
      supplierName: p.supplier?.name ?? "Unknown",
      supplierReliability: p.supplier?.reliability_score ?? null,
      score: Number(row.score),
    };
    return [item];
  });
}

/** Pick: write owned product + media + link, then generate a draft store. The auto-build goes
 *  through the same generate guard as every other entry point (mid-test refusal, burst limit,
 *  daily designer quota) — a refusal skips the rebuild but never fails the pick itself. */
export async function pickProduct(
  shopId: string,
  sourceProductId: string,
  opts: { trusted: boolean } = { trusted: false },
): Promise<PickResult> {
  const sb = getSupabase();
  const { data: src, error } = await sb
    .from("source_product")
    .select(
      "id, title, category, image_urls, unit_cost_cents, moq, lead_time_days, provider, external_id, supplier_id, supplier:supplier_id(provider, external_supplier_id, name, reliability_score)",
    )
    .eq("id", sourceProductId)
    .maybeSingle();
  if (error) throw error;
  if (!src) throw new Error(`source product ${sourceProductId} not found`);

  // Supabase infers a to-one embed loosely (sometimes as an array); normalize it.
  const supRaw = (src as unknown as { supplier: unknown }).supplier;
  const sup = (Array.isArray(supRaw) ? supRaw[0] : supRaw) as {
    provider?: string;
    external_supplier_id?: string;
    name?: string;
    reliability_score?: number | null;
  } | null;
  const normalized: NormalizedSourceProduct = {
    provider: src.provider,
    externalId: src.external_id,
    title: src.title,
    category: src.category,
    imageUrls: src.image_urls ?? [],
    unitCostCents: src.unit_cost_cents,
    moq: src.moq,
    leadTimeDays: src.lead_time_days,
    supplier: {
      provider: sup?.provider ?? src.provider,
      externalSupplierId: sup?.external_supplier_id ?? "",
      name: sup?.name ?? "Supplier",
      reliabilityScore: sup?.reliability_score ?? null,
    },
    signals: [],
  };

  // 1. Owned catalog product (reuses the validated write-path).
  const { id: productId } = await createProduct(shopId, buildProductInput(normalized));

  // 2. Media — createProduct does NOT write media; hotlink supplier images
  //    via product_media.external_url (the storefront reads these).
  if (normalized.imageUrls.length) {
    const { error: mErr } = await sb.from("product_media").insert(
      normalized.imageUrls.map((url, i) => ({
        product_id: productId,
        external_url: url,
        position: i,
        is_primary: i === 0,
      })),
    );
    if (mErr) throw mErr;
  }

  // 3. Shop-scoped link back to the global source + supplier.
  const { error: lErr } = await sb.from("sourced_product_link").insert({
    shop_id: shopId,
    product_id: productId,
    source_product_id: sourceProductId,
    supplier_id: src.supplier_id,
  });
  if (lErr) throw lErr;

  // 4. Auto-build a draft store from the now-non-empty catalog — unless the shared generate
  // guard refuses (running experiment would have both its arms rewritten mid-flight; quota and
  // burst limits must not be dodgeable through Discover). The product is already picked either
  // way; only the rebuild is skipped, with the reason surfaced to the caller.
  try {
    await assertCanGenerate(shopId, undefined, { trusted: opts.trusted });
  } catch (err) {
    if (err instanceof CalderynError) {
      return { productId, storeRunId: null, storeBuildSkipped: err.code };
    }
    throw err;
  }
  const gen = await generateStore({ shopId, mode: "catalog" });
  return { productId, storeRunId: gen.runId };
}
