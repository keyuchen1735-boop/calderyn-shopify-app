import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWeatherSuggestions } from "../suggestions.server";

interface Row {
  id: string;
  shop_id: string;
  suggested_on: string;
  status: string;
  narrative: string;
  amount_cents: number;
}

// In-memory stand-in that honors the filters/orders the loader applies, so the
// tests assert observable behavior (which rows come back) rather than query text.
function fakeSb(rows: Row[]): SupabaseClient {
  function builder() {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: keyof Row; ascending: boolean }> = [];
    const chain = {
      select: () => chain,
      eq: (col: keyof Row, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      gte: (col: keyof Row, val: string) => {
        filters.push((r) => String(r[col]) >= val);
        return chain;
      },
      order: (col: keyof Row, opts?: { ascending?: boolean }) => {
        orders.push({ col, ascending: opts?.ascending !== false });
        return chain;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        const out = rows
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => {
            for (const o of orders) {
              const cmp = a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0;
              if (cmp !== 0) return o.ascending ? cmp : -cmp;
            }
            return 0;
          });
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { from: () => builder() } as unknown as SupabaseClient;
}

const row = (over: Partial<Row>): Row => ({
  id: "sg1",
  shop_id: "shop-1",
  suggested_on: "2026-07-06",
  status: "pending",
  narrative: "shift",
  amount_cents: 3000,
  ...over,
});

describe("loadWeatherSuggestions", () => {
  it("still returns a suggestion after UTC midnight on the day it was made", async () => {
    // Cron wrote it on the 6th; a merchant looks at 9pm ET = 01:00 UTC on the 7th.
    const sb = fakeSb([row({})]);
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T01:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "sg1", narrative: "shift", amountCents: 3000 });
  });

  it("drops suggestions older than the 3-day forecast horizon", async () => {
    const sb = fakeSb([row({ id: "old", suggested_on: "2026-07-04" })]);
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T01:00:00Z"));
    expect(out).toHaveLength(0);
  });

  it("returns only this shop's pending rows", async () => {
    const sb = fakeSb([
      row({}),
      row({ id: "applied", status: "applied" }),
      row({ id: "dismissed", status: "dismissed" }),
      row({ id: "other-shop", shop_id: "shop-2" }),
    ]);
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T12:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["sg1"]);
  });

  it("orders newest suggestion day first, then larger amounts first", async () => {
    const sb = fakeSb([
      row({ id: "small-today", amount_cents: 100 }),
      row({ id: "yesterday", suggested_on: "2026-07-05", amount_cents: 9999 }),
      row({ id: "big-today", amount_cents: 5000 }),
    ]);
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T12:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["big-today", "small-today", "yesterday"]);
  });
});
