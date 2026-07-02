// app/lib/actions/__tests__/adjust-price-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAdjustPriceAlertAction } from "../adjust-price.server";
import type { Alert, AuditEntry, GuardrailConfig } from "../../types";
import type * as CutoverOrgMode from "../../cutover/org-mode.server";

const acknowledgeAlert = vi.hoisted(() => vi.fn());
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: never[]) => acknowledgeAlert(...a),
}));

const readVariantPrice = vi.hoisted(() => vi.fn());
const setVariantPrice = vi.hoisted(() => vi.fn());
vi.mock("../../shopify/price.server", () => ({
  readVariantPrice: (...a: never[]) => readVariantPrice(...a),
  setVariantPrice: (...a: never[]) => setVariantPrice(...a),
}));

const getCurrentUnitCostCents = vi.hoisted(() => vi.fn());
vi.mock("../../po/draft.server", () => ({
  getCurrentUnitCostCents: (...a: never[]) => getCurrentUnitCostCents(...a),
}));

const getOrgMode = vi.hoisted(() => vi.fn());
vi.mock("../../cutover/org-mode.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CutoverOrgMode>()),
  getOrgMode: (...a: never[]) => getOrgMode(...a),
}));

const getOwnedVariantPricing = vi.hoisted(() => vi.fn());
const setOwnedVariantPrice = vi.hoisted(() => vi.fn());
vi.mock("../owned-writes.server", () => ({
  getOwnedVariantPricing: (...a: never[]) => getOwnedVariantPricing(...a),
  setOwnedVariantPrice: (...a: never[]) => setOwnedVariantPrice(...a),
}));

const ADMIN = { graphql: vi.fn() } as never;

function alert(p: Partial<Alert>): Alert {
  const base: Alert = {
    id: "a1",
    detector_id: "margin_erosion",
    severity: "high",
    status: "open",
    dollar_impact: 5000,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "n",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: { baseline_unit_margin_usd: 9, current_unit_margin_usd: 7 },
    remediation: null,
    rec_detail: "",
  };
  return Object.assign(base, p);
}

function client(a: Alert, opts: { dollarCap?: number; maxPricePct?: number } = {}) {
  return {
    alerts: { get: vi.fn(async () => a) },
    guardrails: {
      get: vi.fn(
        async () =>
          ({
            dollar_cap_cents: opts.dollarCap ?? 100000,
            max_price_change_pct: opts.maxPricePct ?? 15,
          }) as GuardrailConfig,
      ),
    },
    actions: {
      execute: vi.fn(async () => ({ id: "au1", outcome: "succeeded" }) as unknown as AuditEntry),
    },
  };
}

/** sku_dim resolver stub: one maybeSingle() returning id + external_id (variant gid). */
function sb(row: { id: string; external_id: string } | null) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: row, error: null });
  return { from: () => chain } as never;
}

const VARIANT = "gid://shopify/ProductVariant/123";
const PRODUCT = "gid://shopify/Product/9";

describe("executeAdjustPriceAlertAction", () => {
  const base = {
    shopId: "shop-1",
    alertId: "a1",
    kind: "adjust_price" as const,
    idempotencyKey: "idem-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeAlert.mockResolvedValue(true);
    readVariantPrice.mockResolvedValue({ priceCents: 1500, productGid: PRODUCT });
    // Echo the requested price so assertions reflect what was actually applied.
    setVariantPrice.mockImplementation(async (_admin: unknown, input: { variantId: string; newPriceCents: number }) => ({
      variantId: input.variantId,
      priceCents: input.newPriceCents,
    }));
    getCurrentUnitCostCents.mockResolvedValue(800);
    getOrgMode.mockResolvedValue("mirror");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    setOwnedVariantPrice.mockResolvedValue({ priorPriceCents: 1500 });
  });

  const okSb = () => sb({ id: "sku-1", external_id: VARIANT });
  const run = (a: Alert, extra: Record<string, unknown> = {}) =>
    executeAdjustPriceAlertAction({ ...base, client: client(a) as never, admin: ADMIN, sb: okSb(), ...extra });

  it("happy path: restores margin, writes the price to Shopify, audits prior+new price, acknowledges", async () => {
    const a = alert({});
    const c = client(a);
    const res = await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: sb({ id: "sku-1", external_id: VARIANT }),
    });

    // Restored price = COGS $8 + baseline margin $9 = $17, applied to the variant.
    expect(setVariantPrice).toHaveBeenCalledWith(ADMIN, {
      productGid: PRODUCT,
      variantId: VARIANT,
      newPriceCents: 1700,
    });
    // Audit row carries everything undo needs: variant, product, prior + new price.
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: "a1",
        kind: "adjust_price",
        idempotencyKey: "idem-1",
        params: expect.objectContaining({
          variant_id: VARIANT,
          product_id: PRODUCT,
          prior_price_cents: 1500,
          new_price_cents: 1700,
        }),
      }),
    );
    expect(res).toMatchObject({ auditId: "au1", outcome: "succeeded", acknowledged: true });
  });

  it("applies a merchant-confirmed price that is within the ±cap", async () => {
    const c = client(alert({}));
    const res = await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
      newPriceCents: 1650, // within ±15% of $15.00 → [$12.75, $17.25]
    });
    expect(setVariantPrice).toHaveBeenCalledWith(
      ADMIN,
      expect.objectContaining({ newPriceCents: 1650 }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("rejects a merchant price beyond the ±cap (422) and never calls Shopify", async () => {
    await expect(run(alert({}), { newPriceCents: 2000 })).rejects.toMatchObject({ status: 422 });
    expect(setVariantPrice).not.toHaveBeenCalled();
  });

  it("rejects a merchant override at/below unit cost — never sell at a loss (422)", async () => {
    // Cost $14, current price $15, cap 15% → min $12.75. $13.00 is within the cap
    // but below cost; the restore-margin action must refuse it.
    getCurrentUnitCostCents.mockResolvedValue(1400);
    await expect(run(alert({}), { newPriceCents: 1300 })).rejects.toMatchObject({ status: 422 });
    expect(setVariantPrice).not.toHaveBeenCalled();
  });

  it("rejects when no margin-restoring price is computable and none was provided (422)", async () => {
    await expect(run(alert({ evidence: {} }))).rejects.toMatchObject({ status: 422 });
    expect(setVariantPrice).not.toHaveBeenCalled();
  });

  it("rejects a non-open alert (409)", async () => {
    await expect(run(alert({ status: "acknowledged" }))).rejects.toMatchObject({ status: 409 });
  });

  it("rejects adjust_price on a detector that doesn't allow it (403)", async () => {
    await expect(run(alert({ detector_id: "sku_stockout_vs_spend" }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects when impact exceeds the dollar cap (403)", async () => {
    const c = client(alert({ dollar_impact: 999999 }), { dollarCap: 100000 });
    await expect(
      executeAdjustPriceAlertAction({ ...base, client: c as never, admin: ADMIN, sb: okSb() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects when the SKU has no linked Shopify variant (422)", async () => {
    await expect(
      executeAdjustPriceAlertAction({ ...base, client: client(alert({})) as never, admin: ADMIN, sb: sb(null) }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("surfaces a Shopify write failure as 502, not a fake success", async () => {
    setVariantPrice.mockRejectedValue(new Error("throttled by Shopify"));
    await expect(run(alert({}))).rejects.toMatchObject({ status: 502 });
  });

  // ── actor / triggerReason wiring ─────────────────────────────────

  it("persists actor='autopilot' to the audit row's actor field", async () => {
    const a = alert({});
    const c = client(a);
    await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
      actor: "autopilot",
    });
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "autopilot" }),
    );
  });

  it("persists triggerReason to the audit row when passed", async () => {
    const a = alert({});
    const c = client(a);
    const reason = "Auto-price: Margin erosion — $50.00 at stake";
    await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
      actor: "autopilot",
      triggerReason: reason,
    });
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ triggerReason: reason }),
    );
  });

  it("omitting actor/triggerReason leaves them absent — manual path unchanged", async () => {
    const a = alert({});
    const c = client(a);
    await executeAdjustPriceAlertAction({ ...base, client: c as never, admin: ADMIN, sb: okSb() });
    // Use expect.not.objectContaining to assert absence without relying on mock.calls typing
    expect(c.actions.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.anything() }),
    );
    expect(c.actions.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ triggerReason: expect.anything() }),
    );
  });
});

describe("executeAdjustPriceAlertAction — org_mode routing", () => {
  const base = {
    shopId: "shop-1",
    alertId: "a1",
    kind: "adjust_price" as const,
    idempotencyKey: "idem-1",
  };
  const okSb = () => sb({ id: "sku-1", external_id: VARIANT });

  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeAlert.mockResolvedValue(true);
    readVariantPrice.mockResolvedValue({ priceCents: 1500, productGid: PRODUCT });
    setVariantPrice.mockImplementation(async (_admin: unknown, input: { variantId: string; newPriceCents: number }) => ({
      variantId: input.variantId,
      priceCents: input.newPriceCents,
    }));
    getCurrentUnitCostCents.mockResolvedValue(800);
    getOrgMode.mockResolvedValue("mirror");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    setOwnedVariantPrice.mockResolvedValue({ priorPriceCents: 1500 });
  });

  it("mirror: writes to Shopify, never the owned column", async () => {
    getOrgMode.mockResolvedValue("mirror");
    await executeAdjustPriceAlertAction({
      ...base,
      client: client(alert({})) as never,
      admin: ADMIN,
      sb: okSb(),
    });
    expect(setVariantPrice).toHaveBeenCalled(); // Shopify write
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
  });

  it("live: writes the owned column, never Shopify, cap anchored on owned price", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    const c = client(alert({}));
    const res = await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
    });
    // Restored price = COGS $8 + baseline margin $9 = $17 on the owned variant id.
    expect(setOwnedVariantPrice).toHaveBeenCalledWith("shop-1", "sku-1", 1700);
    expect(setVariantPrice).not.toHaveBeenCalled(); // Shopify untouched
    expect(readVariantPrice).not.toHaveBeenCalled();
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          owned: true, // routes undo to the owned catalog, never Shopify
          variant_id: "sku-1",
          sku_id: "sku-1",
          prior_price_cents: 1500,
          new_price_cents: 1700,
        }),
      }),
    );
    // The owned branch deliberately omits product_id (a Shopify handle it never touched);
    // undo routes on `owned: true` instead. Lock that so a future edit can't silently add
    // a Shopify handle to an owned-only audit row.
    expect(c.actions.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ product_id: expect.anything() }),
      }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("dual_run: writes Shopify AND mirrors the applied price into the owned catalog", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    const c = client(alert({}));
    const res = await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
    });
    expect(setVariantPrice).toHaveBeenCalled(); // Shopify stays authoritative
    expect(setOwnedVariantPrice).toHaveBeenCalledWith("shop-1", "sku-1", 1700);
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          dual_write: "ok",
          owned_variant_id: "sku-1",
          product_id: PRODUCT,
        }),
      }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("dual_run: a failed owned mirror never fails the action, recorded on the audit", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    setOwnedVariantPrice.mockRejectedValue(new Error("owned write refused"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = client(alert({}));
    try {
      const res = await executeAdjustPriceAlertAction({
        ...base,
        client: c as never,
        admin: ADMIN,
        sb: okSb(),
      });
      expect(res.outcome).toBe("succeeded");
    } finally {
      consoleError.mockRestore();
    }
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ dual_write: "failed: owned write refused" }),
      }),
    );
  });

  it("dual_run: a SKU with no owned price records a skipped mirror", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    getOwnedVariantPricing.mockResolvedValue(null);
    const c = client(alert({}));
    await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
    });
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ dual_write: "skipped_no_owned_price" }),
      }),
    );
  });

  it("live: rejects a merchant override beyond the ±cap of the owned price (422)", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    await expect(
      executeAdjustPriceAlertAction({
        ...base,
        client: client(alert({})) as never,
        admin: ADMIN,
        sb: okSb(),
        newPriceCents: 2000, // > +15% of $15.00
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
    expect(setVariantPrice).not.toHaveBeenCalled();
  });

  it("live: rejects when the SKU has no owned price (422)", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue(null);
    await expect(
      executeAdjustPriceAlertAction({
        ...base,
        client: client(alert({})) as never,
        admin: ADMIN,
        sb: okSb(),
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
  });
});
