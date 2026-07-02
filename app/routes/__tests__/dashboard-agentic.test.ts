import { describe, it, expect, vi, beforeEach } from "vitest";

import { loader } from "../dashboard.api.agentic._index";

// Chainable Supabase query builder: every builder method (.select/.eq/.is/.in)
// returns self, then `await self` resolves to the per-table result. The loader
// chains .eq().is() (mcp_tokens), .eq().in() (mcp_oauth_clients), and .eq().eq()
// (orders), so all four builder methods must be present.
type TableResult = Record<string, unknown>;
function makeChainable(result: TableResult) {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    is: () => self,
    in: () => self,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return self;
}

const TABLES: Record<string, TableResult> = {
  // The shop's own connected clients: a non-revoked token per client_id links a
  // global mcp_oauth_clients row to this shop.
  mcp_tokens: {
    data: [{ client_id: "cal_client_chatgpt" }],
    error: null,
  },
  mcp_oauth_clients: {
    data: [{ client_name: "ChatGPT", spend_cap_cents: 50000 }],
    error: null,
  },
  commerce_quote_fact: { count: 12, data: null, error: null },
  orders: {
    data: [
      {
        id: "o1",
        total_cents: 2660,
        currency: "usd",
        protocol: "mcp",
        state: "paid",
        created_at: "2026-06-29",
      },
    ],
    error: null,
  },
};

const { requireDashboardSession, getSupabase } = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  getSupabase: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));

describe("dashboard agentic channel loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({
      shopId: "shop_test",
      shopDomain: "test.myshopify.com",
      sessionId: "s1",
    });
    getSupabase.mockReturnValue({
      from: (t: string) => makeChainable(TABLES[t] ?? { data: [], error: null }),
    });
  });

  it("returns connected clients, quote count, and agentic orders for the shop", async () => {
    const res = await loader({
      request: new Request("https://app/dashboard/api/agentic"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      clients: { name: string; spendCapCents: number }[];
      quotesIssued: number;
      orders: { id: string; protocol: string | null; state: string; totalCents: number }[];
      ordersCount: number;
      revenueCents: number;
    };
    expect(data.clients[0].name).toBe("ChatGPT");
    expect(data.quotesIssued).toBe(12);
    expect(data.orders[0].protocol).toBe("mcp");
    expect(data.ordersCount).toBe(1);
    expect(data.revenueCents).toBe(2660);
  });

  it("excludes OAuth clients that have no active token for the shop", async () => {
    // Shop has zero connected commerce clients. mcp_oauth_clients is a global
    // registry, so without shop scoping every merchant would see ChatGPT here —
    // the loader must return an empty client list instead of leaking the registry.
    getSupabase.mockReturnValue({
      from: (t: string) =>
        makeChainable(t === "mcp_tokens" ? { data: [], error: null } : TABLES[t] ?? { data: [], error: null }),
    });
    const res = await loader({
      request: new Request("https://app/dashboard/api/agentic"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { clients: unknown[] };
    expect(data.clients).toEqual([]);
  });
});
