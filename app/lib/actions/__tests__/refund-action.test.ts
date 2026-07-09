import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted seams shared by the module mocks below.
const h = vi.hoisted(() => ({
  prior: vi.fn(),
  insertAudit: vi.fn(),
  transitionOrder: vi.fn(),
  createRefund: vi.fn(),
  restockOrderLines: vi.fn(),
}));

// Lightweight CalderynError so the executor's typed refusals carry code/status/message without
// loading the heavy engine client module.
vi.mock("../../calderyn.server", () => ({
  CalderynError: class extends Error {
    code: string;
    status: number;
    constructor(opts: { code: string; status: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
}));

vi.mock("../execute.server", () => ({
  priorExecutionForKey: h.prior,
  insertAuditWithIdempotency: h.insertAudit,
}));
vi.mock("../../order/order.server", () => ({ transitionOrder: h.transitionOrder }));
vi.mock("../../inventory/engine.server", () => ({ restockOrderLines: h.restockOrderLines }));

// eslint-disable-next-line import/first -- must follow vi.mock so the fakes register before load
import { executeRefundAction } from "../refund.server";

interface SbCfg {
  order?: { data: unknown; error: unknown };
  pi?: { data: unknown; error: unknown };
  ledgerRows?: Array<{ kind: string; amount_cents: number }>;
  orderFact?: { data: unknown; error: unknown };
  rpcResult?: { data: unknown; error: unknown };
  refundFact?: { error: unknown };
}

function makeSb(cfg: SbCfg) {
  const refundFactUpserts: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ordersUpdates: Array<Record<string, unknown>> = [];
  const sb = {
    from(table: string) {
      if (table === "refund_fact") {
        return {
          upsert: (row: Record<string, unknown>) => {
            refundFactUpserts.push(row);
            return Promise.resolve(cfg.refundFact ?? { error: null });
          },
        };
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (vals: Record<string, unknown>) => {
          if (table === "orders") ordersUpdates.push(vals);
          return builder;
        },
        eq: () => builder,
        maybeSingle: () => {
          if (table === "orders") return Promise.resolve(cfg.order ?? { data: null, error: null });
          if (table === "payment_intent") return Promise.resolve(cfg.pi ?? { data: null, error: null });
          if (table === "order_fact") return Promise.resolve(cfg.orderFact ?? { data: { id: "of-1" }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        // transaction_ledger select is awaited directly (no maybeSingle) -> resolve as array.
        then: (resolve: (v: unknown) => unknown) => {
          if (table === "transaction_ledger") {
            return resolve({ data: cfg.ledgerRows ?? [], error: null });
          }
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(
        cfg.rpcResult ?? { data: { captured_cents: 2500, refunded_cents: 2500, fully_refunded: true }, error: null },
      );
    },
  };
  return { sb: sb as unknown as Parameters<typeof executeRefundAction>[2], refundFactUpserts, rpcCalls, ordersUpdates };
}

const CAPTURE_2500 = [{ kind: "capture", amount_cents: 2500 }];

beforeEach(() => {
  vi.clearAllMocks();
  h.prior.mockResolvedValue(null); // fresh key by default
  h.insertAudit.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  h.transitionOrder.mockResolvedValue({ id: "t-1" });
  h.createRefund.mockResolvedValue({ refundId: "re_1", status: "succeeded", chargeId: "ch_1" });
  h.restockOrderLines.mockResolvedValue({ restockedLines: 2, failedVariantIds: [] });
});

function baseCfg(overrides: SbCfg = {}): SbCfg {
  return {
    order: { data: { state: "paid", currency: "usd" }, error: null },
    pi: { data: { id: "pi-row-1", stripe_pi_id: "pi_1", stripe_account_id: null, currency: "usd" }, error: null },
    ledgerRows: CAPTURE_2500,
    ...overrides,
  };
}

describe("executeRefundAction — happy paths", () => {
  it("full refund: Stripe refund, negative ledger, native refund_fact, paid->refunded, audit", async () => {
    const { sb, refundFactUpserts, rpcCalls, ordersUpdates } = makeSb(baseCfg());
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", idempotencyKey: "k1" },
      sb,
      { createRefund: h.createRefund },
    );

    // Full remaining (2500) refunded via Stripe with the idempotency key.
    expect(h.createRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
      amountCents: 2500,
      stripeAccountId: null,
      idempotencyKey: "k1",
    });
    // Atomic ledger RPC with the positive magnitude + the refund id as the idempotency event id.
    expect(rpcCalls[0].name).toBe("record_refund_ledger");
    expect(rpcCalls[0].args).toMatchObject({
      p_shop_id: "shop-1",
      p_payment_intent_id: "pi-row-1",
      p_order_ref: "order-1",
      p_amount_cents: 2500,
      p_stripe_event_id: "re_1",
    });
    // Native refund_fact with a gid://calderyn/ external_line_id (never collides with Shopify rows).
    expect(refundFactUpserts[0]).toMatchObject({
      shop_id: "shop-1",
      order_id: "of-1",
      external_id: "gid://calderyn/Refund/re_1",
      external_line_id: "gid://calderyn/RefundLine/re_1",
      subtotal_cents: 2500,
    });
    // Full refund -> refunded.
    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "refunded", "refund:re_1");
    // financial_status is stamped 'refunded' so live "Sales today" (counts financial_status='paid')
    // stops counting this order at its full captured value.
    expect(ordersUpdates).toContainEqual({ financial_status: "refunded" });
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.action_kind).toBe("issue_refund");
    expect(audit.outcome).toBe("succeeded");
    expect(audit.post_state).toMatchObject({ state: "refunded" });
    expect(res.orderState).toBe("refunded");
    expect(res.refundId).toBe("re_1");
  });

  it("partial refund: paid->partially_refunded when the ledger is not fully refunded", async () => {
    const { sb } = makeSb(
      baseCfg({ rpcResult: { data: { captured_cents: 2500, refunded_cents: 1000, fully_refunded: false }, error: null } }),
    );
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", amountCents: 1000, idempotencyKey: "k2" },
      sb,
      { createRefund: h.createRefund },
    );
    expect(h.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000 }));
    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "partially_refunded", "refund:re_1");
    expect(res.orderState).toBe("partially_refunded");
  });

  it("second partial on an already partially_refunded order that stays partial does NOT re-transition", async () => {
    const { sb, ordersUpdates } = makeSb(
      baseCfg({
        order: { data: { state: "partially_refunded", currency: "usd" }, error: null },
        ledgerRows: [
          { kind: "capture", amount_cents: 2500 },
          { kind: "refund", amount_cents: -500 },
        ],
        rpcResult: { data: { captured_cents: 2500, refunded_cents: 1000, fully_refunded: false }, error: null },
      }),
    );
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", amountCents: 500, idempotencyKey: "k3" },
      sb,
      { createRefund: h.createRefund },
    );
    // target == current (partially_refunded) -> identity move skipped.
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(res.orderState).toBe("partially_refunded");
    // financial_status is still stamped even though `state` did not transition (so a 2nd partial
    // keeps the label accurate).
    expect(ordersUpdates).toContainEqual({ financial_status: "partially_refunded" });
  });

  it("partial that reaches the captured total on a partially_refunded order transitions to refunded", async () => {
    const { sb } = makeSb(
      baseCfg({
        order: { data: { state: "partially_refunded", currency: "usd" }, error: null },
        ledgerRows: [
          { kind: "capture", amount_cents: 2500 },
          { kind: "refund", amount_cents: -1500 },
        ],
        rpcResult: { data: { captured_cents: 2500, refunded_cents: 2500, fully_refunded: true }, error: null },
      }),
    );
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", amountCents: 1000, idempotencyKey: "k4" },
      sb,
      { createRefund: h.createRefund },
    );
    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "refunded", "refund:re_1");
    expect(res.orderState).toBe("refunded");
  });
});

describe("executeRefundAction — guards (fail before moving money)", () => {
  it("refuses an over-refund pre-check without calling Stripe", async () => {
    const { sb } = makeSb(baseCfg());
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", amountCents: 9999, idempotencyKey: "k5" }, sb, {
        createRefund: h.createRefund,
      }),
    ).rejects.toThrow(/exceeds the 2500¢ remaining/);
    expect(h.createRefund).not.toHaveBeenCalled();
  });

  it("refuses a mirrored Shopify order (no owned payment_intent)", async () => {
    const { sb } = makeSb(baseCfg({ pi: { data: null, error: null } }));
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "k6" }, sb, { createRefund: h.createRefund }),
    ).rejects.toThrow(/not paid through Calderyn checkout/);
    expect(h.createRefund).not.toHaveBeenCalled();
  });

  it("refuses a non-refundable order state", async () => {
    const { sb } = makeSb(baseCfg({ order: { data: { state: "checkout_pending", currency: "usd" }, error: null } }));
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "k7" }, sb, { createRefund: h.createRefund }),
    ).rejects.toThrow(/only a paid, partially-fulfilled, fulfilled, or partially-refunded order/);
    expect(h.createRefund).not.toHaveBeenCalled();
  });

  it("refuses an already fully-refunded order", async () => {
    const { sb } = makeSb(
      baseCfg({
        order: { data: { state: "refunded", currency: "usd" }, error: null },
        ledgerRows: [
          { kind: "capture", amount_cents: 2500 },
          { kind: "refund", amount_cents: -2500 },
        ],
      }),
    );
    // refunded is not a refundable state -> refused before the remaining math.
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "k8" }, sb, { createRefund: h.createRefund }),
    ).rejects.toThrow(/only a paid, partially-fulfilled, fulfilled, or partially-refunded order/);
  });
});

describe("executeRefundAction — idempotency + failure surfacing", () => {
  it("replays a completed refund from its audit row without a second Stripe call", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    const { sb } = makeSb({
      // priorExecutionForKey short-circuits before any order/pi read; only the audit re-read runs.
      order: { data: { state: "refunded", currency: "usd" }, error: null },
    });
    // action_audit re-read for resultFromAudit goes through from("action_audit").maybeSingle().
    (sb as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table === "action_audit") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: "audit-9",
                      params: { stripe_refund_id: "re_prev", amount_cents: 2500, captured_cents: 2500, refunded_total_cents: 2500 },
                      post_state: { state: "refunded" },
                    },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({}) }) };
    };
    const res = await executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "dup" }, sb, {
      createRefund: h.createRefund,
    });
    expect(res.replayed).toBe(true);
    expect(res.refundId).toBe("re_prev");
    expect(h.createRefund).not.toHaveBeenCalled();
  });

  it("surfaces a Stripe failure and writes no ledger/audit row", async () => {
    h.createRefund.mockRejectedValue(new Error("card_error: charge already refunded"));
    const { sb, rpcCalls } = makeSb(baseCfg());
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "k9" }, sb, { createRefund: h.createRefund }),
    ).rejects.toThrow(/charge already refunded/);
    expect(rpcCalls).toHaveLength(0);
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("surfaces a ledger-write failure AFTER Stripe succeeded (money moved, must be visible)", async () => {
    const { sb } = makeSb(baseCfg({ rpcResult: { data: null, error: { message: "deadlock" } } }));
    await expect(
      executeRefundAction("shop-1", { orderId: "order-1", idempotencyKey: "k10" }, sb, { createRefund: h.createRefund }),
    ).rejects.toThrow(/was issued but recording it failed/);
    // The refund DID happen on Stripe.
    expect(h.createRefund).toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });
});

describe("executeRefundAction — restock (full refunds only)", () => {
  it("full refund + restock:true restocks once via restockOrderLines(shopId, orderId, 'refund')", async () => {
    const { sb } = makeSb(baseCfg());
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", idempotencyKey: "k11", restock: true },
      sb,
      { createRefund: h.createRefund },
    );
    expect(h.restockOrderLines).toHaveBeenCalledTimes(1);
    expect(h.restockOrderLines).toHaveBeenCalledWith("shop-1", "order-1", "refund");
    expect(res.restockedLines).toBe(2);
    expect(res.restockError).toBeNull();
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.restocked_lines).toBe(2);
  });

  it("a partial restock failure (some variants restocked, some not) surfaces restockError and params.restock_error while the refund still succeeds", async () => {
    h.restockOrderLines.mockResolvedValue({ restockedLines: 1, failedVariantIds: ["v-bad"] });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sb } = makeSb(baseCfg());
      const res = await executeRefundAction(
        "shop-1",
        { orderId: "order-1", idempotencyKey: "k15", restock: true },
        sb,
        { createRefund: h.createRefund },
      );
      expect(res.outcome).toBe("succeeded");
      expect(res.restockedLines).toBe(1);
      expect(res.restockError).toBe("restock failed for variants: v-bad");
      const audit = h.insertAudit.mock.calls[0][2];
      expect(audit.params.restocked_lines).toBe(1);
      expect(audit.params.restock_error).toBe("restock failed for variants: v-bad");
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      consoleErr.mockRestore();
    }
  });

  it("full refund + restock:false (or omitted) never calls restockOrderLines and returns 0", async () => {
    const { sb } = makeSb(baseCfg());
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", idempotencyKey: "k12" },
      sb,
      { createRefund: h.createRefund },
    );
    expect(h.restockOrderLines).not.toHaveBeenCalled();
    expect(res.restockedLines).toBe(0);
  });

  it("partial refund + restock:true does NOT restock; result carries restockedLines:0 and audit params record restock_skipped", async () => {
    const { sb } = makeSb(
      baseCfg({ rpcResult: { data: { captured_cents: 2500, refunded_cents: 1000, fully_refunded: false }, error: null } }),
    );
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", amountCents: 1000, idempotencyKey: "k13", restock: true },
      sb,
      { createRefund: h.createRefund },
    );
    expect(h.restockOrderLines).not.toHaveBeenCalled();
    expect(res.restockedLines).toBe(0);
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.restock_skipped).toBe("partial_refund");
  });

  it("a replayed refund (idempotent hit) returns restockedLines:0 without calling restockOrderLines", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    const { sb } = makeSb({ order: { data: { state: "refunded", currency: "usd" }, error: null } });
    (sb as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table === "action_audit") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: "audit-9",
                      params: { stripe_refund_id: "re_prev", amount_cents: 2500, captured_cents: 2500, refunded_total_cents: 2500 },
                      post_state: { state: "refunded" },
                    },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({}) }) };
    };
    const res = await executeRefundAction(
      "shop-1",
      { orderId: "order-1", idempotencyKey: "dup2", restock: true },
      sb,
      { createRefund: h.createRefund },
    );
    expect(res.replayed).toBe(true);
    expect(res.restockedLines).toBe(0);
    expect(h.restockOrderLines).not.toHaveBeenCalled();
  });

  it("a restock failure does NOT fail the refund; params.restock_error is recorded and the failure is logged loudly", async () => {
    h.restockOrderLines.mockRejectedValue(new Error("inventory_restock: deadlock"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sb } = makeSb(baseCfg());
      const res = await executeRefundAction(
        "shop-1",
        { orderId: "order-1", idempotencyKey: "k14", restock: true },
        sb,
        { createRefund: h.createRefund },
      );
      expect(res.outcome).toBe("succeeded");
      expect(res.restockedLines).toBe(0);
      expect(res.restockError).toMatch(/deadlock/);
      const audit = h.insertAudit.mock.calls[0][2];
      expect(audit.params.restock_error).toMatch(/deadlock/);
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      consoleErr.mockRestore();
    }
  });
});
