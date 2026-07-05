import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../../../routes/dashboard.api.skus.$id.relocate";
import type * as SessionServer from "../session.server";
import type * as HttpServer from "../http.server";
import type * as InventoryRelocateServer from "../../actions/inventory-relocate.server";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeInventoryRelocation = vi.fn();
const unauthenticatedAdmin = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionServer>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../actions/inventory-relocate.server", async (importOriginal) => ({
  ...(await importOriginal<typeof InventoryRelocateServer>()),
  executeInventoryRelocation: (...a: unknown[]) => executeInventoryRelocation(...a),
}));
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ mocked: true }) }));
vi.mock("../../../shopify.server", () => ({
  unauthenticated: { admin: (...a: unknown[]) => unauthenticatedAdmin(...a) },
}));

function post(body: unknown) {
  return new Request("https://app.example/dashboard/api/skus/sku-1/relocate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const BODY = {
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  quantity: 40,
  idempotency_key: "idem-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "s.myshopify.com",
  });
  unauthenticatedAdmin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
});

describe("dashboard.api.skus.$id.relocate", () => {
  it("executes with session-derived shop and route-param sku", async () => {
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    const body = await (res as Response).json();
    expect(body).toMatchObject({ audit_id: "audit-1", outcome: "succeeded" });
    expect(executeInventoryRelocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        alertId: null,
        skuId: "sku-1",
        fromLocationId: "gid://shopify/Location/9",
        toLocationId: "gid://shopify/Location/2",
        quantity: 40,
        idempotencyKey: "idem-1",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("owned-native shop (no Shopify store) relocates with admin: null, no Shopify auth", async () => {
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: null });
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    expect((res as Response).status).toBe(200);
    // No Shopify admin resolved; the executor still runs (it routes to the owned engine).
    expect(unauthenticatedAdmin).not.toHaveBeenCalled();
    expect(executeInventoryRelocation).toHaveBeenCalledWith(
      "shop-1",
      expect.anything(),
      expect.anything(),
      null,
    );
  });

  it("rejects non-POST", async () => {
    const res = await action({
      request: new Request("https://x/", { method: "GET" }),
      params: { id: "sku-1" },
      context: {},
    } as never);
    expect((res as Response).status).toBe(405);
  });

  it("422s on invalid json", async () => {
    const res = await action({
      request: new Request("https://x/", { method: "POST", body: "{nope" }),
      params: { id: "sku-1" },
      context: {},
    } as never);
    expect((res as Response).status).toBe(422);
  });

  it("422s on missing sku id without executing", async () => {
    const res = await action({ request: post(BODY), params: {}, context: {} } as never);
    expect((res as Response).status).toBe(422);
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it.each([
    ["missing idempotency key", { ...BODY, idempotency_key: "" }],
    ["zero quantity", { ...BODY, quantity: 0 }],
    ["fractional quantity", { ...BODY, quantity: 1.5 }],
    ["missing from location", { ...BODY, from_location_id: "" }],
    ["missing to location", { ...BODY, to_location_id: "" }],
  ])("422s on %s without executing", async (_n, bad) => {
    const res = await action({ request: post(bad), params: { id: "sku-1" }, context: {} } as never);
    expect((res as Response).status).toBe(422);
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it("maps RelocationError to a 422 with its code", async () => {
    const { RelocationError } = await vi.importActual<typeof InventoryRelocateServer>(
      "../../actions/inventory-relocate.server",
    );
    executeInventoryRelocation.mockRejectedValue(
      new RelocationError("QTY_EXCEEDS_AVAILABLE", "Only 5 units available."),
    );
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    expect((res as Response).status).toBe(422);
    const body = await (res as Response).json();
    expect(body.error).toBe("qty_exceeds_available");
  });

  it("returns failed outcome verbatim (rule 12)", async () => {
    executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "failed" });
    const res = await action({ request: post(BODY), params: { id: "sku-1" }, context: {} } as never);
    const body = await (res as Response).json();
    expect(body).toMatchObject({ audit_id: "audit-1", outcome: "failed" });
  });
});
