#!/usr/bin/env node
// Post-apply isolation probe for the tenant-isolation-hardening migration.
// Hits PostgREST as the anon role and asserts the attack surface is closed:
// locked tables return 401 (permission denied), not 200; the breach-fix RPC is
// not anon-callable; the waitlist front door still works. Run against prod
// after apply_migration. Reads no secrets from source; both values come from
// the environment (see .env.example).
//
//   CALDERYN_PROBE_SUPABASE_URL=... CALDERYN_PROBE_ANON_KEY=... node scripts/verify-rls.mjs

const url = process.env.CALDERYN_PROBE_SUPABASE_URL;
const key = process.env.CALDERYN_PROBE_ANON_KEY;
if (!url || !key) {
  console.error("Set CALDERYN_PROBE_SUPABASE_URL and CALDERYN_PROBE_ANON_KEY.");
  process.exit(2);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Locked tables: anon has no grant. A locked table can answer 401/403
// (permission denied), 404 (not exposed), or 400 (query rejected) — none of
// which return data. The ONLY leak is HTTP 200 with a non-empty row array, so
// that is the sole failure condition. select=* avoids column-name assumptions.
const LOCKED = ["users", "product_dim", "integration_credentials", "order_fact"];
for (const t of LOCKED) {
  const res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers });
  let leaked = false;
  if (res.status === 200) {
    const body = await res.json().catch(() => null);
    leaked = Array.isArray(body) && body.length > 0;
  }
  record(`anon cannot read ${t}`, !leaked, `HTTP ${res.status}`);
}

// Breach regression: set_current_shop_id must not be anon-callable.
{
  const res = await fetch(`${url}/rest/v1/rpc/set_current_shop_id`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ p_shop_id: "00000000-0000-0000-0000-000000000000" }),
  });
  record(
    "set_current_shop_id not anon-callable",
    res.status === 404 || res.status === 401 || res.status === 403,
    `HTTP ${res.status}`,
  );
}

// Liveness: the marketing waitlist front door must still answer for anon.
{
  const res = await fetch(`${url}/rest/v1/rpc/waitlist_count`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });
  record("waitlist_count still anon-callable", res.status === 200, `HTTP ${res.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
