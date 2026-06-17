import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAmountToCents,
  mapTransactionToNormalized,
  fetchShipBobCharges,
  type ShipBobTransaction,
} from "../shipbob.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── parseAmountToCents: decimal number|string → integer cents, no float drift ──
describe("parseAmountToCents", () => {
  it("parses a number and a string the same", () => {
    expect(parseAmountToCents(7.39)).toBe(739);
    expect(parseAmountToCents("7.39")).toBe(739);
  });
  it("avoids binary-float drift (0.29 → 29)", () => {
    expect(parseAmountToCents("0.29")).toBe(29);
    expect(parseAmountToCents(10.1)).toBe(1010);
  });
  it("rejects malformed / negative / null as null (skip, not coerce to 0 — rule 12)", () => {
    expect(parseAmountToCents(null)).toBeNull();
    expect(parseAmountToCents(undefined)).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("-1")).toBeNull();
  });
});

// ── mapTransactionToNormalized: ShipBob transaction → NormalizedShipmentCost ───
describe("mapTransactionToNormalized", () => {
  const base: ShipBobTransaction = {
    transaction_id: 90210,
    amount: "7.39",
    currency_code: "USD",
    charge_date: "2026-06-01T10:00:00Z",
    transaction_fee: "Shipping",
    reference_type: "Shipment",
    reference_id: "shp_1",
    order_reference_id: "#1001",
    additional_details: { tracking_id: "1Z999", carrier: "UPS" },
  };

  it("maps all fields, parsing amount to cents and stringifying a numeric id", () => {
    expect(mapTransactionToNormalized(base)).toEqual({
      externalId: "90210",
      orderRef: "#1001",
      trackingNo: "1Z999",
      costCents: 739,
      currency: "USD",
      shippedAt: "2026-06-01T10:00:00Z",
      carrier: "UPS",
    });
  });

  it("skips a non-shipping fee (storage/pick/pack are not a per-order ship cost)", () => {
    expect(mapTransactionToNormalized({ ...base, transaction_fee: "Storage" })).toBeNull();
    expect(mapTransactionToNormalized({ ...base, transaction_fee: "Pick Fee" })).toBeNull();
  });

  it("keeps a fuel/freight surcharge that reads as shipping-related", () => {
    expect(mapTransactionToNormalized({ ...base, transaction_fee: "Freight" })?.costCents).toBe(739);
  });

  it("assumes shipping when no fee category is present (does not silently drop a real charge)", () => {
    const { transaction_fee: _omit, ...noCat } = base;
    void _omit;
    expect(mapTransactionToNormalized(noCat as ShipBobTransaction)?.costCents).toBe(739);
  });

  it("skips a transaction with no id (cannot be an idempotency key)", () => {
    expect(mapTransactionToNormalized({ ...base, transaction_id: null })).toBeNull();
  });

  it("skips a transaction with an unparseable amount (surfaced as skip, not 0)", () => {
    expect(mapTransactionToNormalized({ ...base, amount: "oops" })).toBeNull();
  });

  it("falls back to tracking match when no order reference is present", () => {
    const r = mapTransactionToNormalized({ ...base, order_reference_id: null });
    expect(r?.orderRef).toBeNull();
    expect(r?.trackingNo).toBe("1Z999");
  });
});

// ── fetchShipBobCharges: Bearer auth, body window, pagination ──────────────────
function tx(id: number, amount = "5.00"): ShipBobTransaction {
  return {
    transaction_id: id,
    amount,
    currency_code: "USD",
    charge_date: "2026-06-03T00:00:00Z",
    transaction_fee: "Shipping",
    order_reference_id: `#${id}`,
    additional_details: { tracking_id: `trk_${id}` },
  };
}
function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}
function makeFetch(respond: (call: number) => Response) {
  let n = 0;
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> => Promise.resolve(respond(n++)));
}

describe("fetchShipBobCharges", () => {
  it("sends a Bearer PAT and the StartDate window in the POST body", async () => {
    const mockFetch = makeFetch(() => okResponse({ data: [] }));
    await fetchShipBobCharges("PAT_abc", "2026-06-01T00:00:00Z", mockFetch as unknown as typeof fetch);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/transactions:query");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer PAT_abc");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ Page: 1, PageSize: 100, StartDate: "2026-06-01T00:00:00Z" });
  });

  it("paginates until a short page, accumulating shipping charges", async () => {
    const full = { data: Array.from({ length: 100 }, (_v, i) => tx(i + 1)) };
    const tail = { data: [tx(101)] };
    const mockFetch = makeFetch((call) => okResponse(call === 0 ? full : tail));
    const out = await fetchShipBobCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((mockFetch.mock.calls[1][1] as RequestInit).body)).Page).toBe(2);
  });

  it("tolerates the {transactions:[...]} envelope as well as {data:[...]}", async () => {
    const mockFetch = makeFetch(() => okResponse({ transactions: [tx(7)] }));
    const out = await fetchShipBobCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["7"]);
  });

  it("throws with status + body snippet on a non-2xx (so the cron records sync_error)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "missing billing_read",
    } as Response));
    await expect(
      fetchShipBobCharges("bad", null, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/ShipBob 403 Forbidden: missing billing_read/);
  });
});
