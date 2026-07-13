// Tests for the label-purchase orchestration (shipping deferred D2): fail-closed
// preconditions, parcel assembly from OPEN units only, and the shipment-id idempotency
// (replay short-circuit) that makes a double-spend impossible. EasyPost rides the
// injectable adapter seam; the fulfillment executor and the heavy read models are mocked.
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory PostgREST stand-in: enough of the builder surface for label.server's reads
// (select/eq/in/maybeSingle) and the post-buy label persist (update/eq).
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    integration_credentials: [],
    order_line: [],
    variant_shipping: [],
    fulfillment: [],
  };

  class Builder {
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private patch: Row | null = null;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select() {
      return this;
    }
    update(patch: Row) {
      this.patch = patch;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push([col, vals]);
      return this;
    }
    private rows(): Row[] {
      return db[this.table].filter(
        (r) =>
          this.filters.every(([c, v]) => r[c] === v) &&
          this.inFilters.every(([c, vals]) => vals.includes(r[c])),
      );
    }
    maybeSingle() {
      return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
    }
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      if (this.patch) {
        for (const r of this.rows()) Object.assign(r, this.patch);
        return resolve({ data: [], error: null });
      }
      return resolve({ data: this.rows(), error: null });
    }
  }
  return { db, client: { from: (t: string) => new Builder(t) } };
});

const executeFulfillAction = vi.fn();
const loadRemainingByLine = vi.fn();
const loadDefaultShippingAddress = vi.fn();
const getShopOrigin = vi.fn();

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: (v: string) => `decrypted:${v}` }));
vi.mock("~/lib/commerce/origin.server", () => ({ getShopOrigin: (...a: unknown[]) => getShopOrigin(...a) }));
vi.mock("./detail.server", () => ({
  loadDefaultShippingAddress: (...a: unknown[]) => loadDefaultShippingAddress(...a),
}));
vi.mock("./fulfill.server", () => ({
  executeFulfillAction: (...a: unknown[]) => executeFulfillAction(...a),
  loadRemainingByLine: (...a: unknown[]) => loadRemainingByLine(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { buyLabelAndFulfill, quoteLabelRates } from "./label.server";
// eslint-disable-next-line import/first
import { LabelPurchaseError } from "~/lib/ship-cost/adapters/easypost-label.server";

const SHOP = "shop-1";
const ORDER = "ord-1";
const ADDRESS = {
  name: "Buyer",
  line1: "99 Elm St",
  line2: null,
  city: "Seattle",
  region: "WA",
  postal: "98101",
  country: "US",
};
const ORIGIN = { street1: "1 Main St", city: "Portland", state: "OR", zip: "97201", country: "US" };

const PURCHASED = {
  shipmentId: "shp_1",
  labelUrl: "https://labels.example/shp_1.png",
  labelCostCents: 739,
  trackingNumber: "9400111899",
  carrier: "USPS",
  service: "Priority",
  reference: `order:${ORDER}`,
};

function adapter(over: Partial<{ create: any; buy: any; retrieve: any }> = {}) {
  return {
    create: over.create ?? vi.fn(async () => ({ shipmentId: "shp_1", rates: [{ id: "rate_a", carrier: "USPS", service: "Priority", amountCents: 739, estDeliveryDays: 2 }] })),
    buy: over.buy ?? vi.fn(async () => PURCHASED),
    // Default pre-buy state: the shipment belongs to this order and is unbought.
    retrieve: over.retrieve ?? vi.fn(async () => ({ reference: `order:${ORDER}`, purchased: null })),
  };
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  store.db.orders.push({ id: ORDER, shop_id: SHOP, state: "paid", buyer_id: "buyer-1", shipping_service: "USPS Priority" });
  store.db.integration_credentials.push({ shop_id: SHOP, kind: "easypost_ship", access_token_encrypted: "enc" });
  store.db.order_line.push({ id: "line-1", shop_id: SHOP, order_id: ORDER, variant_id: "var-1" });
  store.db.variant_shipping.push({
    shop_id: SHOP,
    variant_id: "var-1",
    weight_grams: 500,
    length_mm: 254,
    width_mm: 203,
    height_mm: 102,
    signature_required: false,
  });
  loadRemainingByLine.mockResolvedValue({
    orderLines: [{ id: "line-1", quantity: 2, variantId: "var-1", title: "Cotton Tee" }],
    remaining: new Map([["line-1", 2]]),
  });
  loadDefaultShippingAddress.mockResolvedValue(ADDRESS);
  getShopOrigin.mockResolvedValue(ORIGIN);
  executeFulfillAction.mockResolvedValue({
    auditId: "audit-1",
    fulfillmentId: "ful-1",
    orderState: "fulfilled",
    fulfilledUnits: 2,
    notified: true,
    replayed: false,
  });
});

describe("quoteLabelRates", () => {
  it("creates the shipment from open units: summed weight, order reference, buyer address", async () => {
    const a = adapter();
    const created = await quoteLabelRates(SHOP, ORDER, undefined, a);
    expect(created.shipmentId).toBe("shp_1");
    const input = a.create.mock.calls[0][1];
    expect(input.reference).toBe(`order:${ORDER}`);
    expect(input.destination.street1).toBe("99 Elm St");
    expect(input.origin).toEqual(ORIGIN);
    expect(input.signature).toBe(false);
    // 500 g ≈ 17.64 oz per unit, 2 open units.
    expect(input.parcel.weightOz).toBeCloseTo(500 * 0.0352739619 * 2, 5);
    expect(input.parcel.lengthIn).toBeCloseTo(10, 3);
  });

  it("rates the parcel for the SELECTED units, not everything open", async () => {
    const a = adapter();
    await quoteLabelRates(SHOP, ORDER, [{ orderLineId: "line-1", quantity: 1 }], a);
    // 1 selected unit of the 2 open.
    expect(a.create.mock.calls[0][1].parcel.weightOz).toBeCloseTo(500 * 0.0352739619, 5);
  });

  it("rejects a selection exceeding what is open (fail closed, no shipment created)", async () => {
    const a = adapter();
    await expect(
      quoteLabelRates(SHOP, ORDER, [{ orderLineId: "line-1", quantity: 3 }], a),
    ).rejects.toMatchObject({ code: "over_fulfil" });
    await expect(
      quoteLabelRates(SHOP, ORDER, [{ orderLineId: "ghost", quantity: 1 }], a),
    ).rejects.toMatchObject({ code: "line_not_on_order" });
    expect(a.create).not.toHaveBeenCalled();
  });

  it("requests signature when any open line's variant requires it", async () => {
    store.db.variant_shipping[0].signature_required = true;
    const a = adapter();
    await quoteLabelRates(SHOP, ORDER, undefined, a);
    expect(a.create.mock.calls[0][1].signature).toBe(true);
  });

  it("fails closed BEFORE any carrier call: pickup order, no credential, no address", async () => {
    const a = adapter();

    store.db.orders[0].shipping_service = "Store pickup";
    await expect(quoteLabelRates(SHOP, ORDER, undefined, a)).rejects.toMatchObject({ code: "pickup_order" });
    store.db.orders[0].shipping_service = "USPS Priority";

    store.db.integration_credentials.length = 0;
    await expect(quoteLabelRates(SHOP, ORDER, undefined, a)).rejects.toMatchObject({ code: "no_label_carrier" });
    store.db.integration_credentials.push({ shop_id: SHOP, kind: "easypost_ship", access_token_encrypted: "enc" });

    loadDefaultShippingAddress.mockResolvedValueOnce(null);
    await expect(quoteLabelRates(SHOP, ORDER, undefined, a)).rejects.toMatchObject({ code: "no_shipping_address" });

    expect(a.create).not.toHaveBeenCalled();
  });

  it("names the unweighted items instead of buying an underweight label", async () => {
    store.db.variant_shipping[0].weight_grams = 0;
    const a = adapter();
    const err = await quoteLabelRates(SHOP, ORDER, undefined, a).catch((e) => e);
    expect(err).toMatchObject({ code: "no_parcel_weight" });
    expect(err.message).toContain("Cotton Tee");
    expect(a.create).not.toHaveBeenCalled();
  });

  it("refuses a non-fulfillable order state", async () => {
    store.db.orders[0].state = "fulfilled";
    await expect(quoteLabelRates(SHOP, ORDER, undefined, adapter())).rejects.toMatchObject({
      code: "order_not_fulfillable",
    });
  });
});

describe("buyLabelAndFulfill", () => {
  const INPUT = {
    orderId: ORDER,
    shipmentId: "shp_1",
    rateId: "rate_a",
    notify: true,
    idempotencyKey: "idem-1",
  };

  it("buys, fulfills with the label's tracking, and persists the label on the fulfillment", async () => {
    store.db.fulfillment.push({ id: "ful-1", shop_id: SHOP, order_id: ORDER, easypost_shipment_id: null });
    const a = adapter();
    const res = await buyLabelAndFulfill(SHOP, INPUT, a);

    expect(a.buy).toHaveBeenCalledWith("decrypted:enc", "shp_1", "rate_a", `order:${ORDER}`);
    expect(executeFulfillAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        orderId: ORDER,
        trackingNumber: "9400111899",
        carrier: "USPS",
        notify: true,
        idempotencyKey: "idem-1",
      }),
      expect.anything(),
    );
    expect(res.labelUrl).toBe(PURCHASED.labelUrl);
    expect(res.labelCostCents).toBe(739);
    // The label landed on the fulfillment row (idempotency anchor for replays).
    expect(store.db.fulfillment[0].easypost_shipment_id).toBe("shp_1");
    expect(store.db.fulfillment[0].label_url).toBe(PURCHASED.labelUrl);
  });

  it("replays without touching EasyPost when a fulfillment already carries this shipment", async () => {
    store.db.fulfillment.push({
      id: "ful-9",
      shop_id: SHOP,
      order_id: ORDER,
      easypost_shipment_id: "shp_1",
      label_url: "https://labels.example/shp_1.png",
      label_cost_cents: 739,
      tracking_number: "9400111899",
      carrier: "USPS",
    });
    const a = adapter();
    const res = await buyLabelAndFulfill(SHOP, INPUT, a);
    expect(res.replayed).toBe(true);
    expect(res.labelUrl).toBe("https://labels.example/shp_1.png");
    expect(a.buy).not.toHaveBeenCalled();
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("refuses a shipment id already claimed by a DIFFERENT order (409, no spend)", async () => {
    store.db.fulfillment.push({
      id: "ful-8",
      shop_id: SHOP,
      order_id: "other-order",
      easypost_shipment_id: "shp_1",
      label_url: "x",
    });
    const a = adapter();
    await expect(buyLabelAndFulfill(SHOP, INPUT, a)).rejects.toMatchObject({ code: "shipment_mismatch" });
    expect(a.buy).not.toHaveBeenCalled();
  });

  it("verifies shipment ownership BEFORE buying: a foreign reference is refused with NO spend", async () => {
    const a = adapter({
      retrieve: vi.fn(async () => ({ reference: "order:someone-else", purchased: null })),
    });
    await expect(buyLabelAndFulfill(SHOP, INPUT, a)).rejects.toMatchObject({ code: "shipment_mismatch" });
    expect(a.buy).not.toHaveBeenCalled();
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("recovers an earlier crashed attempt's purchase: retrieve finds the label, buy is never re-run", async () => {
    store.db.fulfillment.push({ id: "ful-1", shop_id: SHOP, order_id: ORDER, easypost_shipment_id: null });
    const a = adapter({
      retrieve: vi.fn(async () => ({ reference: `order:${ORDER}`, purchased: PURCHASED })),
    });
    const res = await buyLabelAndFulfill(SHOP, INPUT, a);
    expect(a.buy).not.toHaveBeenCalled(); // money moved once, on the crashed attempt
    expect(res.labelUrl).toBe(PURCHASED.labelUrl);
    expect(executeFulfillAction).toHaveBeenCalledTimes(1);
    expect(store.db.fulfillment[0].easypost_shipment_id).toBe("shp_1");
  });

  it("maps a carrier buy failure to a typed error (fail closed, no fulfillment)", async () => {
    const a = adapter({
      buy: vi.fn(async () => {
        throw new LabelPurchaseError("carrier_error", "insufficient funds");
      }),
    });
    const err = await buyLabelAndFulfill(SHOP, INPUT, a).catch((e) => e);
    expect(err).toMatchObject({ code: "label_carrier_error" });
    expect(err.message).toContain("insufficient funds");
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("rejects an over-open line selection BEFORE the buy (fail closed, no spend)", async () => {
    const a = adapter();
    await expect(
      buyLabelAndFulfill(SHOP, { ...INPUT, lines: [{ orderLineId: "line-1", quantity: 3 }] }, a),
    ).rejects.toMatchObject({ code: "over_fulfil" });
    expect(a.buy).not.toHaveBeenCalled();
  });

  it("surfaces a fulfillment failure AFTER the buy with the label in the error (money moved — never buried)", async () => {
    executeFulfillAction.mockRejectedValueOnce(new Error("coverage race"));
    const a = adapter();
    const err = await buyLabelAndFulfill(SHOP, INPUT, a).catch((e) => e);
    expect(err).toMatchObject({ code: "label_bought_fulfill_failed" });
    expect(err.message).toContain(PURCHASED.labelUrl); // the merchant can recover the paid label
    expect(err.message).toContain("9400111899");
    expect(a.buy).toHaveBeenCalledTimes(1);
  });
});
