// Concurrency proof for the atomic reserve: two simultaneous reserves for the
// last unit -> exactly one wins, the other gets insufficient_stock, and reserved
// settles at 1 (never oversold). This exercises the real Postgres FOR UPDATE
// path, so it only runs when TEST_DATABASE_URL points at a database that has the
// inventory tables + functions applied. Without it the block is skipped, so the
// default `npx vitest run` stays green with no `pg` dependency required.
//
// To run: `npm i -D pg` then
//   TEST_DATABASE_URL=postgres://user:pass@host:port/db npx vitest run app/lib/inventory/__tests__/reserve-concurrency.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Minimal surface of `pg.Client` used here — imported dynamically so the file
// loads (and the suite passes) even when `pg` is not installed.
interface PgClient {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
type PgModule = { Client: new (config: { connectionString: string }) => PgClient };

const URL = process.env.TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe("inventory_reserve concurrency", () => {
  let a: PgClient, b: PgClient, setup: PgClient;
  const shop = "00000000-0000-0000-0000-0000000000aa";
  const variant = "00000000-0000-0000-0000-0000000000b1";
  const loc = "00000000-0000-0000-0000-0000000000c1";

  beforeAll(async () => {
    const { Client } = (await import("pg" as string)) as unknown as PgModule;
    setup = new Client({ connectionString: URL as string }); await setup.connect();
    await setup.query("insert into shops(id, shop_domain) values ($1,'demo') on conflict do nothing", [shop]);
    await setup.query("insert into location_dim(id, shop_id, external_id, name, active) values ($1,$2,'L','Main',true) on conflict do nothing", [loc, shop]);
    await setup.query("insert into variant_dim(id, shop_id, product_id, title) values ($1,$2,$2,'V') on conflict do nothing", [variant, shop]).catch(() => {});
    await setup.query("insert into inventory_balance(shop_id, variant_id, location_id, on_hand) values ($1,$2,$3,1) on conflict (variant_id,location_id) do update set on_hand=1, reserved=0", [shop, variant, loc]);
    a = new Client({ connectionString: URL as string }); await a.connect();
    b = new Client({ connectionString: URL as string }); await b.connect();
  });
  afterAll(async () => { await Promise.all([a?.end(), b?.end(), setup?.end()]); });

  it("lets exactly one of two simultaneous reserves win the last unit", async () => {
    const call = (client: PgClient, ref: string) =>
      client.query("select public.inventory_reserve($1,$2,1,$3,$4, now()+interval '30 min', $5, false) as r",
        [shop, variant, [loc], ref, ref]).then((r) => ({ ok: true as const, r: r.rows[0].r })).catch((e: { message?: string }) => ({ ok: false as const, e: String(e.message) }));
    const [r1, r2] = await Promise.all([call(a, "ca"), call(b, "cb")]);
    const wins = [r1, r2].filter((x) => x.ok).length;
    const losses = [r1, r2].filter((x) => !x.ok && /insufficient_stock/.test((x as { e: string }).e)).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    const bal = await setup.query("select reserved from inventory_balance where variant_id=$1 and location_id=$2", [variant, loc]);
    expect(Number(bal.rows[0].reserved)).toBe(1);
  });
});
