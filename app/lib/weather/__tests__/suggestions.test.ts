import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWeatherSuggestions } from "../suggestions.server";

interface Row {
  id: string;
  shop_id: string;
  suggested_on: string;
  created_at: string;
  status: string;
  narrative: string;
  amount_cents: number;
  expires_on: string;
  source_region: string;
  dest_region: string;
  applied_at?: string | null;
}

// In-memory stand-in that honors the filters/orders/limit the loader applies,
// so the tests assert observable behavior (which rows come back) rather than
// query text. guardrail_config carries the shop's weather_sensitivity dial
// (null = no row, like a shop that never touched guardrails).
function fakeSb(opts: { sensitivity: number | null; rows: Row[] }): SupabaseClient {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: keyof Row; ascending: boolean }> = [];
    let limitN = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: keyof Row, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      gte: (col: keyof Row, val: string) => {
        // NULL never satisfies >= in SQL — a legacy applied row without an
        // applied_at must not surface as executed history.
        filters.push((r) => r[col] != null && String(r[col]) >= val);
        return chain;
      },
      order: (col: keyof Row, o?: { ascending?: boolean }) => {
        orders.push({ col, ascending: o?.ascending !== false });
        return chain;
      },
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      maybeSingle: async () =>
        table === "guardrail_config"
          ? {
              data: opts.sensitivity == null ? null : { weather_sensitivity: opts.sensitivity },
              error: null,
            }
          : { data: null, error: null },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        const out = opts.rows
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => {
            for (const o of orders) {
              const av = a[o.col] ?? "";
              const bv = b[o.col] ?? "";
              const cmp = av < bv ? -1 : av > bv ? 1 : 0;
              if (cmp !== 0) return o.ascending ? cmp : -cmp;
            }
            return 0;
          })
          .slice(0, limitN);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const row = (over: Partial<Row>): Row => ({
  id: "sg1",
  shop_id: "shop-1",
  suggested_on: "2026-07-06",
  created_at: "2026-07-06T07:00:00Z",
  status: "pending",
  narrative: "shift",
  amount_cents: 3000,
  expires_on: "2026-07-09",
  source_region: "us-west",
  dest_region: "us-east",
  ...over,
});

describe("loadWeatherSuggestions", () => {
  it("still returns a suggestion after UTC midnight on the day it was made", async () => {
    // Cron wrote it on the 6th; a merchant looks at 9pm ET = 01:00 UTC on the 7th.
    const sb = fakeSb({ sensitivity: 50, rows: [row({})] });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T01:00:00Z"));
    expect(out).toEqual([
      {
        id: "sg1",
        narrative: "shift",
        amountCents: 3000,
        status: "pending",
        expiresOn: "2026-07-09",
        sourceRegion: "us-west",
        destRegion: "us-east",
      },
    ]);
  });

  it("drops suggestions older than the forecast horizon", async () => {
    const sb = fakeSb({ sensitivity: 50, rows: [row({ id: "old", suggested_on: "2026-07-04" })] });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T01:00:00Z"));
    expect(out).toHaveLength(0);
  });

  it("returns only this shop's pending rows", async () => {
    const sb = fakeSb({
      sensitivity: 50,
      rows: [
        row({}),
        row({ id: "applied", status: "applied" }),
        row({ id: "dismissed", status: "dismissed" }),
        row({ id: "other-shop", shop_id: "shop-2" }),
      ],
    });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T12:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["sg1"]);
  });

  it("shows only the newest suggestion when pending rows stack up across days", async () => {
    // The daily cron writes one row per day for a persistent weather pattern
    // (suggested_on is part of the unique key). Surfacing all of them would let
    // a merchant approve the same intended move several times over.
    const sb = fakeSb({
      sensitivity: 50,
      rows: [
        row({ id: "d1", suggested_on: "2026-07-04", created_at: "2026-07-04T07:00:00Z" }),
        row({ id: "d3", suggested_on: "2026-07-06", created_at: "2026-07-06T07:00:00Z" }),
        row({ id: "d2", suggested_on: "2026-07-05", created_at: "2026-07-05T07:00:00Z" }),
      ],
    });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T12:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["d3"]);
  });

  it("shows only the latest same-day row when a re-run wrote a contradictory pair", async () => {
    // A same-day re-run after a forecast flip can insert a second pending row
    // with the source/dest pair reversed (different conflict key). Only the
    // most recent proposal is actionable.
    const sb = fakeSb({
      sensitivity: 50,
      rows: [
        row({ id: "morning", created_at: "2026-07-06T07:00:00Z" }),
        row({ id: "rerun", created_at: "2026-07-06T15:00:00Z" }),
      ],
    });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T18:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["rerun"]);
  });

  it("returns nothing for an opted-out shop even when pending rows exist", async () => {
    // weather_sensitivity = 0 means the feature is OFF; a merchant who turns
    // the dial off must not keep seeing approvable money moves.
    const off = fakeSb({ sensitivity: 0, rows: [row({})] });
    expect(await loadWeatherSuggestions("shop-1", off, new Date("2026-07-06T12:00:00Z"))).toEqual([]);
    const noCfg = fakeSb({ sensitivity: null, rows: [row({})] });
    expect(await loadWeatherSuggestions("shop-1", noCfg, new Date("2026-07-06T12:00:00Z"))).toEqual([]);
  });

  it("keeps armed rows visible even when the dial is off (scheduled moves stay in sight)", async () => {
    // The next cron sweep disarms them, but until then a scheduled money move
    // (and its Disarm control) must not vanish from the panel.
    const sb = fakeSb({ sensitivity: 0, rows: [row({ id: "armed1", status: "armed" })] });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-06T12:00:00Z"));
    expect(out.map((s) => [s.id, s.status])).toEqual([["armed1", "armed"]]);
  });
});

describe("executed history", () => {
  it("includes recently executed moves (newest first) so the panel shows what ran and when", async () => {
    const sb = fakeSb({
      sensitivity: 100,
      rows: [
        row({ id: "ran2", status: "applied", applied_at: "2026-07-06T09:00:00Z" }),
        row({
          id: "ran1",
          suggested_on: "2026-07-07",
          status: "applied",
          applied_at: "2026-07-07T08:00:00Z",
        }),
        row({ id: "stale", suggested_on: "2026-05-01", status: "applied", applied_at: "2026-05-02T09:00:00Z" }),
      ],
    });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T12:00:00Z"));
    const ran = out.filter((s) => s.status === "applied");
    expect(ran.map((s) => [s.id, s.executedAt])).toEqual([
      ["ran1", "2026-07-07T08:00:00Z"],
      ["ran2", "2026-07-06T09:00:00Z"],
    ]);
  });

  it("keeps executed history visible even when the dial is at zero", async () => {
    const sb = fakeSb({
      sensitivity: 0,
      rows: [row({ id: "ran", status: "applied", applied_at: "2026-07-06T09:00:00Z" })],
    });
    const out = await loadWeatherSuggestions("shop-1", sb, new Date("2026-07-07T12:00:00Z"));
    expect(out.map((s) => s.id)).toEqual(["ran"]);
  });
});
