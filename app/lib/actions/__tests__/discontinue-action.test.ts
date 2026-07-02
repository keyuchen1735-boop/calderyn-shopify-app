// app/lib/actions/__tests__/discontinue-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeDiscontinueAlertAction } from "../alert-action.server";
import type { Alert, AuditEntry, GuardrailConfig } from "../../types";

// Mock acknowledgeAlert so it doesn't hit real DB — matches alert-action.test.ts pattern
const acknowledgeAlert = vi.hoisted(() => vi.fn());
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: never[]) => acknowledgeAlert(...a),
}));

// Mock discontinueProduct so Shopify isn't called for real
const discontinueProduct = vi.hoisted(() => vi.fn());
vi.mock("../../shopify/product.server", () => ({
  discontinueProduct: (...a: never[]) => discontinueProduct(...a),
}));

// Mock resolveSkuForDiscontinue and setDoNotReorder
const resolveSkuForDiscontinue = vi.hoisted(() => vi.fn());
const setDoNotReorder = vi.hoisted(() => vi.fn());
vi.mock("../discontinue.server", () => ({
  resolveSkuForDiscontinue: (...a: never[]) => resolveSkuForDiscontinue(...a),
  setDoNotReorder: (...a: never[]) => setDoNotReorder(...a),
}));

const ADMIN_OK = {
  graphql: vi.fn(async () => ({
    json: async () => ({
      data: { productUpdate: { product: { id: "gid://shopify/Product/9", status: "ARCHIVED" }, userErrors: [] } },
    }),
  }) as unknown as Response),
};

function alert(p: Partial<Alert>): Alert {
  const base: Alert = {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 50000,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "n",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: {},
    remediation: null,
    rec_detail: "",
  };
  return Object.assign(base, p);
}

function client(a: Alert, cap = 100000): {
  alerts: { get: ReturnType<typeof vi.fn> };
  guardrails: { get: ReturnType<typeof vi.fn> };
  actions: { execute: ReturnType<typeof vi.fn> };
} {
  return {
    alerts: { get: vi.fn(async () => a) },
    guardrails: { get: vi.fn(async () => ({ dollar_cap_cents: cap }) as GuardrailConfig) },
    actions: {
      execute: vi.fn(async () => ({ id: "au1", outcome: "succeeded" }) as unknown as AuditEntry),
    },
  };
}

// sku_dim resolver mock: sb shape only needed for the real resolveSkuForDiscontinue/setDoNotReorder
// but since those are mocked, sb is a minimal stub here.
const SB_STUB = {} as never;

describe("executeDiscontinueAlertAction", () => {
  const base = {
    shopId: "shop-1",
    alertId: "a1",
    kind: "discontinue_sku" as const,
    idempotencyKey: "idem-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSkuForDiscontinue.mockResolvedValue({
      skuId: "sku-1",
      productGid: "gid://shopify/Product/9",
      alreadyFlagged: false,
    });
    setDoNotReorder.mockResolvedValue(undefined);
    acknowledgeAlert.mockResolvedValue(true);
    discontinueProduct.mockResolvedValue({
      productId: "gid://shopify/Product/9",
      status: "ARCHIVED",
      previousStatus: null,
    });
  });

  it("happy path: sets flag, archives product, writes audit, acknowledges", async () => {
    const a = alert({});
    const c = client(a);
    const res = await executeDiscontinueAlertAction({ ...base, client: c as never, admin: ADMIN_OK, sb: SB_STUB });
    expect(discontinueProduct).toHaveBeenCalledWith(ADMIN_OK, "gid://shopify/Product/9");
    expect(setDoNotReorder).toHaveBeenCalledWith(SB_STUB, "shop-1", "sku-1", true);
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "a1", kind: "discontinue_sku", idempotencyKey: "idem-1" }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("rejects a non-open alert with 409", async () => {
    const a = alert({ status: "acknowledged" });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: SB_STUB }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects when discontinue_sku is not allowed for the detector (403)", async () => {
    const a = alert({ detector_id: "sku_stockout_vs_spend" });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: SB_STUB }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects when the SKU has no Shopify product GID (no dead button — surfaces why)", async () => {
    resolveSkuForDiscontinue.mockResolvedValue({
      skuId: "sku-1",
      productGid: null,
      alreadyFlagged: false,
    });
    const a = alert({});
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: SB_STUB }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects when impact exceeds the guardrail dollar cap (403)", async () => {
    const a = alert({ dollar_impact: 999999 });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a, 100000) as never, admin: ADMIN_OK, sb: SB_STUB }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back the flag and throws 502 when Shopify archive fails", async () => {
    discontinueProduct.mockRejectedValue(new Error("throttled by Shopify"));
    const a = alert({});
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: SB_STUB }),
    ).rejects.toMatchObject({ status: 502 });
    // Flag was set true then rolled back to false
    expect(setDoNotReorder).toHaveBeenCalledTimes(2);
    expect(setDoNotReorder).toHaveBeenNthCalledWith(1, SB_STUB, "shop-1", "sku-1", true);
    expect(setDoNotReorder).toHaveBeenNthCalledWith(2, SB_STUB, "shop-1", "sku-1", false);
  });
});
