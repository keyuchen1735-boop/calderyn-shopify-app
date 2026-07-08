// app/lib/storegen/seed.ts
// Seed-plan contract for empty-catalog generation: the model invents a small demo catalog
// (design §3.1). Pure module (parse + fallback only); the Supabase writes live in
// seed.server.ts. Mirrors block-plan.ts: tolerant of fences, strict on shape, null on junk.

export const ICON_HINTS = [
  "coffee", "shirt", "gem", "lamp", "dumbbell", "backpack", "watch", "headphones",
  "book", "candle", "chair", "plant", "beauty", "kitchen", "shoes", "outdoor", "pet", "package",
] as const;
export type IconHint = (typeof ICON_HINTS)[number];
export type PhTone = "warm" | "cool" | "neutral";

export interface SeedProduct {
  title: string;
  description: string;
  priceCents: number;
  collection: string; // must match a plan collection title
  iconHint: IconHint;
  phTone: PhTone;
}
export interface SeedPlan {
  collections: { title: string }[];
  products: SeedProduct[];
}

const PRICE_MIN = 500;
const PRICE_MAX = 50000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

function parseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { return null; }
}
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseSeedPlan(raw: string): SeedPlan | null {
  const parsed = asRecord(parseJson(raw));
  if (!Array.isArray(parsed.collections) || !Array.isArray(parsed.products)) return null;

  // Dedupe titles before the slice: the array feeds the collection writer directly, so a
  // duplicated title must collapse here, not just in the lookup set.
  const titles = new Set<string>();
  const collections: { title: string }[] = [];
  for (const entry of parsed.collections) {
    const c = asRecord(entry);
    if (typeof c.title !== "string" || !c.title.trim()) continue;
    const title = clip(c.title.trim(), 60);
    if (titles.has(title)) continue;
    titles.add(title);
    collections.push({ title });
    if (collections.length === 3) break;
  }

  const products: SeedProduct[] = [];
  for (const entry of parsed.products.slice(0, 9)) {
    const q = asRecord(entry);
    if (typeof q.title !== "string" || !q.title.trim()) continue;
    if (typeof q.collection !== "string") continue;
    const collection = clip(q.collection.trim(), 60);
    if (!titles.has(collection)) continue;
    products.push({
      title: clip(q.title.trim(), 80),
      description: clip(typeof q.description === "string" ? q.description.trim() : "", 300),
      priceCents: clamp(typeof q.priceCents === "number" && Number.isFinite(q.priceCents) ? q.priceCents : 2900, PRICE_MIN, PRICE_MAX),
      collection,
      iconHint: (ICON_HINTS as readonly string[]).includes(q.iconHint as string) ? (q.iconHint as IconHint) : "package",
      phTone: q.phTone === "warm" || q.phTone === "cool" ? q.phTone : "neutral",
    });
  }
  if (collections.length === 0 || products.length === 0) return null;
  return { collections, products };
}

// Deterministic seed when the model errors or returns junk (design §3.1): a generic-but-tasteful
// starter catalog, so the run still produces a full working store. Degradation is surfaced via
// the run's proposals/audit, never hidden (rule 12).
export const FALLBACK_SEED: SeedPlan = {
  collections: [{ title: "Featured" }, { title: "Essentials" }],
  products: [
    { title: "Signature Ceramic Mug", description: "A hand-glazed 12oz mug with a matte finish and a comfortable weighted base.", priceCents: 2800, collection: "Featured", iconHint: "coffee", phTone: "warm" },
    { title: "Everyday Canvas Tote", description: "Heavyweight canvas, interior pocket, straps rated for a full grocery run.", priceCents: 3900, collection: "Essentials", iconHint: "backpack", phTone: "neutral" },
    { title: "Soy Wax Candle No. 04", description: "Cedar and amber, 40-hour burn, poured in small batches.", priceCents: 3400, collection: "Featured", iconHint: "candle", phTone: "warm" },
    { title: "Linen Crew Tee", description: "Garment-dyed linen-cotton blend that gets softer with every wash.", priceCents: 4500, collection: "Essentials", iconHint: "shirt", phTone: "cool" },
    { title: "Desk Lamp Mini", description: "A compact brass task lamp with a warm dimmable bulb.", priceCents: 8900, collection: "Featured", iconHint: "lamp", phTone: "warm" },
    { title: "Field Notebook Set", description: "Three pocket notebooks with dot grids and a stitched spine.", priceCents: 1800, collection: "Essentials", iconHint: "book", phTone: "neutral" },
  ],
};
