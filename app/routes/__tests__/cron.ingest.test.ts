import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.ingest";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any imports so vi.mock factory can reference
// them (mirrors the cron.ingest-ads.test.ts pattern).
// ---------------------------------------------------------------------------
const { reconcileAttributedRevenue, transformPendingWebhooks, backfillShop } = vi.hoisted(() => ({
  reconcileAttributedRevenue: vi.fn(async (_shopId: string, _sb: unknown) => {}),
  transformPendingWebhooks: vi.fn(async () => ({ processed: 2, facts: 3, dlq: 0 })),
  backfillShop: vi.fn(async () => {}),
}));

vi.mock("~/lib/attribution/revenue.server", () => ({ reconcileAttributedRevenue }));
vi.mock("~/lib/ingest/transform.server", () => ({ transformPendingWebhooks }));
vi.mock("~/lib/ingest/backfill.server", () => ({ backfillShop }));

// Fake Supabase: serves both cron.ingest query shapes:
//   Phase 1 (backfill):  .from("shop_integrations").select().eq("kind","shopify").eq("sync_status","pending").limit(5)
//   Phase 3 (reconcile): .from("shop_integrations").select().eq("kind","shopify").eq("sync_status","live")  → thenable
// We track which sync_status was last set so we can return the right data.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== "shop_integrations") {
        // Not used in these tests — return a no-op chain
        return { select: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) };
      }
      // Build a chain that captures the final eq value to decide what to return.
      let lastStatus = "";
      const chain = {
        select: () => chain,
        eq: (_col: string, val: string) => {
          if (val === "pending" || val === "live") lastStatus = val;
          return chain;
        },
        limit: () => Promise.resolve({ data: [], error: null }), // backfill: always empty
        then: (cb: (r: { data: unknown; error: null }) => unknown) => {
          // reconcile live query resolves via then()
          const data = lastStatus === "live" ? [{ shop_id: "s1" }, { shop_id: "s2" }] : [];
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

  it("calls reconcileAttributedRevenue after transform for each live shop", async () => {
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
});
