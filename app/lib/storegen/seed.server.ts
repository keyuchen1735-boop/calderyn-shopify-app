// app/lib/storegen/seed.server.ts
// Writes a SeedPlan through the normal catalog write path (design §3.1) — no parallel write
// machinery, so seeded products behave exactly like merchant-created ones (PDP, cart, editor).
// ponytail: sample-ness is a reserved tag on the existing tags array, not an is_sample column;
// migrate to a column if sample semantics ever outgrow tag filtering.
import { createCollection, createProduct } from "~/lib/catalog/catalog.server";
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
