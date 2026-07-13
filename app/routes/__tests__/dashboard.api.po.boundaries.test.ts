import { beforeEach, describe, expect, it, vi } from "vitest";
import { action as poAction } from "../dashboard.api.po._index";
import { action as detailAction } from "../dashboard.api.po.$id";
import { action as suppliersAction } from "../dashboard.api.po.suppliers";
import type * as HttpServer from "~/lib/dashboard/http.server";

const mocks = vi.hoisted(() => ({
  updateSupplier: vi.fn(),
  setSupplierActive: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1" })),
}));

vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
  requireSameOrigin: vi.fn(),
}));

vi.mock("~/lib/po/purchase-orders.server", () => ({
  cancelPurchaseOrder: vi.fn(),
  createPurchaseOrder: vi.fn(),
  getPurchaseOrder: vi.fn(),
  listPromotedAuditIds: vi.fn(),
  listPurchaseOrders: vi.fn(),
  markOrdered: vi.fn(),
  promoteAuditDraft: vi.fn(),
  receiveLines: vi.fn(),
  updateDraftPurchaseOrder: vi.fn(),
  validatePoBody: vi.fn(),
  validateReceiveBody: vi.fn(),
}));

vi.mock("~/lib/po/suppliers.server", () => ({
  createSupplier: vi.fn(),
  listSuppliers: vi.fn(),
  setSupplierActive: (...args: unknown[]) => mocks.setSupplierActive(...args),
  updateSupplier: (...args: unknown[]) => mocks.updateSupplier(...args),
  validateSupplierInput: vi.fn(() => ({ name: "Acme" })),
}));

const PO_ID = "11111111-1111-4111-8111-111111111111";

function post(pathname: string, body: unknown): Request {
  return new Request(`https://calderyncompany.com${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("purchase-order JSON boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, []])("collection rejects non-object JSON %# with 422", async (body) => {
    const response = (await poAction({
      request: post("/dashboard/api/po", body),
      params: {},
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(422);
  });

  it.each([null, []])("detail rejects non-object JSON %# with 422", async (body) => {
    const response = (await detailAction({
      request: post(`/dashboard/api/po/${PO_ID}`, body),
      params: { id: PO_ID },
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(422);
  });

  it.each([null, []])("suppliers rejects non-object JSON %# with 422", async (body) => {
    const response = (await suppliersAction({
      request: post("/dashboard/api/po/suppliers", body),
      params: {},
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(422);
  });

  it("maps a malformed supplier UUID to invalid_supplier without a query", async () => {
    const response = (await suppliersAction({
      request: post("/dashboard/api/po/suppliers", {
        intent: "update",
        supplierId: "not-a-uuid",
        name: "Acme",
      }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_supplier" });
    expect(mocks.updateSupplier).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean active flag instead of coercing it to false", async () => {
    const response = (await suppliersAction({
      request: post("/dashboard/api/po/suppliers", {
        intent: "set_active",
        supplierId: PO_ID,
        active: "false",
      }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_supplier" });
    expect(mocks.setSupplierActive).not.toHaveBeenCalled();
  });
});
