import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as RelocateServer from "../../lib/actions/inventory-relocate.server";
import { action } from "../app.skus";

const authenticateAdmin = vi.fn();
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: (...a: unknown[]) => authenticateAdmin(...a) },
}));

const executeInventoryRelocation = vi.fn();
vi.mock("../../lib/actions/inventory-relocate.server", async (importOriginal) => ({
  ...(await importOriginal<typeof RelocateServer>()),
  executeInventoryRelocation: (...a: unknown[]) => executeInventoryRelocation(...a),
}));

vi.mock("../../lib/supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));

// calderynClient is only used by the loader; keep the action test focused.
vi.mock("../../lib/calderyn.server", () => ({ calderynClient: vi.fn() }));

// Stub UI dependencies so the route module can be imported in tests.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    InlineStack: Stub,
    Modal: Object.assign(Stub, { Section: Stub }),
    Page: Stub,
    Select: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));
vi.mock("~/components/calderyn", () => ({
  Icon: () => null,
}));
vi.mock("~/components/calderyn/brand-icons", () => ({
  BrandGlyph: () => null,
}));
vi.mock("~/lib/ids", () => ({ isUuid: () => false }));
vi.mock("../lib/embedded-nav", () => ({ useEmbeddedNavigate: () => () => {} }));

function postForm(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request("https://app.example/app/skus", { method: "POST", body });
}

const FIELDS = {
  sku_id: "sku-1",
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  quantity: "40",
  idempotency_key: "idem-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    session: { shop: "s.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
});

describe("app.skus action", () => {
  it("executes the relocation with form-derived input and returns ok", async () => {
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(body.ok).toBe(true);
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

  it.each([
    ["non-integer quantity", { quantity: "1.5" }],
    ["negative quantity", { quantity: "-3" }],
    ["empty quantity", { quantity: "" }],
    ["missing idempotency key", { idempotency_key: "" }],
    ["missing sku", { sku_id: "" }],
    ["missing from location", { from_location_id: "" }],
    ["missing to location", { to_location_id: "" }],
    ["zero quantity", { quantity: "0" }],
  ])("rejects %s at the boundary without touching the executor", async (_n, patch) => {
    const res = await action({
      request: postForm({ ...FIELDS, ...patch }),
      params: {},
      context: {},
    } as never);
    expect((res as Response).status).toBe(422);
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it("maps RelocationError to a 422 with its code and an error toast", async () => {
    const { RelocationError } = await vi.importActual<typeof RelocateServer>(
      "../../lib/actions/inventory-relocate.server",
    );
    executeInventoryRelocation.mockRejectedValue(
      new RelocationError("QTY_EXCEEDS_AVAILABLE", "Only 39 units available at NY."),
    );
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(422);
    expect(body.error.code).toBe("QTY_EXCEEDS_AVAILABLE");
    expect(body.toast.isError).toBe(true);
  });

  it("surfaces a failed outcome as an error toast, not a success", async () => {
    executeInventoryRelocation.mockResolvedValue({ id: "audit-1", outcome: "failed" });
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect(body.ok).toBe(false);
    expect(body.toast.isError).toBe(true);
  });

  it("maps unexpected errors to a 500 with an error toast", async () => {
    executeInventoryRelocation.mockRejectedValue(new Error("supabase down"));
    const res = await action({ request: postForm(FIELDS), params: {}, context: {} } as never);
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.toast.isError).toBe(true);
  });
});
