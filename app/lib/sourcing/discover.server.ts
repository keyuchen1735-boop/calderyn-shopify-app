// app/lib/sourcing/discover.server.ts
import { getSupabase } from "~/lib/supabase.server";
import { createProduct } from "~/lib/catalog/catalog.server";
import { rateLimit } from "~/lib/dashboard/http.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { readStorefrontReleasePointers } from "~/lib/storefront-bundle/build.server";
import { runStoreCommand } from "~/lib/storefront-command/command.server";
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
export async function listDiscoverFeed(limit = 40, search = ""): Promise<DiscoverFeedItem[]> {
  const { data, error } = await getSupabase()
    .from("source_product_score")
    .select(
      "score, source_product:source_product_id(id, title, category, image_urls, unit_cost_cents, lead_time_days, supplier:supplier_id(name, reliability_score))",
    )
    .order("score", { ascending: false })
    .limit(search ? 200 : limit);
  if (error) throw error;

  // Longer tokens make the best keyword matches, but a query made up entirely
  // of short tokens ("tv", "pc", "3d") must still filter — otherwise the guard
  // below is skipped and the merchant gets the global top-scoring feed passed
  // off as matches for what they typed. Fall back to the whole trimmed query as
  // a single term in that case; an empty search still means "no filter".
  const trimmed = search.trim().toLowerCase();
  const longTerms = trimmed.split(/\s+/).filter((term) => term.length > 2);
  const terms = longTerms.length ? longTerms : trimmed ? [trimmed] : [];
  return ((data ?? []) as unknown as FeedRow[]).flatMap((row) => {
    const p = row.source_product;
    if (!p) return [];
    const haystack = `${p.title} ${p.category ?? ""}`.toLowerCase();
    if (terms.length && !terms.some((term) => haystack.includes(term))) return [];
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
  }).slice(0, limit);
}

/** Pick: write owned product + media + link, then route the refreshed catalog
 * through the runtime-1 recipe/original compiler. A refused build never rolls
 * back the product the merchant already picked. */
export async function pickProduct(
  shopId: string,
  sourceProductId: string,
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

  // Routing guard (designer-flagship spec D1's sanctioned exception): this is
  // a server-side runStoreCommand call that bypasses the store-command route,
  // so it applies the same composer_enabled check — a designer-enabled shop
  // must never get a silent classic draft from a product pick. Fail-open on a
  // lookup hiccup, exactly like the route guard, so a settings read blip
  // can't break picking for classic shops.
  try {
    if ((await getStoreSettings(shopId)).composerEnabled) {
      return { productId, storeRunId: null, storeBuildSkipped: "designer_enabled" };
    }
  } catch (err) {
    console.error("[sourcing/discover] designer flag lookup failed", err);
  }

  // 4. Build a runtime-1 draft only for a store that has never been built.
  // A product pick never overwrites a merchant's existing draft.
  if (!(await rateLimit(`storefront-build:${shopId}`, 10, 60_000))) {
    return { productId, storeRunId: null, storeBuildSkipped: "rate_limited" };
  }

  try {
    const pointers = await readStorefrontReleasePointers(shopId);
    if (pointers.draftVersionId || pointers.publishedVersionId) {
      return { productId, storeRunId: null, storeBuildSkipped: "existing_store" };
    }
    const receipt = await runStoreCommand({
      shopId,
      command: { kind: "prompt", prompt: "Build my store", expectedDraftVersionId: null },
    });
    if (receipt.status === "installed") {
      return { productId, storeRunId: receipt.versionId };
    }
    return { productId, storeRunId: null, storeBuildSkipped: receipt.status };
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
      return { productId, storeRunId: null, storeBuildSkipped: err.code };
    }
    return { productId, storeRunId: null, storeBuildSkipped: "storefront_command_unavailable" };
  }
}
