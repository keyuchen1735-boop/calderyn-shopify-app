// app/lib/storegen/imagery/detector.ts
// Deterministic weak-listing detector (rule 5 — not the model's job). Flags products whose
// imagery likely hurts conversion (no image, single image). Ranked worst-first; the merchant
// picks which to enhance (never a blind full-catalog pass).
import type { StoreProduct } from "~/lib/storefront/catalog";

export interface ImprovableListing { productId: string; handle: string; title: string; reason: string; severity: number }

export function findImprovableListings(products: StoreProduct[]): ImprovableListing[] {
  const flagged: ImprovableListing[] = [];
  for (const p of products) {
    const n = p.images.length;
    if (n === 0) flagged.push({ productId: p.id, handle: p.handle, title: p.title, reason: "No image", severity: 2 });
    else if (n === 1) flagged.push({ productId: p.id, handle: p.handle, title: p.title, reason: "Single image, no lifestyle/secondary shot", severity: 1 });
  }
  return flagged.sort((a, b) => b.severity - a.severity);
}
