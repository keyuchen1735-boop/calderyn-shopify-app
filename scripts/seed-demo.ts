// scripts/seed-demo.ts
//
// Reseed a shop's demo data with the deterministic Peak & Pine dataset
// (app/lib/seed). Wipes the shop's existing facts/alerts/audits first.
//
//   set -a && source .env.local && set +a && \
//     node_modules/.bin/vite-node --config vitest.config.ts scripts/seed-demo.ts [shop-domain]
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { getSupabase } from "../app/lib/supabase.server";
import { generateSeedDataset } from "../app/lib/seed/dataset";
import { writeSeedDataset } from "../app/lib/seed/writer";

const shopDomain = process.argv[2] ?? "calderyn-shop-tester.myshopify.com";
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

const today = new Date().toISOString().slice(0, 10);
console.log(`Seeding ${shop.shop_domain} (${shop.id}) anchored at ${today}…`);

const ds = generateSeedDataset({ shopId: String(shop.id), today });
const summary = await writeSeedDataset(ds, String(shop.id), sb);

console.log(`Wiped ${summary.wiped.length} tables.`);
for (const [table, count] of Object.entries(summary.inserted)) {
  console.log(`  ${table.padEnd(22)} ${count} rows`);
}
console.log("Scenario SKUs:", JSON.stringify(ds.scenario, null, 2));
console.log("Done.");
