// app/lib/storegen/seed.server.ts
// Writes a SeedPlan through the normal catalog write path (design §3.1) — no parallel write
// machinery, so seeded products behave exactly like merchant-created ones (PDP, cart, editor).
// ponytail: sample-ness is a reserved tag on the existing tags array, not an is_sample column;
// migrate to a column if sample semantics ever outgrow tag filtering.
import { createCollection, createProduct, setProductStatus } from "~/lib/catalog/catalog.server";
import { getSupabase } from "~/lib/supabase.server";
import type { SeedPlan } from "./seed";

export const SAMPLE_TAG = "calderyn:sample";

export interface SeedOutcome { collections: number; products: number; failed: number }

export async function seedSampleCatalog(shopId: string, plan: SeedPlan): Promise<SeedOutcome> {
  const collectionIds = new Map<string, string>();
  for (const c of plan.collections) {
    const { id } = await createCollection(shopId, c.title);
    collectionIds.set(c.title, id);
  }
  let products = 0;
  let failed = 0;
  for (const p of plan.products) {
    try {
      const cid = collectionIds.get(p.collection);
      await createProduct(shopId, {
        title: p.title,
        status: "active",
        description: p.description,
        tags: [SAMPLE_TAG, `cd-icon:${p.iconHint}`, `cd-tone:${p.phTone}`],
        variants: [{ retailPriceCents: p.priceCents, inventoryTracked: false }],
        collectionIds: cid ? [cid] : [],
      });
      products += 1;
    } catch (err) {
      // rule 12: every skipped/failed write is surfaced via the returned count, never swallowed.
      failed += 1;
      console.error(`[storegen] seed product "${p.title}" failed`, err);
    }
  }
  return { collections: collectionIds.size, products, failed };
}

// The sample tag rides on product_dim.tags (a text[] column). Neither the storefront nor the
// catalog listProducts DTO surfaces tags, so sample-ness is read straight off the table here —
// one query reused by the studio read model (sampleCount) and by clearSampleProducts.
export async function activeSampleProductIds(shopId: string): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("product_dim").select("id").eq("shop_id", shopId).eq("status", "active").contains("tags", [SAMPLE_TAG]);
  if (error) throw error;
  return (data ?? []).map((r) => String(r.id));
}

// One-click "clear samples": archive every active sample product. The canonical delete path is
// archival (setProductStatus "archived") — reversible, drops them from the active storefront and
// the studio preview, and avoids the FK-cascade risk a hard delete would carry. Returns the count
// archived (rule 12: the tag-query error propagates, so a failure never reports success).
export async function clearSampleProducts(shopId: string): Promise<number> {
  const ids = await activeSampleProductIds(shopId);
  for (const id of ids) await setProductStatus(shopId, id, "archived");
  return ids.length;
}
