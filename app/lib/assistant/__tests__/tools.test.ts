import { describe, it, expect, vi } from "vitest";
import { ASSISTANT_TOOLS, EXTERNAL_TOOLS, makeToolDispatcher } from "../tools.server";
import { CalderynError } from "../../calderyn.server";
import type { CalderynClient } from "../../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../../labels";
import * as commerceTools from "../commerce-tools.server";
import * as executeModule from "../actions/execute.server";

const listOrdersUnifiedMock = vi.fn(async (..._args: unknown[]) => ({
  rows: [
    {
      source: "calderyn" as const,
      id: "o1",
      ref: "#1001",
      buyerEmail: "jane@example.com",
      totalCents: 4999,
      currency: "usd",
      paymentStatus: "paid",
      state: "paid",
      cancelledAt: null,
      archivedAt: null,
      occurredAt: "2026-07-01T00:00:00.000Z",
      itemCount: 2,
      tags: ["vip"],
      remainingRefundableCents: 4999,
    },
    {
      source: "shopify" as const,
      id: "s1",
      ref: "#900",
      buyerEmail: null,
      totalCents: 1200,
      currency: "usd",
      paymentStatus: "refunded",
      state: "refunded",
      cancelledAt: null,
      archivedAt: null,
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      tags: [],
      remainingRefundableCents: 0,
    },
  ],
  totalCount: 88,
  offset: 0,
  limit: 10,
}));
vi.mock("../../order/unified-list.server", () => ({
  listOrdersUnified: (...a: unknown[]) => listOrdersUnifiedMock(...a),
}));

const loadOrderDetailMock = vi.fn(async (..._args: unknown[]) => ({
  source: "calderyn" as const,
  id: "o1",
  ref: "#1001",
  createdAt: "2026-07-01T00:00:00.000Z",
  state: "paid",
  financialStatus: "paid",
  archivedAt: null,
  cancelledAt: null,
  cancelReason: null,
  channel: null,
  attribution: null,
  currency: "usd",
  subtotalCents: 4500,
  shippingCents: 300,
  taxCents: 199,
  discountCents: 0,
  totalCents: 4999,
  refundedCents: 0,
  remainingRefundableCents: 4999,
  buyer: { id: "b1", email: "jane@example.com" },
  shippingAddress: {
    name: "Jane",
    line1: "1 Main St",
    line2: null,
    city: "Springfield",
    region: "IL",
    postal: "62704",
    country: "US",
  },
  lines: Array.from({ length: 25 }, (_, i) => ({
    id: `l${i}`,
    variantId: `v${i}`,
    title: `Item ${i}`,
    sku: `SKU${i}`,
    quantity: 2,
    reducedQuantity: 0,
    unitPriceCents: 100,
    fulfilledQuantity: 1,
  })),
  fulfillments: [],
  tags: ["vip"],
  timeline: Array.from({ length: 8 }, (_, i) => ({
    kind: "note" as const,
    at: `2026-07-0${i + 1}T00:00:00.000Z`,
    title: `Event ${i}`,
    detail: null,
    author: null,
  })),
  returns: [
    {
      id: "r1",
      orderId: "o1",
      status: "closed" as const,
      reason: null,
      createdAt: "2026-07-02T00:00:00.000Z",
      receivedAt: "2026-07-03T00:00:00.000Z",
      lines: [{ id: "rl1", orderLineId: "l0", quantity: 1, restock: true, refundCents: 500 }],
    },
  ],
  readOnly: false,
  signals: { stuckUnfulfilled: false, stuckDays: null, repeatCustomer: true, buyerOrderCount: 3, refundRisk: false },
}));
vi.mock("../../order/detail.server", () => ({
  loadOrderDetail: (...a: unknown[]) => loadOrderDetailMock(...a),
}));

vi.mock("../commerce-tools.server", () => ({
  COMMERCE_TOOL_NAMES: ["get_catalog", "create_quote", "get_quote", "place_order"],
  COMMERCE_TOOLS: [],
  handleCommerceTool: vi.fn(async () => ({
    content: JSON.stringify({ order_id: "ord1", pay_url: "https://stripe/cs_1", status: "awaiting_payment" }),
  })),
}));

// tools.server.ts pulls the real registry to build ASSISTANT_TOOLS + the
// registry-name set; stub it to a couple of fake actions so this dispatch-
// logic test never needs the real domain modules (they reach app/shopify.server.ts,
// which throws without SHOPIFY_API_SECRET — same reason execute.test.ts mocks
// import/run.server).
vi.mock("../actions/registry.server", () => ({
  ASSISTANT_ACTIONS: [{ name: "pause_campaign" }, { name: "issue_refund" }],
  generatedWriteTools: () => [
    { name: "pause_campaign", description: "Pause a campaign.", input_schema: { type: "object", properties: {} } },
    { name: "issue_refund", description: "Issue a refund.", input_schema: { type: "object", properties: {} } },
  ],
}));

vi.mock("../actions/execute.server", () => ({
  runRegistryAction: vi.fn(async () => ({
    content: JSON.stringify({ ok: true, receipt: { action: "pause_campaign" } }),
    receipt: { action: "pause_campaign", summary: "Paused the campaign", auditId: "a1", undoable: true },
  })),
}));

function fakeClient(): {
  client: CalderynClient;
  listSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn(async () => [
    { id: "a1", detector_id: "reorder_timing" },
    { id: "a2", detector_id: "unknown_future_detector" },
  ]);
  const getSpy = vi.fn(async (id: string) => {
    if (id === "missing") {
      throw new CalderynError({ code: "ALERT_NOT_FOUND", status: 404, message: "nope" });
    }
    return {
      id,
      detector_id: "campaign_below_breakeven",
      title: "Below breakeven",
      dollar_impact: 123400,
    };
  });
  const client = {
    alerts: { list: listSpy, get: getSpy },
    campaigns: { list: async () => [] },
    skus: { list: async () => [] },
    audit: { list: async () => [] },
    guardrails: { get: async () => ({}) },
    integrations: { list: async () => ({}) },
  } as unknown as CalderynClient;
  return { client, listSpy, getSpy };
}

describe("ASSISTANT_TOOLS", () => {
  it("exposes read tools + flag_alert + order search/detail + generated registry tools, with propose_action gone", () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "flag_alert",
        "get_alert",
        "get_guardrails",
        "list_alerts",
        "list_audit",
        "list_campaigns",
        "list_integrations",
        "list_skus",
        "search_orders",
        "get_order",
        "pause_campaign",
        "issue_refund",
      ].sort(),
    );
    expect(names).not.toContain("propose_action");
  });
});

describe("EXTERNAL_TOOLS", () => {
  it("never includes registry write tools or the order search/detail tools", () => {
    const names = EXTERNAL_TOOLS.map((t) => t.name);
    expect(names).not.toContain("pause_campaign");
    expect(names).not.toContain("issue_refund");
    expect(names).not.toContain("search_orders");
    expect(names).not.toContain("get_order");
    expect(names).toContain("flag_alert");
  });
});

describe("makeToolDispatcher", () => {
  it("list_alerts maps detector_id input to the client 'detector' filter", async () => {
    const { client, listSpy } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("list_alerts", { detector_id: "cogs_drift", status: "open" }, "tu-0");
    expect(listSpy).toHaveBeenCalledWith({ status: "open", severity: undefined, detector: "cogs_drift" });
    expect(JSON.parse(res.content).alerts).toHaveLength(2);
    expect(res.isError).toBeFalsy();
  });

  it("list_alerts enriches every alert with allowed_actions from DETECTOR_TO_ACTIONS, falling back for an unknown detector", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("list_alerts", {}, "tu-0");
    const alerts = JSON.parse(res.content).alerts as Array<{ detector_id: string; allowed_actions: string[] }>;
    const reorder = alerts.find((a) => a.detector_id === "reorder_timing");
    expect(reorder?.allowed_actions).toEqual(DETECTOR_TO_ACTIONS.reorder_timing);
    const unknown = alerts.find((a) => a.detector_id === "unknown_future_detector");
    expect(unknown?.allowed_actions).toEqual(["snooze_alert"]);
  });

  it("get_alert enriches the returned alert with allowed_actions for its detector", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("get_alert", { id: "a1" }, "tu-0");
    const { alert } = JSON.parse(res.content);
    expect(alert.detector_id).toBe("campaign_below_breakeven");
    expect(alert.allowed_actions).toEqual(DETECTOR_TO_ACTIONS.campaign_below_breakeven);
  });

  it("flag_alert acknowledges via the injected callback and reports the flagged alert", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(flagAlert).toHaveBeenCalledWith("a1");
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).flagged).toEqual({
      id: "a1",
      title: "Below breakeven",
      status: "acknowledged",
    });
  });

  it("flag_alert errors when the surface provides no flag callback", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_UNAVAILABLE");
  });

  it("flag_alert reports a no-op acknowledge as FLAG_FAILED", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client, { flagAlert: async () => false });
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_FAILED");
  });

  it("flag_alert never flags an unknown alert (shop-scoped get throws first)", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "missing" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ALERT_NOT_FOUND");
    expect(flagAlert).not.toHaveBeenCalled();
  });

  it("returns COMMERCE_UNAVAILABLE when a commerce tool is called with no commerceCtx", async () => {
    const dispatch = makeToolDispatcher({} as never);
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("COMMERCE_UNAVAILABLE");
  });

  it("routes a commerce tool to the handler when commerceCtx is present (no scope needed)", async () => {
    vi.mocked(commerceTools.handleCommerceTool).mockClear();
    const ctx = { shopId: "s1", clientId: "c1" };
    const dispatch = makeToolDispatcher({} as never, { commerceCtx: ctx });
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" }, "tu-0");
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).pay_url).toBe("https://stripe/cs_1");
    expect(vi.mocked(commerceTools.handleCommerceTool)).toHaveBeenCalledWith(
      "place_order",
      { quote_id: "q1", email: "b@x.com" },
      ctx,
    );
  });

  it("returns ACTIONS_UNAVAILABLE for a registry action name without actionCtx", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("pause_campaign", { campaign_id: "c1" }, "tu-1");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ACTIONS_UNAVAILABLE");
    expect(vi.mocked(executeModule.runRegistryAction)).not.toHaveBeenCalled();
  });

  it("dispatches a registry action to runRegistryAction with a minted idempotency key", async () => {
    vi.mocked(executeModule.runRegistryAction).mockClear();
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client, {
      actionCtx: { shopId: "shop-1", conversationId: "conv-1" },
    });
    const res = await dispatch("pause_campaign", { campaign_id: "c1" }, "tu-9");
    expect(vi.mocked(executeModule.runRegistryAction)).toHaveBeenCalledWith(
      "pause_campaign",
      { campaign_id: "c1" },
      { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "assistant:conv-1:tu-9" },
    );
    expect(res.isError).toBeFalsy();
    expect(res.receipt?.auditId).toBe("a1");
  });

  describe("search_orders / get_order", () => {
    it("search_orders returns ORDERS_UNAVAILABLE without an actionCtx, and never calls listOrdersUnified", async () => {
      listOrdersUnifiedMock.mockClear();
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client);
      const res = await dispatch("search_orders", {}, "tu-0");
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).code).toBe("ORDERS_UNAVAILABLE");
      expect(listOrdersUnifiedMock).not.toHaveBeenCalled();
    });

    it("get_order returns ORDERS_UNAVAILABLE without an actionCtx, and never calls loadOrderDetail", async () => {
      loadOrderDetailMock.mockClear();
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client);
      const res = await dispatch("get_order", { order_id: "o1" }, "tu-0");
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).code).toBe("ORDERS_UNAVAILABLE");
      expect(loadOrderDetailMock).not.toHaveBeenCalled();
    });

    it("search_orders passes shopId + params through, clamps limit at 20, masks emails, and reports total_count", async () => {
      listOrdersUnifiedMock.mockClear();
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      const res = await dispatch(
        "search_orders",
        { search: "jane", payment_status: "paid", fulfillment_status: "unfulfilled", source: "calderyn", limit: 500 },
        "tu-1",
      );
      expect(listOrdersUnifiedMock).toHaveBeenCalledWith("shop-1", {
        limit: 20,
        search: "jane",
        paymentStatus: ["paid"],
        fulfillmentStatus: "unfulfilled",
        source: "calderyn",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toContain("jane@example.com");
      const body = JSON.parse(res.content) as { orders: Array<Record<string, unknown>>; total_count: number };
      expect(body.total_count).toBe(88);
      expect(body.orders).toHaveLength(2);
      const native = body.orders.find((o) => o.source === "calderyn")!;
      expect(native.customer).toBe("j***@example.com");
      expect(native.id).toBe("o1");
      expect(native.fulfillment_status).toBe("Unfulfilled");
      const imported = body.orders.find((o) => o.source === "shopify")!;
      expect(imported.id).toBe("shopify:s1");
      expect(imported.customer).toBeNull();
      expect(imported.fulfillment_status).toBeNull();
      expect(imported.stuck).toBe(false);
    });

    it("search_orders defaults to limit 10 when omitted", async () => {
      listOrdersUnifiedMock.mockClear();
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      await dispatch("search_orders", {}, "tu-2");
      expect(listOrdersUnifiedMock).toHaveBeenCalledWith("shop-1", { limit: 10 });
    });

    it("get_order returns INVALID_INPUT for a blank order_id, without calling loadOrderDetail", async () => {
      loadOrderDetailMock.mockClear();
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      const res = await dispatch("get_order", { order_id: "  " }, "tu-3");
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).code).toBe("INVALID_INPUT");
      expect(loadOrderDetailMock).not.toHaveBeenCalled();
    });

    it("get_order returns ORDER_NOT_FOUND when loadOrderDetail resolves null", async () => {
      loadOrderDetailMock.mockResolvedValueOnce(null as never);
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      const res = await dispatch("get_order", { order_id: "missing" }, "tu-4");
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).code).toBe("ORDER_NOT_FOUND");
    });

    it("get_order caps lines at 20 and the timeline at 5, masks the email, and never leaks the address or a raw email", async () => {
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      const res = await dispatch("get_order", { order_id: "o1" }, "tu-5");
      expect(loadOrderDetailMock).toHaveBeenCalledWith("shop-1", "o1");
      expect(res.isError).toBeFalsy();
      expect(res.content).not.toContain("jane@example.com");
      expect(res.content).not.toContain("1 Main St");
      expect(res.content).not.toContain("shippingAddress");
      const { order } = JSON.parse(res.content) as {
        order: {
          customer: string | null;
          lines: unknown[];
          latest_timeline: Array<{ title: string; at: string }>;
          returns: Array<{ status: string; refund_cents: number }>;
          totals: Record<string, string>;
          signals: Record<string, unknown>;
        };
      };
      expect(order.customer).toBe("j***@example.com");
      expect(order.lines).toHaveLength(20);
      expect(order.latest_timeline).toHaveLength(5);
      expect(order.latest_timeline[0]).toEqual({ title: expect.any(String), at: expect.any(String) });
      expect(order.returns).toEqual([{ status: "closed", refund_cents: 500 }]);
      expect(order.totals.total).toBe("$49.99");
      expect(order.signals).toMatchObject({ repeatCustomer: true, buyerOrderCount: 3 });
    });

    it("get_order's line projection separates original quantity, effective quantity, and fulfilled units", async () => {
      loadOrderDetailMock.mockResolvedValueOnce({
        source: "calderyn",
        id: "o1",
        ref: "#1002",
        createdAt: "2026-07-01T00:00:00.000Z",
        state: "partially_fulfilled",
        financialStatus: "paid",
        archivedAt: null,
        cancelledAt: null,
        cancelReason: null,
        channel: null,
        attribution: null,
        currency: "usd",
        subtotalCents: 1000,
        shippingCents: 0,
        taxCents: 0,
        discountCents: 0,
        totalCents: 1000,
        refundedCents: 0,
        remainingRefundableCents: 1000,
        buyer: null,
        shippingAddress: null,
        lines: [
          { id: "l1", variantId: "v1", title: "Reduced item", sku: "SKU1", quantity: 3, reducedQuantity: 2, unitPriceCents: 100, fulfilledQuantity: 1 },
        ],
        fulfillments: [],
        tags: [],
        timeline: [],
        returns: [],
        readOnly: false,
        signals: { stuckUnfulfilled: false, stuckDays: null, repeatCustomer: false, buyerOrderCount: 0, refundRisk: false },
      } as never);
      const { client } = fakeClient();
      const dispatch = makeToolDispatcher(client, { actionCtx: { shopId: "shop-1", conversationId: "conv-1" } });
      const res = await dispatch("get_order", { order_id: "o1" }, "tu-6");
      const { order } = JSON.parse(res.content) as { order: { lines: Array<Record<string, unknown>>; customer: string | null } };
      // original ordered qty (5) = effective (3) + reduced (2); fulfilled (1) is independent.
      expect(order.lines[0]).toEqual({ title: "Reduced item", quantity: 5, effective_quantity: 3, fulfilled: 1 });
      expect(order.customer).toBeNull();
    });
  });
});
