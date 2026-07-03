#!/usr/bin/env node
// Enforcement probe for Step 10 tenant isolation. Where scripts/verify-rls.mjs
// proves the anon attack surface is closed (PostgREST), this proves the DORMANT
// policies actually FILTER for the non-bypass `app_web` role: in shop-A context,
// app_web sees exactly shop-A rows and ZERO of shop-B's, and with no context it
// sees nothing (fail-closed). It also asserts the app_web posture landed by
// 20260703160000 (SELECT-only, no secret grants) and the v_* views are
// security_invoker (20260703170000).
//
// Read-only: runs inside a transaction that is ALWAYS rolled back; it never
// writes, so all-shop crons/training are never polluted. Connect as an owner
// role that is a member of app_web (Supabase `postgres`), so SET ROLE works.
//
//   npm i pg
//   RLS_ENFORCE_DATABASE_URL=postgres://postgres:...@host:5432/postgres \
//     node scripts/verify-rls-enforcement.mjs
//
// Exit: 0 all passed · 1 a check failed (isolation leak or posture gap) ·
//       2 not runnable (pg missing / env unset) · 3 insufficient data (need two
//       shops owning product_dim rows) — none of which is a silent pass.

const URL = process.env.RLS_ENFORCE_DATABASE_URL;
if (!URL) {
  console.error("Set RLS_ENFORCE_DATABASE_URL to a Postgres connection string (owner/postgres role).");
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(URL)) {
  console.error("RLS_ENFORCE_DATABASE_URL must be a postgres:// connection string.");
  process.exit(2);
}

let Client;
try {
  ({ Client } = await import("pg"));
} catch {
  console.error("The 'pg' package is required: run `npm i pg` first.");
  process.exit(2);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Direct-shop_id tenant tables + one FK-child (scoped via product_dim ancestor).
const DIRECT_TABLES = ["product_dim", "variant_dim", "inventory_ledger", "order_fact"];

const client = new Client({ connectionString: URL });
await client.connect();
try {
  await client.query("begin");

  // Pick two real shops that own product_dim rows (read as owner; bypasses RLS).
  const shops = await client.query(
    `select shop_id, count(*)::int n from public.product_dim
       group by shop_id having count(*) > 0 order by count(*) desc limit 2`,
  );
  if (shops.rows.length < 2) {
    console.error("Insufficient data: need two shops owning product_dim rows to prove isolation.");
    await client.query("rollback");
    await client.end();
    process.exit(3);
  }
  const shopA = shops.rows[0].shop_id;
  const shopB = shops.rows[1].shop_id;

  // Enter the non-bypass lane for the rest of the transaction.
  await client.query("set local role app_web");
  await client.query("select set_config('app.shop_id', $1, true)", [shopA]);

  // Positive control: app_web in shop-A context must see shop-A's product_dim.
  const posA = await client.query("select count(*)::int n from public.product_dim");
  record("app_web sees shop-A product_dim rows (positive control)", posA.rows[0].n > 0, `${posA.rows[0].n} rows`);

  // The security-critical invariant on each direct table: zero shop-B rows.
  for (const t of DIRECT_TABLES) {
    const seenB = await client.query(`select count(*)::int n from public.${t} where shop_id = $1`, [shopB]);
    const all = await client.query(`select count(*)::int n from public.${t}`);
    const seenBnonA = await client.query(`select count(*)::int n from public.${t} where shop_id <> $1`, [shopA]);
    const ok = seenB.rows[0].n === 0 && seenBnonA.rows[0].n === 0;
    record(`${t}: shop-A context reads zero shop-B / non-A rows`, ok, `visible=${all.rows[0].n} shopB=${seenB.rows[0].n}`);
  }

  // FK-child: product_media is scoped through product_dim. No product visible to
  // shop-A may belong to shop-B.
  const childLeak = await client.query(
    `select count(*)::int n from public.product_media pm
       where exists (select 1 from public.product_dim p
                       where p.id = pm.product_id and p.shop_id = $1)`,
    [shopB],
  );
  record("product_media (FK-child): shop-A context reads zero shop-B rows", childLeak.rows[0].n === 0, `${childLeak.rows[0].n}`);

  // Fail-closed: with app.shop_id cleared, current_shop_id() is null → 0 rows.
  await client.query("select set_config('app.shop_id', '', true)");
  const closed = await client.query("select count(*)::int n from public.product_dim");
  record("no-context read is fail-closed (zero rows)", closed.rows[0].n === 0, `${closed.rows[0].n} rows`);

  await client.query("reset role");

  // Posture (as owner): app_web is SELECT-only, holds no secret-table grant.
  const writes = await client.query(
    `select count(*)::int n from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname='public'
      where c.relkind='r' and has_table_privilege('app_web', c.oid, 'insert,update,delete')`,
  );
  record("app_web holds no write privilege on any table", writes.rows[0].n === 0, `${writes.rows[0].n} writable`);

  const secretSel = await client.query(
    `select count(*)::int n from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname='public'
      where c.relkind='r'
        and c.relname = any($1::text[])
        and has_table_privilege('app_web', c.oid, 'select')`,
    [[
      "integration_credentials","mcp_oauth_codes","mcp_tokens","oauth_state","dashboard_sessions",
      "membership","admin_access_log","app_secret","email_optouts","linkedin_connection",
      "mcp_oauth_clients","mcp_pending_oauth","password_reset_token","pilot_invites","rate_limit_hits",
      "shopify_sessions","shopify_sessions_migrations","social_digest","social_link_post","users",
      "waitlist","waitlist_rate_limit",
    ]],
  );
  record("app_web cannot SELECT any deny-all/secret table", secretSel.rows[0].n === 0, `${secretSel.rows[0].n} readable`);

  // v_* views are security_invoker (except the documented definer allowlist).
  const definerViews = await client.query(
    `select coalesce(string_agg(c.relname, ', ' order by c.relname), '') offenders
       from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname='public'
      where c.relkind='v' and c.relname like 'v\\_%'
        and c.relname <> all (array['v_peer_metric_baselines'])
        and coalesce((select option_value from pg_options_to_table(c.reloptions)
                       where option_name='security_invoker'),'false') not in ('true','on')`,
  );
  record("all v_* views are security_invoker (bar allowlist)", definerViews.rows[0].offenders === "", definerViews.rows[0].offenders || "none");

  await client.query("rollback");
} catch (err) {
  try { await client.query("rollback"); } catch { /* ignore */ }
  console.error(`\nProbe error: ${err?.message ?? err}`);
  await client.end();
  process.exit(1);
}
await client.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
