// app/lib/storebuilder/product-card.ts
// The product-card media slot: a real image when the product has one, else a deterministic
// on-brand placeholder tile (design §3.3) — palette-toned gradient + a glyph that matches the
// product (seeded cd-icon: tag first, then a keyword map, then the package glyph). Same code
// path for sample and real products, so image-less real catalogs improve too.
// Icons: lucide-react directly (storefront surface — the dashboard CDIcon registry is
// dashboard-only chrome; the Lucide-only rule still holds).
import { createElement, type ReactElement } from "react";
import {
  Coffee, Shirt, Gem, Lamp, Dumbbell, Backpack, Watch, Headphones, BookOpen, Flame,
  Armchair, Leaf, Sparkles, Utensils, Footprints, Tent, PawPrint, Package, type LucideIcon,
} from "lucide-react";
import type { StoreProduct } from "~/lib/storefront/catalog";

const ICONS: Record<string, LucideIcon> = {
  coffee: Coffee, shirt: Shirt, gem: Gem, lamp: Lamp, dumbbell: Dumbbell, backpack: Backpack,
  watch: Watch, headphones: Headphones, book: BookOpen, candle: Flame, chair: Armchair,
  plant: Leaf, beauty: Sparkles, kitchen: Utensils, shoes: Footprints, outdoor: Tent,
  pet: PawPrint, package: Package,
};
const KEYWORDS: [RegExp, string][] = [
  [/coffee|mug|espresso|brew|kettle/i, "coffee"],
  [/shirt|tee|hoodie|apparel|jacket|dress|linen/i, "shirt"],
  [/ring|necklace|jewel|earring|pendant/i, "gem"],
  [/lamp|light|sconce|lantern/i, "lamp"],
  [/gym|weight|fitness|yoga|kettlebell/i, "dumbbell"],
  [/bag|pack|tote|duffel/i, "backpack"],
  [/watch|clock|timer/i, "watch"],
  [/headphone|audio|speaker|earbud/i, "headphones"],
  [/book|journal|notebook|planner/i, "book"],
  [/candle|wax|incense/i, "candle"],
  [/sofa|chair|furniture|stool|table/i, "chair"],
  [/plant|garden|botanical|seed/i, "plant"],
  [/serum|skin|cream|balm|soap|beauty/i, "beauty"],
  [/knife|pan|kitchen|utensil|skillet/i, "kitchen"],
  [/shoe|boot|sneaker|sandal/i, "shoes"],
  [/tent|camp|trail|hike|outdoor/i, "outdoor"],
  [/pet|dog|cat|paw/i, "pet"],
];

function taggedValue(p: StoreProduct, prefix: string): string | undefined {
  return p.tags?.find((t) => t.startsWith(prefix))?.slice(prefix.length);
}

export function productIcon(p: StoreProduct): LucideIcon {
  const hinted = taggedValue(p, "cd-icon:");
  if (hinted && ICONS[hinted]) return ICONS[hinted];
  const hay = `${p.title} ${p.description} ${p.category ?? ""}`;
  for (const [re, key] of KEYWORDS) if (re.test(hay)) return ICONS[key];
  return Package;
}

/** Deterministic tile styling from the handle + optional cd-tone tag: two products never look
 *  identical, and re-renders never shuffle (no randomness — the hash is the seed). */
export function phVars(p: StoreProduct): Record<string, string> {
  let h = 0;
  for (const ch of p.handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tone = taggedValue(p, "cd-tone:");
  const baseHue = tone === "warm" ? 20 : tone === "cool" ? 205 : 260;
  return { "--ph-hue": String(baseHue + (h % 40) - 20), "--ph-angle": `${h % 360}deg` };
}

/** The card's media slot: real image, else the placeholder tile. */
export function productCardMedia(p: StoreProduct): ReactElement {
  if (p.images[0]) {
    return createElement("img", { className: "cd-product-card__img", src: p.images[0].url, alt: p.images[0].alt ?? p.title });
  }
  const Icon = productIcon(p);
  return createElement("span", { className: "cd-product-card__ph", style: phVars(p), "aria-hidden": "true" },
    createElement(Icon, { className: "cd-product-card__ph-icon", strokeWidth: 1.5 }));
}
