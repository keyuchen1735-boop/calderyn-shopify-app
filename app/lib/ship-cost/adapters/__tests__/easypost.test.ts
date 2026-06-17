import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseRateToCents,
  mapShipmentToNormalized,
  fetchEasyPostCharges,
  type EasyPostShipment,
} from "../easypost.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── parseRateToCents: decimal STRING → integer cents, no float drift ──────────
describe("parseRateToCents", () => {
  it('parses "7.39" to 739 cents', () => {
    expect(parseRateToCents("7.39")).toBe(739);
  });

  it("parses a whole-dollar string and zero", () => {
    expect(parseRateToCents("12")).toBe(1200);
    expect(parseRateToCents("0")).toBe(0);
    expect(parseRateToCents("0.00")).toBe(0);
  });

  it("avoids binary-float drift (0.29 → 29, not 28)", () => {
    // 0.29 * 100 === 28.999999999999996 in IEEE-754; Math.round rescues it to 29.
    expect(parseRateToCents("0.29")).toBe(29);
    expect(parseRateToCents("10.10")).toBe(1010);
  });

  it("rejects malformed / negative / null as null (skip, not coerce to 0 — rule 12)", () => {
    expect(parseRateToCents(null)).toBeNull();
    expect(parseRateToCents(undefined)).toBeNull();
    expect(parseRateToCents("")).toBeNull();
    expect(parseRateToCents("abc")).toBeNull();
    expect(parseRateToCents("-1.00")).toBeNull();
    expect(parseRateToCents("1.2.3")).toBeNull();
  });
});

// ── mapShipmentToNormalized: EasyPost Shipment → NormalizedShipmentCost ───────
describe("mapShipmentToNormalized", () => {
  const base: EasyPostShipment = {
    id: "shp_abc",
    reference: "#1001",
    tracking_code: "1Z999",
    created_at: "2026-06-01T10:00:00Z",
    selected_rate: { rate: "7.39", currency: "USD", carrier: "USPS" },
  };

  it("maps all fields, parsing selected_rate.rate to cents", () => {
    expect(mapShipmentToNormalized(base)).toEqual({
      externalId: "shp_abc",
      orderRef: "#1001",
      trackingNo: "1Z999",
      costCents: 739,
      currency: "USD",
      shippedAt: "2026-06-01T10:00:00Z",
      carrier: "USPS",
    });
  });

  it("skips a shipment with no selected_rate (created but no rate bought)", () => {
    expect(mapShipmentToNormalized({ ...base, selected_rate: null })).toBeNull();
  });

  it("skips a shipment with an unparseable rate (surfaced as skip, not 0)", () => {
    expect(mapShipmentToNormalized({ ...base, selected_rate: { rate: "oops" } })).toBeNull();
  });

  it("skips a shipment with no stable id (cannot be an idempotency key)", () => {
    expect(mapShipmentToNormalized({ ...base, id: null })).toBeNull();
  });

  it("maps a missing reference to orderRef null (falls back to tracking match)", () => {
    const r = mapShipmentToNormalized({ ...base, reference: null });
    expect(r?.orderRef).toBeNull();
    expect(r?.trackingNo).toBe("1Z999");
  });

  it("defaults currency to USD when the rate omits it", () => {
    const r = mapShipmentToNormalized({ ...base, selected_rate: { rate: "1.00", carrier: "UPS" } });
    expect(r?.currency).toBe("USD");
    expect(r?.carrier).toBe("UPS");
  });
});

// ── fetchEasyPostCharges: auth header, pagination, window stop ────────────────
function shipment(id: string, createdAt: string, rate = "5.00"): EasyPostShipment {
  return {
    id,
    reference: null,
    tracking_code: `trk_${id}`,
    created_at: createdAt,
    selected_rate: { rate, currency: "USD", carrier: "USPS" },
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

// Typed fetch stub: explicit (url, init?) signature so .mock.calls[i] carries the right
// tuple arity for tsc. `respond` is invoked per call (call index passed in).
function makeFetch(respond: (call: number) => Response) {
  let n = 0;
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> => Promise.resolve(respond(n++)));
}

describe("fetchEasyPostCharges", () => {
  it("sends HTTP Basic auth with the key as username and empty password", async () => {
    const mockFetch = makeFetch(() => okResponse({ shipments: [], has_more: false }));
    await fetchEasyPostCharges("EZTKtest123", null, mockFetch as unknown as typeof fetch);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from("EZTKtest123:").toString("base64")}`);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("purchased=true");
    expect(url).toContain("page_size=100");
  });

  it("paginates via before_id until has_more is false, accumulating charges", async () => {
    const page1 = { shipments: [shipment("shp_3", "2026-06-03T00:00:00Z"), shipment("shp_2", "2026-06-02T00:00:00Z")], has_more: true };
    const page2 = { shipments: [shipment("shp_1", "2026-06-01T00:00:00Z")], has_more: false };
    const mockFetch = makeFetch((call) => okResponse(call === 0 ? page1 : page2));

    const out = await fetchEasyPostCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["shp_3", "shp_2", "shp_1"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // second page cursor = oldest id of page 1
    expect(mockFetch.mock.calls[1][0]).toContain("before_id=shp_2");
  });

  it("stops at the trailing-window floor: shipments older than `since` are not emitted", async () => {
    // since = 2026-06-02; shp_1 (06-01) is older → excluded, and paging halts.
    const page1 = {
      shipments: [shipment("shp_3", "2026-06-03T00:00:00Z"), shipment("shp_1", "2026-06-01T00:00:00Z")],
      has_more: true,
    };
    const mockFetch = vi.fn(async () => okResponse(page1));

    const out = await fetchEasyPostCharges("k", "2026-06-02T00:00:00Z", mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["shp_3"]);
    // crossed the window on page 1 → no second page fetched despite has_more:true.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws with status + body snippet on a non-2xx (so the cron records sync_error)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad api key",
    } as Response));
    await expect(
      fetchEasyPostCharges("bad", null, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/EasyPost 401 Unauthorized: bad api key/);
  });

  it("skips no-rate shipments within a page but keeps the good ones", async () => {
    const good = shipment("shp_ok", "2026-06-03T00:00:00Z", "3.50");
    const bad: EasyPostShipment = { id: "shp_norate", created_at: "2026-06-03T00:00:00Z", selected_rate: null };
    const mockFetch = vi.fn(async () => okResponse({ shipments: [good, bad], has_more: false }));

    const out = await fetchEasyPostCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "shp_ok", costCents: 350 });
  });
});
