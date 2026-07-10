// Contract tests for the EasyPost label adapter (shipping deferred D2). All carrier I/O
// rides an injectable fetch — no network. The money-path invariants under test: fail
// closed on every ambiguity, one purchase per shipment (already-purchased falls back to
// retrieve, never re-buys), and the order reference must round-trip or the buy dies.
import { describe, it, expect, vi } from "vitest";
import {
  buyShipmentRate,
  createLabelShipment,
  LabelPurchaseError,
  retrievePurchasedShipment,
} from "../easypost-label.server";

const ORIGIN = { street1: "1 Main St", city: "Portland", state: "OR", zip: "97201", country: "US" };
const DEST = { street1: "99 Elm St", city: "Seattle", state: "WA", zip: "98101", country: "US" };
const PARCEL = { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 12 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PURCHASED_SHIPMENT = {
  id: "shp_1",
  reference: "order:ord_1",
  tracking_code: "9400111899",
  selected_rate: { rate: "7.39", carrier: "USPS", service: "Priority" },
  postage_label: { label_url: "https://labels.example/shp_1.png" },
};

describe("createLabelShipment", () => {
  it("posts origin/destination/parcel + reference, maps rates sorted cheapest-first", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(201, {
        id: "shp_1",
        rates: [
          { id: "rate_b", carrier: "UPS", service: "Ground", rate: "9.10", est_delivery_days: 4 },
          { id: "rate_a", carrier: "USPS", service: "Priority", rate: "7.39", delivery_days: 2 },
          { id: "rate_bad", carrier: "FedEx", service: "2Day", rate: "junk" }, // dropped, never coerced to 0
        ],
      });
    });

    const created = await createLabelShipment(
      "test-key",
      { origin: ORIGIN, destination: DEST, parcel: PARCEL, signature: false, reference: "order:ord_1" },
      fetchImpl as unknown as typeof fetch,
    );

    const shipment = (captured as { shipment: Record<string, unknown> }).shipment;
    expect(shipment.reference).toBe("order:ord_1");
    expect(shipment.options).toBeUndefined(); // no signature requested
    expect((shipment.parcel as Record<string, unknown>).weight).toBe(12);
    expect(created.shipmentId).toBe("shp_1");
    expect(created.rates.map((r) => r.id)).toEqual(["rate_a", "rate_b"]);
    expect(created.rates[0]).toEqual({
      id: "rate_a",
      carrier: "USPS",
      service: "Priority",
      amountCents: 739,
      estDeliveryDays: 2,
    });
  });

  it("requests signature confirmation when any line's variant requires it", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(201, { id: "shp_1", rates: [{ id: "r1", carrier: "USPS", service: "P", rate: "5.00" }] });
    });
    await createLabelShipment(
      "test-key",
      { origin: ORIGIN, destination: DEST, parcel: PARCEL, signature: true, reference: "order:ord_1" },
      fetchImpl as unknown as typeof fetch,
    );
    const shipment = (captured as { shipment: Record<string, unknown> }).shipment;
    expect(shipment.options).toEqual({ delivery_confirmation: "SIGNATURE" });
  });

  it("fails closed on a carrier error and on a shipment with no buyable rates", async () => {
    const err500 = vi.fn(async () => jsonResponse(500, { error: { message: "boom" } }));
    await expect(
      createLabelShipment(
        "k",
        { origin: ORIGIN, destination: DEST, parcel: PARCEL, signature: false, reference: "order:o" },
        err500 as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "carrier_error" });

    const noRates = vi.fn(async () => jsonResponse(201, { id: "shp_1", rates: [] }));
    await expect(
      createLabelShipment(
        "k",
        { origin: ORIGIN, destination: DEST, parcel: PARCEL, signature: false, reference: "order:o" },
        noRates as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "no_rates" });
  });
});

describe("buyShipmentRate", () => {
  it("buys the rate and returns the label with tracking + integer-cents cost", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, PURCHASED_SHIPMENT));
    const label = await buyShipmentRate("k", "shp_1", "rate_a", "order:ord_1", fetchImpl as unknown as typeof fetch);
    expect(label).toEqual({
      shipmentId: "shp_1",
      labelUrl: "https://labels.example/shp_1.png",
      labelCostCents: 739,
      trackingNumber: "9400111899",
      carrier: "USPS",
      service: "Priority",
      reference: "order:ord_1",
    });
  });

  it("fails CLOSED when the shipment references a different order (never spends against the wrong order)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ...PURCHASED_SHIPMENT, reference: "order:SOMEONE_ELSE" }));
    await expect(
      buyShipmentRate("k", "shp_1", "rate_a", "order:ord_1", fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "shipment_mismatch" });
  });

  it("recovers the existing label on 'already purchased' via retrieve — no second spend", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, { error: { message: "This shipment has already been purchased." } });
      }
      expect(String(url)).toContain("/shipments/shp_1");
      return jsonResponse(200, PURCHASED_SHIPMENT);
    });
    const label = await buyShipmentRate("k", "shp_1", "rate_a", "order:ord_1", fetchImpl as unknown as typeof fetch);
    expect(label.labelUrl).toBe("https://labels.example/shp_1.png");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one failed buy, one GET — never a second buy
  });

  it("propagates any other carrier failure as a typed error (fail closed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { error: { message: "insufficient funds" } }));
    const err = await buyShipmentRate("k", "shp_1", "rate_a", "order:ord_1", fetchImpl as unknown as typeof fetch).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LabelPurchaseError);
    expect(err.code).toBe("carrier_error");
    expect(err.message).toContain("insufficient funds");
  });
});

describe("retrievePurchasedShipment", () => {
  it("throws not_purchased for a shipment without a label (retry must not fabricate success)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "shp_1", reference: "order:ord_1" }));
    await expect(retrievePurchasedShipment("k", "shp_1", fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: "not_purchased",
    });
  });
});
