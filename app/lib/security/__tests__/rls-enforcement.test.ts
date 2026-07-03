// Real-Postgres proof that the Step 10 policies FILTER for the non-bypass
// app_web role: in shop-A context, app_web sees shop-A's rows and ZERO of
// shop-B's, and with no context it sees nothing (fail-closed). This exercises
// the actual RLS path, so it runs only when TEST_DATABASE_URL points at a
// database that has the RLS migrations applied AND the app_web role present;
// otherwise the block is skipped, so the default `npx vitest run` stays green
// with no `pg` dependency required (mirrors reserve-concurrency.test.ts).
//
// To run: `npm i -D pg` then
//   TEST_DATABASE_URL=postgres://postgres:...@host:port/db npx vitest run \
//     app/lib/security/__tests__/rls-enforcement.test.ts
//
// The proof seeds two shops inside a transaction that is always ROLLED BACK, so
// it never leaves residue in a shared database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

interface PgClient {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
type PgModule = { Client: new (config: { connectionString: string }) => PgClient };

const URL = process.env.TEST_DATABASE_URL;

// Probe prerequisites at load time (top-level await): pg installed, app_web role
// present, and RLS enabled on product_dim. If any is missing, skip rather than
// fail — this proof is only meaningful against an RLS-migrated database.
let ready = false;
let Client: PgModule["Client"] | undefined;
if (URL) {
  try {
    ({ Client } = (await import("pg" as string)) as unknown as PgModule);
    const probe = new Client({ connectionString: URL });
    await probe.connect();
    const role = await probe.query("select 1 from pg_roles where rolname = 'app_web'");
    const rls = await probe.query(
      "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' where c.relname='product_dim'",
    );
    ready = role.rows.length > 0 && rls.rows[0]?.relrowsecurity === true;
    await probe.end();
  } catch {
    ready = false;
  }
}

const maybe = ready ? describe : describe.skip;

maybe("RLS enforcement: app_web cannot read another tenant", () => {
  const shopA = "0a000000-0000-0000-0000-0000000000aa";
  const shopB = "0b000000-0000-0000-0000-0000000000bb";
  let client: PgClient;

  beforeAll(async () => {
    client = new Client!({ connectionString: URL as string });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("shop-A context reads only shop-A rows, zero shop-B, and fails closed with no context", async () => {
    await client.query("begin");
    try {
      // Seed two shops + a product each as owner (bypasses RLS), inside the tx.
      await client.query(
        "insert into public.shops(id, shop_domain) values ($1,'rls-a.myshopify.com'),($2,'rls-b.myshopify.com') on conflict do nothing",
        [shopA, shopB],
      );
      await client.query(
        "insert into public.product_dim(shop_id, handle, title) values ($1,'rls-a','A'),($2,'rls-b','B')",
        [shopA, shopB],
      );

      // Enter the non-bypass lane, scoped to shop A.
      await client.query("set local role app_web");
      await client.query("select set_config('app.shop_id', $1, true)", [shopA]);

      const seenA = await client.query("select count(*)::int n from public.product_dim where shop_id = $1", [shopA]);
      const seenB = await client.query("select count(*)::int n from public.product_dim where shop_id = $1", [shopB]);
      const nonA = await client.query("select count(*)::int n from public.product_dim where shop_id <> $1", [shopA]);

      expect(Number(seenA.rows[0].n)).toBeGreaterThan(0); // positive control (not vacuous)
      expect(Number(seenB.rows[0].n)).toBe(0); // the security-critical invariant
      expect(Number(nonA.rows[0].n)).toBe(0); // no other tenant leaks through

      // Fail-closed: clearing app.shop_id makes current_shop_id() null → 0 rows.
      await client.query("select set_config('app.shop_id', '', true)");
      const closed = await client.query("select count(*)::int n from public.product_dim");
      expect(Number(closed.rows[0].n)).toBe(0);

      await client.query("reset role");
    } finally {
      await client.query("rollback");
    }
  });
});
