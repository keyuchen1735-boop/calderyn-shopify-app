// scripts/seed-screener.ts
//
// Seed the Ad Pre-Screen feature with demo-ready, already-scored runs
// (creative_screen_run). Idempotent: wipes the shop's existing screen runs,
// then inserts the deterministic demo set. Safe to run repeatedly.
//
// Unlike seed-demo.ts this does NOT touch sku_dim / orders / campaigns — it
// only writes creative_screen_run, so it's safe on a shop with real synced
// Shopify products (e.g. the review store).
//
//   set -a && source .env.local && set +a && \
//     node_modules/.bin/vite-node --config vitest.config.ts scripts/seed-screener.ts [shop-domain]
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { getSupabase } from "../app/lib/supabase.server";
import { buildScreenerRuns, SCREENER_SEED_SKU_TITLES, type SkuRef } from "../app/lib/seed/screener";

const shopDomain = process.argv[2] ?? "calderyn-review-store.myshopify.com";
const sb = getSupabase();

const { data: shop, error: shopErr } = await sb
  .from("shops")
  .select("id, shop_domain")
  .eq("shop_domain", shopDomain)
  .maybeSingle();
if (shopErr) throw shopErr;
if (!shop) {
  console.error(`shop ${shopDomain} not found`);
  process.exit(1);
}
const shopId = String(shop.id);

// Resolve the products the demo runs are grounded in. A missing title degrades
// to an unmapped run (the builder handles null), so this never hard-fails.
const { data: skus, error: skuErr } = await sb
  .from("sku_dim")
  .select("id, title")
  .eq("shop_id", shopId)
  .in("title", SCREENER_SEED_SKU_TITLES as unknown as string[]);
if (skuErr) throw skuErr;

const priceByTitle = new Map<string, number>();
for (const title of SCREENER_SEED_SKU_TITLES) {
  const id = (skus ?? []).find((s) => s.title === title)?.id;
  if (!id) continue;
  // Realized unit price from order history; falls back to null if none on record.
  const { data: ol, error: olErr } = await sb
    .from("order_line_fact")
    .select("price_cents")
    .eq("shop_id", shopId)
    .eq("sku_id", id)
    .gt("price_cents", 0)
    .limit(200);
  if (olErr) throw olErr;
  const rows = (ol ?? []).map((r) => Number(r.price_cents)).filter((n) => n > 0);
  if (rows.length) {
    priceByTitle.set(title, Math.round(rows.reduce((a, b) => a + b, 0) / rows.length));
  }
}

const skuByTitle = new Map<string, SkuRef>();
for (const s of skus ?? []) {
  skuByTitle.set(String(s.title), { id: String(s.id), priceCents: priceByTitle.get(String(s.title)) ?? 0 });
}
// Drop a SKU with no realized price so it doesn't ground an estimate at $0.
for (const [title, ref] of skuByTitle) {
  if (ref.priceCents <= 0) skuByTitle.delete(title);
}

const runs = buildScreenerRuns({ shopId, skuByTitle, nowMs: Date.now() });

console.log(`Seeding ad pre-screen for ${shop.shop_domain} (${shopId})…`);
console.log(`Resolved ${skuByTitle.size}/${SCREENER_SEED_SKU_TITLES.length} demo SKUs with prices.`);

// Wipe-then-insert (same convention as writeSeedDataset). Order matters: the
// table has no unique key, so inserting first would leave duplicate runs behind.
// Any failure throws, so a partial seed surfaces loudly rather than looking
// finished (rule 12); re-running the idempotent script then recovers it.
const { error: delErr } = await sb.from("creative_screen_run").delete().eq("shop_id", shopId);
if (delErr) throw delErr;

const { error: insErr } = await sb.from("creative_screen_run").insert(runs);
if (insErr) throw insErr;

for (const r of runs) {
  console.log(
    `  ${r.scorecard.grade.padEnd(8)} ${String(r.scorecard.composite).padStart(3)}  ` +
      `${r.creative_input.headline.slice(0, 48)}`,
  );
}
console.log(`Inserted ${runs.length} screen runs. Latest = "${runs[0].creative_input.headline}".`);
console.log("Done.");
