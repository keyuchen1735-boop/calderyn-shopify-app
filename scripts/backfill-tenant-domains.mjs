// One-time backfill: register <org_slug>.calderyncompany.com on the Vercel
// project for every active first-party shop. Wildcard DNS already points the
// zone at Vercel; registration attaches the host to the project and issues
// its TLS cert. Idempotent — already-registered domains count as success.
// New shops self-register at signup (app/lib/storefront/vercel-domain.server.ts).
//
//   node scripts/backfill-tenant-domains.mjs
//
// Requires env: SUPABASE_URL, SUPABASE_SECRET_KEY, VERCEL_TOKEN
// Optional: VERCEL_PROJECT_ID (default "shopify-app"), VERCEL_TEAM_ID
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SECRET_KEY, VERCEL_TOKEN } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !VERCEL_TOKEN) {
  console.error("Missing SUPABASE_URL, SUPABASE_SECRET_KEY, or VERCEL_TOKEN");
  process.exit(1);
}

const project = process.env.VERCEL_PROJECT_ID || "shopify-app";
const teamQs = process.env.VERCEL_TEAM_ID
  ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
  : "";
const BENIGN = new Set(["domain_already_exists", "domain_already_in_use_by_project"]);

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Page past PostgREST's 1000-row response clamp so no tenant is silently
// skipped once the shop count grows.
const PAGE = 1000;
const shops = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb
    .from("shops")
    .select("id, org_slug")
    .not("org_slug", "is", null)
    .is("uninstalled_at", null)
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) {
    console.error("shops query failed:", error.message);
    process.exit(1);
  }
  shops.push(...data);
  if (data.length < PAGE) break;
}

let added = 0;
let existing = 0;
let failed = 0;
for (const shop of shops) {
  const name = `${shop.org_slug}.calderyncompany.com`;
  const res = await fetch(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/domains${teamQs}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${VERCEL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    },
  );
  if (res.ok) {
    added++;
    console.log(`added   ${name}`);
    continue;
  }
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? "";
  if (BENIGN.has(code)) {
    existing++;
    console.log(`exists  ${name}`);
    continue;
  }
  failed++;
  console.error(`FAILED  ${name} (${res.status} ${code})`);
}
console.log(`done: ${added} added, ${existing} already registered, ${failed} failed.`);
process.exit(failed ? 1 : 0);
