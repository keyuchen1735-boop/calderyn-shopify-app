import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAmountToCents,
  mapTransactionToNormalized,
  fetchShippoCharges,
  type ShippoTransaction,
} from "../shippo.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── parseAmountToCents: decimal STRING → integer cents, no float drift ─────────
describe("parseAmountToCents", () => {
  it('parses "5.52" to 552 cents', () => {
    expect(parseAmountToCents("5.52")).toBe(552);
  });

  it("parses whole-dollar, sub-dollar, and large strings (Plan 02 §10)", () => {
    expect(parseAmountToCents("10.00")).toBe(1000);
    expect(parseAmountToCents("0.5")).toBe(50);
    expect(parseAmountToCents("123.45")).toBe(12345);
    expect(parseAmountToCents("0")).toBe(0);
  });

  it("avoids binary-float drift (19.99 → 1999, not 1998)", () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE-754; Math.round rescues it to 1999.
    expect(parseAmountToCents("19.99")).toBe(1999);
    expect(parseAmountToCents("0.29")).toBe(29);
  });

  it("rejects malformed / negative / null as null (unmappable, not coerced to 0 — rule 12)", () => {
    expect(parseAmountToCents(null)).toBeNull();
    expect(parseAmountToCents(undefined)).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("-1.00")).toBeNull();
    expect(parseAmountToCents("1.2.3")).toBeNull();
  });
});

// ── mapTransactionToNormalized: Shippo Transaction → NormalizedShipmentCost ────
describe("mapTransactionToNormalized", () => {
  const base: ShippoTransaction = {
    object_id: "txn_abc",
    object_created: "2026-06-01T10:00:00Z",
    status: "SUCCESS",
    metadata: "#1001",
    tracking_number: "1Z999",
    rate: { amount: "5.52", currency: "USD", provider: "USPS" },
  };

  it("maps every field per §4.1 from a nested CoreRate", () => {
    expect(mapTransactionToNormalized(base)).toEqual({
      externalId: "txn_abc",
      orderRef: "#1001",
      trackingNo: "1Z999",
      costCents: 552,
      currency: "USD",
      shippedAt: "2026-06-01T10:00:00Z",
      carrier: "USPS",
    });
  });

  it("surfaces a row whose amount is unparseable as unmappable (null, not cost 0)", () => {
    expect(mapTransactionToNormalized({ ...base, rate: { amount: "oops" } })).toBeNull();
  });

  it("surfaces a row with no stable object_id as unmappable (can't be an idempotency key)", () => {
    expect(mapTransactionToNormalized({ ...base, object_id: null })).toBeNull();
  });

  it("excludes a non-SUCCESS row even if it reached the mapper (defensive §4.2)", () => {
    for (const status of ["WAITING", "QUEUED", "ERROR"]) {
      expect(mapTransactionToNormalized({ ...base, status })).toBeNull();
    }
  });

  it("treats an UNRESOLVED rate id string as unmappable (no undefined.amount read — §4.4)", () => {
    expect(mapTransactionToNormalized({ ...base, rate: "rate_999" })).toBeNull();
  });

  it("maps blank metadata to orderRef null (falls back to tracking match — C5)", () => {
    const r = mapTransactionToNormalized({ ...base, metadata: "" });
    expect(r?.orderRef).toBeNull();
    expect(r?.trackingNo).toBe("1Z999");
  });

  it("defaults currency to USD when the rate omits it", () => {
    const r = mapTransactionToNormalized({ ...base, rate: { amount: "1.00", provider: "UPS" } });
    expect(r?.currency).toBe("USD");
    expect(r?.carrier).toBe("UPS");
  });
});

// ── fetchShippoCharges: auth header, status param, pagination, window, rate oneOf ──
function txn(
  id: string,
  createdAt: string,
  rate: ShippoTransaction["rate"] = { amount: "5.00", currency: "USD", provider: "USPS" },
): ShippoTransaction {
  return {
    object_id: id,
    object_created: createdAt,
    status: "SUCCESS",
    metadata: "",
    tracking_number: `trk_${id}`,
    rate,
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

// Typed fetch stub: explicit (url, init?) signature so .mock.calls[i] carries the right
// tuple arity for tsc. `respond` is invoked per call with the requested url + call index.
function makeFetch(respond: (url: string, call: number) => Response) {
  let n = 0;
  return vi.fn((url: string, _init?: RequestInit): Promise<Response> => Promise.resolve(respond(url, n++)));
}

describe("fetchShippoCharges", () => {
  it("sends Bearer auth + the Shippo-API-Version header and ?object_status=SUCCESS&results=100", async () => {
    const mockFetch = makeFetch(() => okResponse({ results: [], next: null }));
    await fetchShippoCharges("oauth.tok123", null, mockFetch as unknown as typeof fetch);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth.tok123");
    expect(headers["Shippo-API-Version"]).toBe("2018-02-08");
    expect(url).toContain("object_status=SUCCESS");
    expect(url).toContain("results=100"); // cap 100, NEVER 200 (Plan 02 concern #2).
  });

  it("follows the envelope `next` URL until null, accumulating charges (no count field)", async () => {
    const page1 = {
      results: [txn("txn_3", "2026-06-03T00:00:00Z"), txn("txn_2", "2026-06-02T00:00:00Z")],
      next: "https://api.goshippo.com/transactions/?object_status=SUCCESS&results=100&page=2",
    };
    const page2 = { results: [txn("txn_1", "2026-06-01T00:00:00Z")], next: null };
    const mockFetch = makeFetch((_url, call) => okResponse(call === 0 ? page1 : page2));

    const out = await fetchShippoCharges("oauth.k", null, mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["txn_3", "txn_2", "txn_1"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // second request follows the verbatim `next` link.
    expect(mockFetch.mock.calls[1][0]).toBe(page1.next);
  });

  it("stops at the trailing-window floor: transactions older than `since` are not emitted", async () => {
    const page1 = {
      results: [txn("txn_3", "2026-06-03T00:00:00Z"), txn("txn_1", "2026-06-01T00:00:00Z")],
      next: "https://api.goshippo.com/transactions/?page=2",
    };
    const mockFetch = vi.fn(async () => okResponse(page1));
    const out = await fetchShippoCharges(
      "oauth.k",
      "2026-06-02T00:00:00Z",
      mockFetch as unknown as typeof fetch,
    );
    expect(out.map((c) => c.externalId)).toEqual(["txn_3"]);
    // crossed the window on page 1 → no second page fetched despite a non-null `next`.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a bare rate-id string by fetching GET /transactions/{id} for the nested rate (§4.4)", async () => {
    const listRow = txn("txn_idonly", "2026-06-03T00:00:00Z", "rate_555");
    const detail: ShippoTransaction = {
      ...listRow,
      rate: { amount: "8.88", currency: "USD", provider: "FedEx" },
    };
    const mockFetch = makeFetch((url) => {
      if (url.includes("/transactions/txn_idonly")) return okResponse(detail);
      return okResponse({ results: [listRow], next: null });
    });

    const out = await fetchShippoCharges("oauth.k", null, mockFetch as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "txn_idonly", costCents: 888, carrier: "FedEx" });
    // exactly one list call + one detail fetch for the id-only row.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain("/transactions/txn_idonly");
  });

  it("drops a row whose rate stays unresolvable (detail still has no nested rate) — unmappable, not cost 0", async () => {
    const listRow = txn("txn_bad", "2026-06-03T00:00:00Z", "rate_x");
    // Detail fetch returns a transaction that STILL only has a string rate.
    const detail: ShippoTransaction = { ...listRow, rate: "rate_x" };
    const mockFetch = makeFetch((url) => {
      if (url.includes("/transactions/txn_bad")) return okResponse(detail);
      return okResponse({ results: [listRow], next: null });
    });
    const out = await fetchShippoCharges("oauth.k", null, mockFetch as unknown as typeof fetch);
    expect(out).toHaveLength(0);
  });

  it("skips non-SUCCESS rows the API echoed despite the filter, keeping the SUCCESS ones", async () => {
    const good = txn("txn_ok", "2026-06-03T00:00:00Z");
    const queued: ShippoTransaction = { ...txn("txn_q", "2026-06-03T00:00:00Z"), status: "QUEUED" };
    const mockFetch = vi.fn(async () => okResponse({ results: [good, queued], next: null }));
    const out = await fetchShippoCharges("oauth.k", null, mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["txn_ok"]);
  });

  it("throws with status + body snippet on a non-2xx list (so the cron records sync_error)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid token",
    } as Response));
    await expect(
      fetchShippoCharges("oauth.bad", null, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/Shippo 401 Unauthorized: invalid token/);
  });
});
