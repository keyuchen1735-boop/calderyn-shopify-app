// One-time backfill: ensure a shops row exists in Supabase for every shop that
// already has a Prisma session. Idempotent. Run once after deploying the
// afterAuth provisioning hook.
//
//   node scripts/backfill-shops.mjs
//
// Requires env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const prisma = new PrismaClient();
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let ok = 0;
let failed = 0;
try {
  const shops = await prisma.session.findMany({
    select: { shop: true },
    distinct: ["shop"],
  });
  console.log(`Found ${shops.length} distinct shop(s) in Prisma sessions.`);
  for (const { shop } of shops) {
    const { error } = await sb
      .from("shops")
      .upsert({ shop_domain: shop }, { onConflict: "shop_domain", ignoreDuplicates: true });
    if (error) {
      failed++;
      console.error(`FAIL ${shop}: ${error.message}`);
    } else {
      ok++;
      console.log(`ok   ${shop}`);
    }
  }
} finally {
  await prisma.$disconnect();
}

console.log(`Done. ${ok} ok, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
