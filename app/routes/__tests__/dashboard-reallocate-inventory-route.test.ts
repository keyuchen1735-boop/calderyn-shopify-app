// app/routes/__tests__/dashboard-reallocate-inventory-route.test.ts
// Regression: an owned-native shop (org_mode=live, no connected Shopify store, so
// session.shopDomain is null) must still be able to run reallocate_inventory — the
// executor routes the move to Calderyn's own inventory engine and needs no Shopify
// admin. The route must NOT reject with shopify_required before it gets there. It
// passes admin: null in that case. discontinue_sku, which has no owned path, still
// requires a connected store.
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

  it("still requires a connected store for discontinue_sku (no owned equivalent)", async () => {
    // The guard throws a 422 Response (Remix surfaces a thrown Response as the response).
    const res = (await call({ type: "discontinue_sku", idempotency_key: "k2" }).catch(
      (e) => e,
    )) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "shopify_required" });
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
  });

  it("resolves the Shopify admin when the shop HAS a connected store", async () => {
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    const res = await call({ type: "reallocate_inventory", idempotency_key: "k3" });
    expect(res.status).toBe(200);
    expect(adminSpy).toHaveBeenCalledWith("x.myshopify.com");
    expect(executeInventoryAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ admin: expect.objectContaining({ graphql: expect.any(Function) }) }),
    );
  });
});
