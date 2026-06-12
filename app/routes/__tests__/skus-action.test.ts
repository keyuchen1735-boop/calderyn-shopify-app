import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as RelocateServer from "../../lib/actions/inventory-relocate.server";
import type * as AlertActionServer from "../../lib/actions/alert-action.server";
import type * as CalderynServer from "../../lib/calderyn.server";
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

const executeInventoryAlertAction = vi.fn();
vi.mock("../../lib/actions/alert-action.server", async (importOriginal) => ({
  ...(await importOriginal<typeof AlertActionServer>()),
  executeInventoryAlertAction: (...a: unknown[]) => executeInventoryAlertAction(...a),
}));

vi.mock("../../lib/supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));

const STUB_CLIENT = { stub: "client" };
const calderynClient = vi.fn((..._a: unknown[]) => STUB_CLIENT);
vi.mock("../../lib/calderyn.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CalderynServer>()),
  calderynClient: (...a: unknown[]) => calderynClient(...a),
}));

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

const ALERT_FIELDS = {
  intent: "alert_action",
  alert_id: "al-1",
  kind: "reallocate_inventory",
  idempotency_key: "idem-2",
};

describe("app.skus action — alert_action intent", () => {
  beforeEach(() => {
    executeInventoryAlertAction.mockResolvedValue({
      auditId: "audit-2",
      outcome: "succeeded",
      acknowledged: true,
    });
  });

  it("executes an alert action through the shared executor with shop-derived deps", async () => {
    const res = await action({
      request: postForm(ALERT_FIELDS),
      params: {},
      context: {},
    } as never);
    const body = await (res as Response).json();
    expect(body.ok).toBe(true);
    expect(calderynClient).toHaveBeenCalledWith("s.myshopify.com");
    expect(executeInventoryAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({
        client: STUB_CLIENT,
        shopId: "shop-1",
        alertId: "al-1",
        kind: "reallocate_inventory",
        idempotencyKey: "idem-2",
      }),
    );
    expect(executeInventoryRelocation).not.toHaveBeenCalled();
  });

  it("snoozes via the same path and reports ok", async () => {
    executeInventoryAlertAction.mockResolvedValue({
      auditId: "audit-3",
      outcome: "succeeded",
      acknowledged: false,
    });
    const res = await action({
      request: postForm({ ...ALERT_FIELDS, kind: "snooze_alert" }),
      params: {},
      context: {},
    } as never);
    expect((await (res as Response).json()).ok).toBe(true);
    expect(executeInventoryAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "snooze_alert" }),
    );
  });

  it.each([
    ["missing alert id", { alert_id: "" }],
    ["missing idempotency key", { idempotency_key: "" }],
    ["disallowed kind", { kind: "create_po_draft" }],
    ["unknown kind", { kind: "delete_everything" }],
  ])("rejects %s at the boundary without executing", async (_n, patch) => {
    const res = await action({
      request: postForm({ ...ALERT_FIELDS, ...patch }),
      params: {},
      context: {},
    } as never);
    expect((res as Response).status).toBe(422);
    expect(executeInventoryAlertAction).not.toHaveBeenCalled();
  });

  it("maps CalderynError to its status, code, and an error toast", async () => {
    const { CalderynError } = await vi.importActual<typeof CalderynServer>(
      "../../lib/calderyn.server",
    );
    executeInventoryAlertAction.mockRejectedValue(
      new CalderynError({
        code: "guardrail_dollar_cap",
        status: 403,
        message: "Impact exceeds the per-action cap.",
      }),
    );
    const res = await action({
      request: postForm(ALERT_FIELDS),
      params: {},
      context: {},
    } as never);
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(403);
    expect(body.error.code).toBe("guardrail_dollar_cap");
    expect(body.toast.isError).toBe(true);
  });

  it("maps unexpected executor errors to a 500 with an error toast", async () => {
    executeInventoryAlertAction.mockRejectedValue(new Error("boom"));
    const res = await action({
      request: postForm(ALERT_FIELDS),
      params: {},
      context: {},
    } as never);
    expect((res as Response).status).toBe(500);
    expect((await (res as Response).json()).toast.isError).toBe(true);
  });
});
