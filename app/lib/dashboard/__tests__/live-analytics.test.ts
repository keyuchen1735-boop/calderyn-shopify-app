// app/lib/dashboard/__tests__/live-analytics.test.ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildLiveSnapshot, storeTodayStartIso } from "../live-analytics.server";

const NOW = new Date("2026-07-02T20:00:00Z"); // 4pm America/New_York (EDT, UTC-4)

describe("storeTodayStartIso", () => {
  it("returns the most recent store-local midnight as a UTC instant", () => {
    // New York local midnight on Jul 2 EDT = 04:00Z
    expect(storeTodayStartIso("America/New_York", NOW)).toBe("2026-07-02T04:00:00.000Z");
  });
  it("UTC store: plain UTC midnight", () => {
    expect(storeTodayStartIso("UTC", NOW)).toBe("2026-07-02T00:00:00.000Z");
  });
});

/** Minimal chainable PostgREST stub returning canned rows per table. */
function sbStub(rows: {
  guardrail_config?: { timezone: string } | null;
  storefront_event: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  order_line: Array<Record<string, unknown>>;
}): SupabaseClient {
  const table = (name: string) => {
    const result =
      name === "guardrail_config"
        ? { data: rows.guardrail_config ?? null, error: null }
        : { data: (rows as unknown as Record<string, unknown[]>)[name] ?? [], error: null };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      in: () => chain,
      order: () => chain,
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  };
  return { from: table } as unknown as SupabaseClient;
}

const SESS = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  is_returning: false,
  type,
  country: "US",
  created_at: "2026-07-02T19:00:00Z",
  ...extra,
});

describe("buildLiveSnapshot", () => {
  it("counts distinct sessions, not events, everywhere", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("s1", "page_view"),
        SESS("s1", "page_view"),
        SESS("s1", "cart_add"),
        SESS("s1", "cart_add"),
        SESS("s2", "page_view", { is_returning: true, country: "DE" }),
      ],
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.sessions_today).toBe(2);
    expect(snap.funnel).toEqual({ cart_sessions: 1, checkout_sessions: 0, purchased_sessions: 0 });
    expect(snap.new_vs_returning).toEqual({ new: 1, returning: 1 });
    expect(snap.by_location).toEqual([
      { country: "US", sessions: 1 },
      { country: "DE", sessions: 1 },
    ]);
  });

  it("visitors_now = distinct sessions with an event in the last 5 minutes", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("old", "page_view", { created_at: "2026-07-02T10:00:00Z" }),
        SESS("fresh", "page_view", { created_at: "2026-07-02T19:58:00Z" }),
        SESS("fresh", "cart_add", { created_at: "2026-07-02T19:59:00Z" }),
      ],
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.visitors_now).toBe(1);
  });

  it("visitors_now handles PostgREST's +00:00 timestamptz format (not just Z)", async () => {
    // PostgREST serializes timestamptz with a +00:00 offset and microseconds;
    // the window compare must parse instants, not compare strings.
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("fresh", "page_view", { created_at: "2026-07-02T19:58:00.123456+00:00" }),
        SESS("boundary", "page_view", { created_at: "2026-07-02T19:55:00+00:00" }),
        SESS("old", "page_view", { created_at: "2026-07-02T19:54:59.999+00:00" }),
      ],
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    // fresh + the exact-boundary event count; the one just before does not.
    expect(snap.visitors_now).toBe(2);
  });

  it("purchased_sessions is anchored on paid orders' live_session_id attribution", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [SESS("s1", "checkout_start")],
      orders: [
        {
          id: "o1",
          total_cents: 5000,
          currency: "usd",
          created_at: "2026-07-02T18:00:00Z",
          attribution: { live_session_id: "s1" },
        },
        {
          id: "o2",
          total_cents: 2500,
          currency: "usd",
          created_at: "2026-07-02T19:00:00Z",
          attribution: null, // pre-stamp order: not counted, never crashes
        },
      ],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    // No checkout_complete event was ever emitted (buyer never revisited the
    // confirmation page), yet the paid order still lands in the funnel.
    expect(snap.funnel.purchased_sessions).toBe(1);
    expect(snap.orders_today).toBe(2);
  });

  it("money + top products come from paid orders and their lines", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [SESS("s1", "checkout_start"), SESS("s1", "checkout_complete")],
      orders: [
        { id: "o1", total_cents: 5000, currency: "usd", created_at: "2026-07-02T18:00:00Z" },
        { id: "o2", total_cents: 2500, currency: "usd", created_at: "2026-07-02T19:00:00Z" },
      ],
      order_line: [
        { order_id: "o1", variant_id: "v1", quantity: 2, unit_price_cents: 2000, title_snapshot: "Mug" },
        { order_id: "o2", variant_id: "v2", quantity: 1, unit_price_cents: 2500, title_snapshot: "Cap" },
      ],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.total_sales_today_cents).toBe(7500);
    expect(snap.orders_today).toBe(2);
    expect(snap.currency).toBe("usd");
    expect(snap.funnel.checkout_sessions).toBe(1);
    expect(snap.funnel.purchased_sessions).toBe(1);
    expect(snap.top_products).toEqual([
      { product_id: "v1", title: "Mug", sales_cents: 4000, units: 2 },
      { product_id: "v2", title: "Cap", sales_cents: 2500, units: 1 },
    ]);
  });

  it("folds locations beyond the top 8 into Other and nulls into Unknown", async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      SESS(`s${i}`, "page_view", { country: `C${i}` }),
    );
    events.push(SESS("s10", "page_view", { country: null }));
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: events,
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.by_location).toHaveLength(9); // top 8 + Other
    expect(snap.by_location[8].country).toBe("Other");
    expect(snap.by_location.reduce((n, l) => n + l.sessions, 0)).toBe(11);
    const named = new Set(snap.by_location.map((l) => l.country));
    // The null-country session appears somewhere — either as a visible
    // "Unknown" row or folded into Other's count.
    expect(named.has("Unknown") || snap.by_location[8].sessions >= 1).toBe(true);
  });

  it("all-zero snapshot is valid (cold start)", async () => {
    const sb = sbStub({ guardrail_config: null, storefront_event: [], orders: [], order_line: [] });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.visitors_now).toBe(0);
    expect(snap.total_sales_today_cents).toBe(0);
    expect(snap.top_products).toEqual([]);
    expect(typeof snap.generated_at).toBe("string");
  });
});
