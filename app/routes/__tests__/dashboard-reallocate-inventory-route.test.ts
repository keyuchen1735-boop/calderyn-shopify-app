// app/routes/__tests__/dashboard-reallocate-inventory-route.test.ts
// Regression: an owned-native shop (org_mode=live, no connected Shopify store, so
// session.shopDomain is null) must still be able to run store actions — the
// executors route them to Calderyn's own engine and need no Shopify admin. The route
// must NOT resolve Shopify before it gets there and passes admin: null instead.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action as alertAction } from "../dashboard.api.alerts.$id.action";
import type * as HttpServer from "~/lib/dashboard/http.server";
import type * as CalderynServer from "~/lib/calderyn.server";

const requireDashboardSession = vi.fn();
const executeInventoryAlertAction = vi.fn();
const executeDiscontinueAlertAction = vi.fn();
const adminSpy = vi.fn();
const alertsGetSpy = vi.fn();
const recordApprovalSpy = vi.fn();
const getOrgMode = vi.fn();
const shopHasShopifyConnection = vi.fn();

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("~/lib/actions/alert-action.server", () => ({
  executeInventoryAlertAction: (...a: unknown[]) => executeInventoryAlertAction(...a),
  executeDiscontinueAlertAction: (...a: unknown[]) => executeDiscontinueAlertAction(...a),
}));
vi.mock("~/lib/actions/po-action.server", () => ({ executeCreatePoDraft: vi.fn() }));
vi.mock("~/lib/actions/reallocate-sku.server", () => ({ executeReallocateSpendSku: vi.fn() }));
vi.mock("~/lib/actions/adjust-price.server", () => ({ executeAdjustPriceAlertAction: vi.fn() }));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
  requireSameOrigin: vi.fn(),
}));
vi.mock("~/lib/calderyn.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CalderynServer>()),
  calderynClient: () => ({ alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) } }),
}));
vi.mock("~/lib/calibration/approval.server", () => ({
  recordApproval: (...a: unknown[]) => recordApprovalSpy(...a),
}));
vi.mock("~/lib/cutover/org-mode.server", () => ({
  getOrgMode: (...a: unknown[]) => getOrgMode(...a),
  shopHasShopifyConnection: (...a: unknown[]) => shopHasShopifyConnection(...a),
  writesToOwned: (mode: string) => mode === "live",
}));
vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: (...a: unknown[]) => adminSpy(...a) },
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ mocked: true }) }));

function post(body: unknown): Request {
  return new Request("https://calderyncompany.com/dashboard/api/alerts/a1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}
const call = (body: unknown) =>
  alertAction({ request: post(body), params: { id: "a1" }, context: {} } as never) as Promise<Response>;

describe("POST /dashboard/api/alerts/:id/action — owned-native shop (no Shopify store)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Owned-native: a first-party account whose shop never connected Shopify.
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: null });
    getOrgMode.mockResolvedValue("live");
    shopHasShopifyConnection.mockResolvedValue(false);
    alertsGetSpy.mockResolvedValue({ id: "a1", detector_id: "regional_spend_starved_stock" });
    recordApprovalSpy.mockResolvedValue({ delta: 1, before: 22, after: 23 });
    adminSpy.mockResolvedValue({ admin: { graphql: vi.fn() } });
    executeInventoryAlertAction.mockResolvedValue({
      auditId: "audit-inv-1",
      outcome: "succeeded",
      acknowledged: true,
    });
    executeDiscontinueAlertAction.mockResolvedValue({
      auditId: "audit-dc-1",
      outcome: "succeeded",
      acknowledged: true,
    });
  });

  it("runs reallocate_inventory (routes to the owned engine, admin: null, no Shopify auth)", async () => {
    const res = await call({ type: "reallocate_inventory", idempotency_key: "k1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audit_id: "audit-inv-1", outcome: "succeeded" });
    // The key regression: no Shopify admin was resolved, and the executor was still called.
    expect(adminSpy).not.toHaveBeenCalled();
    expect(executeInventoryAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reallocate_inventory", admin: null, shopId: "shop-1" }),
    );
  });

  it("runs discontinue_sku in the owned catalog without Shopify auth", async () => {
    const res = await call({ type: "discontinue_sku", idempotency_key: "k2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audit_id: "audit-dc-1", outcome: "succeeded" });
    expect(adminSpy).not.toHaveBeenCalled();
    expect(executeDiscontinueAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discontinue_sku", admin: null, shopId: "shop-1" }),
    );
  });

  it("resolves the Shopify admin when the shop HAS a connected store", async () => {
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    getOrgMode.mockResolvedValue("mirror");
    shopHasShopifyConnection.mockResolvedValue(true);
    const res = await call({ type: "reallocate_inventory", idempotency_key: "k3" });
    expect(res.status).toBe(200);
    expect(adminSpy).toHaveBeenCalledWith("x.myshopify.com");
    expect(executeInventoryAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ admin: expect.objectContaining({ graphql: expect.any(Function) }) }),
    );
  });
});
