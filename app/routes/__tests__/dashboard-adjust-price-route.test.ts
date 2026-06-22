// app/routes/__tests__/dashboard-adjust-price-route.test.ts
// The dashboard alert-action route must accept the adjust_price kind and pass an
// optional new_price_cents override through to the executor (the executor owns
// the cap + live-price validation). Thin dispatcher — mock the executor and the
// auth boundary; assert the wiring.
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireDashboardSession = vi.fn();
const executeAdjustPriceAlertAction = vi.fn();
const executeCreatePoDraft = vi.fn();
const executeReallocateSpendSku = vi.fn();

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("~/lib/actions/po-action.server", () => ({
  executeCreatePoDraft: (...a: unknown[]) => executeCreatePoDraft(...a),
}));
vi.mock("~/lib/actions/reallocate-sku.server", () => ({
  executeReallocateSpendSku: (...a: unknown[]) => executeReallocateSpendSku(...a),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/dashboard/http.server")>()),
  requireSameOrigin: vi.fn(),
}));
vi.mock("~/lib/actions/adjust-price.server", () => ({
  executeAdjustPriceAlertAction: (...a: unknown[]) => executeAdjustPriceAlertAction(...a),
}));
vi.mock("~/lib/calderyn.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/calderyn.server")>()),
  calderynClient: () => ({ alerts: { get: vi.fn() } }),
}));
vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })) },
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ mocked: true }) }));

import { action as alertAction } from "../dashboard.api.alerts.$id.action";

function post(body: unknown): Request {
  return new Request("https://calderyncompany.com/dashboard/api/alerts/a1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}

const call = (body: unknown) =>
  alertAction({ request: post(body), params: { id: "a1" }, context: {} } as never) as Promise<Response>;

describe("POST /dashboard/api/alerts/:id/action — adjust_price", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    executeAdjustPriceAlertAction.mockResolvedValue({
      auditId: "audit-px-1",
      outcome: "succeeded",
      acknowledged: true,
    });
  });

  it("passes a merchant override (new_price_cents) through to the executor", async () => {
    const res = await call({ type: "adjust_price", idempotency_key: "k1", new_price_cents: 1725 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-px-1", outcome: "succeeded", acknowledged: true });
    expect(executeAdjustPriceAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "adjust_price",
        alertId: "a1",
        idempotencyKey: "k1",
        newPriceCents: 1725,
        actor: "merchant:web-dashboard",
      }),
    );
  });

  it("omits newPriceCents when none is provided (engine suggestion path)", async () => {
    await call({ type: "adjust_price", idempotency_key: "k2" });
    const arg = executeAdjustPriceAlertAction.mock.calls[0][0] as { newPriceCents?: number };
    expect(arg.newPriceCents).toBeUndefined();
  });

  it("still rejects an unknown action type (422)", async () => {
    const res = await call({ type: "delete_everything", idempotency_key: "k3" });
    expect(res.status).toBe(422);
    expect(executeAdjustPriceAlertAction).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/api/alerts/:id/action — create_po_draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    executeCreatePoDraft.mockResolvedValue({
      auditId: "audit-po-1",
      outcome: "succeeded",
      acknowledged: true,
    });
  });

  it("passes the merchant quantity + unit cost through to the PO executor", async () => {
    const res = await call({
      type: "create_po_draft",
      idempotency_key: "kpo",
      po_quantity: "40",
      po_unit_cost: "12.50",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-po-1",
      outcome: "succeeded",
      acknowledged: true,
    });
    expect(executeCreatePoDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop-1",
        shopDomain: "x.myshopify.com",
        alertId: "a1",
        idempotencyKey: "kpo",
        quantity: "40",
        unitCost: "12.50",
      }),
    );
  });
});

describe('POST /dashboard/api/alerts/:id/action — reallocate_spend_sku ("Move ad budget to a higher-margin product")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    executeReallocateSpendSku.mockResolvedValue({
      auditId: "audit-rs-1",
      outcome: "succeeded",
      acknowledged: true,
    });
  });

  it("executes the SKU budget reallocation (the campaign pair is derived server-side)", async () => {
    const res = await call({ type: "reallocate_spend_sku", idempotency_key: "krs" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-rs-1",
      outcome: "succeeded",
      acknowledged: true,
    });
    expect(executeReallocateSpendSku).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "a1", idempotencyKey: "krs", actor: "merchant:web-dashboard" }),
    );
  });
});
