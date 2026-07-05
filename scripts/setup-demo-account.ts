// scripts/setup-demo-account.ts
//
// One-time (idempotent) provisioning of the shared demo showcase account:
// a verified login, the "Peak & Pine Outfitters" demo shop (org_slug
// peakandpine, demo_mode on, org_mode live), the owner membership, and a
// full showcase reset so every surface is populated.
//
//   set -a && source .env.local && set +a && \
//     node_modules/.bin/vite-node --config vitest.config.ts scripts/setup-demo-account.ts
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PASSWORD_PEPPER
// (must equal prod's so the login verifies there), DEMO_ACCOUNT_EMAIL,
// DEMO_ACCOUNT_PASSWORD. Re-running rotates the password to the env value
// and re-seeds the shop.

import { getSupabase } from "../app/lib/supabase.server";
import { hashPassword } from "../app/lib/auth/password.server";
import { findUserByEmail, createUser, normalizeEmail } from "../app/lib/auth/users.server";
import { provisionOwnedShop, linkMembership } from "../app/lib/auth/tenant.server";
import { registerTenantDomain } from "../app/lib/storefront/vercel-domain.server";
import { markEmailVerified } from "../app/lib/auth/verify.server";
import { resetDemoShowcase, type ShowcaseResetClient } from "../app/lib/demo/reset.server";

const ORG_SLUG = "peakandpine";
const DISPLAY_NAME = "Peak & Pine Outfitters";

const email = process.env.DEMO_ACCOUNT_EMAIL;
const password = process.env.DEMO_ACCOUNT_PASSWORD;
if (!email || !password) {
  console.error("Set DEMO_ACCOUNT_EMAIL and DEMO_ACCOUNT_PASSWORD (in .env.local) first.");
  process.exit(1);
}

const sb = getSupabase();

// 1) User: create verified, or rotate the password to the env value.
let userId: string;
const existing = await findUserByEmail(email);
if (existing) {
  userId = existing.id;
  const { error } = await sb
    .from("users")
    .update({ password_hash: hashPassword(password), email_verified: true })
    .eq("id", userId);
  if (error) throw new Error(`password rotate failed: ${error.message}`);
  console.log(`user ${normalizeEmail(email)} exists (${userId}) — password rotated`);
} else {
  const created = await createUser(email, password);
  userId = created.id;
  await markEmailVerified(userId);
  console.log(`user ${normalizeEmail(email)} created (${userId}), pre-verified`);
}

// 2) Shop: find by the canonical demo slug, or provision + claim the slug.
let shopId: string;
const { data: shopRow, error: shopErr } = await sb
  .from("shops")
  .select("id, demo_mode")
  .eq("org_slug", ORG_SLUG)
  .maybeSingle();
if (shopErr) throw new Error(`shops read failed: ${shopErr.message}`);
if (shopRow) {
  // Safety: never convert an existing non-demo shop. If a real tenant somehow
  // holds the slug, flipping demo_mode here would arm the reset wipe against
  // live merchant data — abort and let a human sort out the slug instead.
  if (shopRow.demo_mode !== true) {
    console.error(
      `shop with org_slug '${ORG_SLUG}' exists (${String(shopRow.id)}) but demo_mode is not true — refusing to convert it. Free the slug or set demo_mode manually if this really is the demo shop.`,
    );
    process.exit(1);
  }
  shopId = String(shopRow.id);
  console.log(`shop ${ORG_SLUG} exists (${shopId})`);
} else {
  const provisioned = await provisionOwnedShop(DISPLAY_NAME);
  shopId = provisioned.shopId;
  const { error } = await sb.from("shops").update({ org_slug: ORG_SLUG }).eq("id", shopId);
  if (error) throw new Error(`org_slug claim failed: ${error.message}`);
  console.log(`shop provisioned (${shopId}), org_slug → ${ORG_SLUG}`);
}

// The provisioning hook registers the throwaway random slug's domain; the demo
// shop's real host is the fixed slug, so ensure THAT one is registered
// (idempotent; skipped with a warning when VERCEL_TOKEN is unset).
await registerTenantDomain(ORG_SLUG);

// 3) Demo flags BEFORE the reset — resetDemoShowcase refuses non-demo shops.
const { error: flagErr } = await sb
  .from("shops")
  .update({
    demo_mode: true,
    org_mode: "live",
    display_name: DISPLAY_NAME,
    onboarding_step: "complete",
    onboarding_completed_at: new Date().toISOString(),
  })
  .eq("id", shopId);
if (flagErr) throw new Error(`demo flags failed: ${flagErr.message}`);

// 4) Membership (idempotent — linkMembership rethrows the raw PostgrestError,
// so the unique-violation is detectable by its structured code, not message).
try {
  await linkMembership(userId, shopId, "owner");
  console.log("membership linked (owner)");
} catch (err) {
  if ((err as { code?: string }).code !== "23505") throw err;
  console.log("membership already linked");
}

// 5) Full showcase reset (wipe + facts + promote + owned layer).
console.log("seeding showcase…");
// Cast justified in ShowcaseResetClient's doc: supabase-js's generics exceed
// TS's structural-check depth; the runtime builder shape matches.
const summary = await resetDemoShowcase(shopId, sb as unknown as ShowcaseResetClient);
console.log(`wiped ${summary.wiped.length} extra tables; promote:`, summary.promoted);
for (const [table, count] of Object.entries(summary.inserted)) {
  console.log(`  ${table.padEnd(24)} ${count} rows`);
}

console.log("\nDone.");
console.log(`  login:      https://app.calderyncompany.com/login  (${normalizeEmail(email)})`);
console.log(`  dashboard:  https://app.calderyncompany.com/dashboard`);
console.log(`  storefront: https://${ORG_SLUG}.calderyncompany.com`);
