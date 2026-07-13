import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.ingest";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any imports so vi.mock factory can reference
// them (mirrors the cron.ingest-ads.test.ts pattern).
// ---------------------------------------------------------------------------
const {
  reconcileAttributedRevenue,
  transformPendingWebhooks,
  backfillShop,
  syncProductInventorySettings,
  repairOrderDestinationsForIntegration,
  runShipCostResolution,
} =
  vi.hoisted(() => ({
    reconcileAttributedRevenue: vi.fn(async (_shopId: string, _sb: unknown) => {}),
    transformPendingWebhooks: vi.fn(async () => ({ processed: 2, facts: 3, dlq: 0 })),
    backfillShop: vi.fn(async () => {}),
    syncProductInventorySettings: vi.fn(async () => 0),
    repairOrderDestinationsForIntegration: vi.fn(async (_integration: { shopId: string }) => ({
      scanned: 1,
      updated: 1,
      checked: 1,
      completed: true,
    })),
    runShipCostResolution: vi.fn(async (_sb: unknown, _shopId: string, _opts: unknown) => {}),
  }));

vi.mock("~/lib/attribution/revenue.server", () => ({ reconcileAttributedRevenue }));
vi.mock("~/lib/ingest/transform.server", () => ({ transformPendingWebhooks }));
vi.mock("~/lib/ingest/backfill.server", () => ({ backfillShop, syncProductInventorySettings }));
vi.mock("~/lib/ingest/destination-repair.server", () => ({ repairOrderDestinationsForIntegration }));
vi.mock("~/lib/ship-cost/runner.server", () => ({ runShipCostResolution }));

// Fake Supabase modelling the two cron.ingest query shapes against a fixed set
// of active shops. The active Shopify state after backfill is sync_status="ready"
// (backfill.server.ts sets "ready"; nothing promotes a Shopify integration to
// "live"), so Phases 3/4 MUST include "ready" shops — selecting "live" alone
// matches zero real shops, which is the bug under test.
//   Phase 1 (backfill):    ...{eq|in}("sync_status", ...).limit(5)   → empty here
//   Phase 3/4 (liveShops): ...{eq|in}("sync_status", ...) (thenable) → status-matched shops
const ACTIVE_SHOPS = [
  { shop_id: "s1", sync_status: "ready", shops: { shop_domain: "one.myshopify.com" } },
  { shop_id: "s2", sync_status: "live", shops: { shop_domain: "two.myshopify.com" } },
];

const repairSelection = { limit: 0, orderedBy: "", nullsFirst: false };

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== "shop_integrations") {
        // Not used in these tests — return a no-op chain
        const noop = {
          select: () => noop,
          eq: () => noop,
          is: () => noop,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return noop;
      }
      // Capture the sync_status filter from either .eq or .in so the thenable
      // resolves the shops whose status actually matches the query.
      let statusFilter: string[] = [];
      let repairOnly = false;
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
        is: (col: string) => {
          if (col === "destination_repair_completed_at") repairOnly = true;
          return chain;
        },
        order: (col: string, opts: { nullsFirst?: boolean }) => {
          repairSelection.orderedBy = col;
          repairSelection.nullsFirst = opts.nullsFirst === true;
          return chain;
        },
        limit: (value: number) => {
          if (!repairOnly) return Promise.resolve({ data: [], error: null }); // pending backfill
          repairSelection.limit = value;
          const data = ACTIVE_SHOPS.filter((s) => statusFilter.includes(s.sync_status)).slice(0, value);
          return Promise.resolve({ data, error: null });
        },
        then: (cb: (r: { data: unknown; error: null }) => unknown) => {
          const data = ACTIVE_SHOPS.filter((s) => statusFilter.includes(s.sync_status)).map(
            (s) => ({ shop_id: s.shop_id, shops: s.shops }),
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
    repairOrderDestinationsForIntegration.mockResolvedValue({
      scanned: 1,
      updated: 1,
      checked: 1,
      completed: true,
    });
    repairSelection.limit = 0;
    repairSelection.orderedBy = "";
    repairSelection.nullsFirst = false;
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

    // per-phase timing marks recorded for every phase, in ms
    expect(Object.keys(body.phaseMs)).toEqual([
      "backfill",
      "inventory_settings",
      "destination_repair",
      "transform",
      "owned_transform",
      "attribution",
      "ship_cost",
    ]);
    for (const ms of Object.values(body.phaseMs)) {
      expect(typeof ms).toBe("number");
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("fairly selects bounded incomplete ready/live integrations for destination repair", async () => {
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(repairOrderDestinationsForIntegration).toHaveBeenCalledTimes(2);
    expect(repairOrderDestinationsForIntegration).toHaveBeenCalledWith(
      { shopId: "s1", shopDomain: "one.myshopify.com" },
      expect.anything(),
    );
    expect(repairOrderDestinationsForIntegration).toHaveBeenCalledWith(
      { shopId: "s2", shopDomain: "two.myshopify.com" },
      expect.anything(),
    );
    expect(repairSelection).toEqual({
      limit: 5,
      orderedBy: "destination_repair_attempted_at",
      nullsFirst: true,
    });
    expect(body.destinationRepair).toMatchObject({ shops: 2, scanned: 2, updated: 2, checked: 2 });
    expect(body.destinationRepairErrors).toEqual([]);
  });

  it("keeps a failed repair retryable and continues with the next integration", async () => {
    repairOrderDestinationsForIntegration.mockImplementation(async ({ shopId }: { shopId: string }) => {
      if (shopId === "s1") throw new Error("transient Admin API failure");
      return { scanned: 1, updated: 0, checked: 1, completed: true };
    });

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(repairOrderDestinationsForIntegration).toHaveBeenCalledWith(
      { shopId: "s2", shopDomain: "two.myshopify.com" },
      expect.anything(),
    );
    expect(body.destinationRepairErrors).toEqual(["one.myshopify.com: transient Admin API failure"]);
    expect(body.destinationRepair).toMatchObject({ shops: 1, checked: 1 });
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
