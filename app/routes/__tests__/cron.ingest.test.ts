import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.ingest";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any imports so vi.mock factory can reference
// them (mirrors the cron.ingest-ads.test.ts pattern).
// ---------------------------------------------------------------------------
const { reconcileAttributedRevenue, transformPendingWebhooks, backfillShop, runShipCostResolution } =
  vi.hoisted(() => ({
    reconcileAttributedRevenue: vi.fn(async (_shopId: string, _sb: unknown) => {}),
    transformPendingWebhooks: vi.fn(async () => ({ processed: 2, facts: 3, dlq: 0 })),
    backfillShop: vi.fn(async () => {}),
    runShipCostResolution: vi.fn(async (_sb: unknown, _shopId: string, _opts: unknown) => {}),
  }));

vi.mock("~/lib/attribution/revenue.server", () => ({ reconcileAttributedRevenue }));
vi.mock("~/lib/ingest/transform.server", () => ({ transformPendingWebhooks }));
vi.mock("~/lib/ingest/backfill.server", () => ({ backfillShop }));
vi.mock("~/lib/ship-cost/runner.server", () => ({ runShipCostResolution }));

// Fake Supabase modelling the two cron.ingest query shapes against a fixed set
// of active shops. The active Shopify state after backfill is sync_status="ready"
// (backfill.server.ts sets "ready"; nothing promotes a Shopify integration to
// "live"), so Phases 3/4 MUST include "ready" shops — selecting "live" alone
// matches zero real shops, which is the bug under test.
//   Phase 1 (backfill):    ...{eq|in}("sync_status", ...).limit(5)   → empty here
//   Phase 3/4 (liveShops): ...{eq|in}("sync_status", ...) (thenable) → status-matched shops
const ACTIVE_SHOPS = [
  { shop_id: "s1", sync_status: "ready" },
  { shop_id: "s2", sync_status: "ready" },
];

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== "shop_integrations") {
        // Not used in these tests — return a no-op chain
        return { select: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) };
      }
      // Capture the sync_status filter from either .eq or .in so the thenable
      // resolves the shops whose status actually matches the query.
      let statusFilter: string[] = [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "sync_status") statusFilter = [val];
          return chain;
        },
        in: (col: string, vals: string[]) => {
          if (col === "sync_status") statusFilter = vals;
          return chain;
        },
        limit: () => Promise.resolve({ data: [], error: null }), // backfill: always empty
        then: (cb: (r: { data: unknown; error: null }) => unknown) => {
          const data = ACTIVE_SHOPS.filter((s) => statusFilter.includes(s.sync_status)).map(
            (s) => ({ shop_id: s.shop_id }),
          );
          return Promise.resolve(cb({ data, error: null }));
        },
      };
      return chain;
    },
  }),
}));

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/ingest", { headers });
}

describe("cron.ingest loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("runs attribution + ship-cost for each ready (active) shop, not just 'live'", async () => {
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    // transform ran
    expect(transformPendingWebhooks).toHaveBeenCalledOnce();

    // reconciler called once per live shop
    expect(reconcileAttributedRevenue).toHaveBeenCalledTimes(2);
    expect(reconcileAttributedRevenue).toHaveBeenCalledWith("s1", expect.anything());
    expect(reconcileAttributedRevenue).toHaveBeenCalledWith("s2", expect.anything());

    // summary has attributionErrors array (empty on success)
    expect(body).toHaveProperty("attributionErrors");
    expect(body.attributionErrors).toEqual([]);

    // Phase 4: ship-cost runner called once per live shop
    expect(runShipCostResolution).toHaveBeenCalledTimes(2);
    expect(runShipCostResolution).toHaveBeenCalledWith(expect.anything(), "s1", { shopCountry: null });
    expect(runShipCostResolution).toHaveBeenCalledWith(expect.anything(), "s2", { shopCountry: null });
    expect(body).toHaveProperty("shipCostErrors");
    expect(body.shipCostErrors).toEqual([]);
  });

  it("records a ship-cost resolution failure in shipCostErrors and does not abort other shops", async () => {
    runShipCostResolution.mockImplementation(async (_sb: unknown, shopId: string) => {
      if (shopId === "s1") throw new Error("ship-cost boom");
    });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    // s2 still ran despite s1 failing
    expect(runShipCostResolution).toHaveBeenCalledWith(expect.anything(), "s2", expect.anything());

    // failure recorded in summary
    expect(body.shipCostErrors).toHaveLength(1);
    expect(body.shipCostErrors[0]).toContain("s1");

    // other phases unaffected
    expect(body.attributionErrors).toEqual([]);
    expect(body.transform).toMatchObject({ processed: 2, facts: 3 });
  });

  it("records one shop's reconcile failure in attributionErrors and does not abort others", async () => {
    reconcileAttributedRevenue.mockImplementation(async (shopId: string) => {
      if (shopId === "s1") throw new Error("reconcile boom");
    });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    // s2 still ran despite s1 failing
    expect(reconcileAttributedRevenue).toHaveBeenCalledWith("s2", expect.anything());

    // failure recorded in summary
    expect(body.attributionErrors).toHaveLength(1);
    expect(body.attributionErrors[0]).toContain("s1");

    // transform result still present
    expect(body.transform).toMatchObject({ processed: 2, facts: 3 });
  });

  // REGRESSION: a raw PostgREST error object (NOT an Error instance) was
  // String()'d into "[object Object]" in prod. The catch must stringify a
  // Supabase-style {message, code} usefully.
  it("stringifies a raw Supabase error object (non-Error) instead of '[object Object]'", async () => {
    reconcileAttributedRevenue.mockImplementation(async (shopId: string) => {
      if (shopId === "s1") {
        // intentionally a raw PostgREST object (NOT an Error) to reproduce the bug
        throw { message: "URI too long", code: "PGRST301", details: "uri", hint: null };
      }
    });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.attributionErrors).toHaveLength(1);
    expect(body.attributionErrors[0]).not.toContain("[object Object]");
    expect(body.attributionErrors[0]).toContain("URI too long");
    expect(body.attributionErrors[0]).toContain("PGRST301");
  });

  it("stringifies a raw Supabase error object in the ship-cost (Phase 4) catch too", async () => {
    runShipCostResolution.mockImplementation(async (_sb: unknown, shopId: string) => {
      if (shopId === "s1") {
        // intentionally a raw PostgREST object (NOT an Error) to reproduce the bug
        throw { message: "column does not exist", code: "42703" };
      }
    });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.shipCostErrors).toHaveLength(1);
    expect(body.shipCostErrors[0]).not.toContain("[object Object]");
    expect(body.shipCostErrors[0]).toContain("column does not exist");
  });
});
