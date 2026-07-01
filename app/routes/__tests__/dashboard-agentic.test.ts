import { describe, it, expect, vi, beforeEach } from "vitest";

import { loader } from "../dashboard.api.agentic._index";

// Chainable Supabase query builder: .select().eq().eq() all return self,
// then `await self` resolves to the per-table result. Needed because the orders
// query chains two .eq() calls.
type TableResult = Record<string, unknown>;
function makeChainable(result: TableResult) {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return self;
}

const TABLES: Record<string, TableResult> = {
  mcp_oauth_clients: {
    data: [{ name: "ChatGPT", spend_cap_cents: 50000 }],
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
});
