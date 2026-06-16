import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseLabelCostToCents,
  mapLabelToNormalized,
  fetchShipHeroCharges,
} from "../shiphero.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── parseLabelCostToCents: the ZERO-COST GUARD is the headline behavior ────────
describe("parseLabelCostToCents", () => {
  it("parses a normal label cost to cents", () => {
    expect(parseLabelCostToCents("7.39")).toBe(739);
    expect(parseLabelCostToCents(12)).toBe(1200);
  });
  it("avoids binary-float drift (0.29 → 29)", () => {
    expect(parseLabelCostToCents("0.29")).toBe(29);
  });
  it("treats 0 / null / negative as NO usable cost (zero-cost guard — never an actual_invoice)", () => {
    // The community-reported zero-cost config: a 0 label cost must NOT become a cost
    // signal (contract §8.4 / Plan 03 risk #4). parse returns null → the mapper skips it.
    expect(parseLabelCostToCents(0)).toBeNull();
    expect(parseLabelCostToCents("0")).toBeNull();
    expect(parseLabelCostToCents("0.00")).toBeNull();
    expect(parseLabelCostToCents(null)).toBeNull();
    expect(parseLabelCostToCents("-1")).toBeNull();
    expect(parseLabelCostToCents("oops")).toBeNull();
  });
});

// ── mapLabelToNormalized: (shipment, label) → NormalizedShipmentCost ───────────
describe("mapLabelToNormalized", () => {
  const shipment = {
    id: "ship_1",
    created_date: "2026-06-01T10:00:00Z",
    order: { partner_order_id: "gid://shopify/Order/1001", order_number: "#1001" },
    shipping_labels: [],
  };

  it("maps a label, preferring partner_order_id for the order ref and a composite externalId", () => {
    const r = mapLabelToNormalized(
      shipment,
      { cost: "7.39", tracking_number: "1Z999", carrier: "UPS" },
      0,
    );
    expect(r).toEqual({
      externalId: "ship_1:0",
      orderRef: "gid://shopify/Order/1001",
      trackingNo: "1Z999",
      costCents: 739,
      currency: "USD",
      shippedAt: "2026-06-01T10:00:00Z",
      carrier: "UPS",
    });
  });

  it("SKIPS a zero-cost label (does not emit a bogus actual_invoice — the core caveat)", () => {
    expect(mapLabelToNormalized(shipment, { cost: 0, tracking_number: "1Z999" }, 0)).toBeNull();
    expect(mapLabelToNormalized(shipment, { cost: "0.00", tracking_number: "1Z999" }, 1)).toBeNull();
  });

  it("falls back to order_number when partner_order_id is absent", () => {
    const r = mapLabelToNormalized(
      { ...shipment, order: { partner_order_id: null, order_number: "#1001" } },
      { cost: "4.00" },
      0,
    );
    expect(r?.orderRef).toBe("#1001");
  });

  it("keeps distinct externalIds for multiple labels on one shipment (pre-aggregation sums them)", () => {
    const a = mapLabelToNormalized(shipment, { cost: "4.00" }, 0);
    const b = mapLabelToNormalized(shipment, { cost: "5.00" }, 1);
    expect(a?.externalId).toBe("ship_1:0");
    expect(b?.externalId).toBe("ship_1:1");
  });
});

// ── fetchShipHeroCharges: Bearer auth, GraphQL shape, cursor pagination ────────
function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}
function page(
  edges: Array<{ id: string; cost: string; order?: string }>,
  hasNext: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      shipments: {
        data: {
          edges: edges.map((e) => ({
            node: {
              id: e.id,
              created_date: "2026-06-03T00:00:00Z",
              order: { partner_order_id: e.order ?? `ord_${e.id}`, order_number: `#${e.id}` },
              shipping_labels: [{ cost: e.cost, tracking_number: `trk_${e.id}`, carrier: "USPS" }],
            },
          })),
          pageInfo: { hasNextPage: hasNext, endCursor },
        },
      },
    },
  };
}
function makeFetch(respond: (call: number) => Response) {
  let n = 0;
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> => Promise.resolve(respond(n++)));
}

describe("fetchShipHeroCharges", () => {
  it("sends a Bearer token and the date_from window in the GraphQL variables", async () => {
    const mockFetch = makeFetch(() => okResponse(page([], false, null)));
    await fetchShipHeroCharges("oauth_tok", "2026-06-01T00:00:00Z", mockFetch as unknown as typeof fetch);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer oauth_tok");
    const body = JSON.parse(String(init.body));
    expect(body.variables).toMatchObject({ dateFrom: "2026-06-01T00:00:00Z", first: 100 });
    expect(String(body.query)).toContain("shipping_labels");
  });

  it("paginates via endCursor until hasNextPage is false", async () => {
    const mockFetch = makeFetch((call) =>
      okResponse(
        call === 0
          ? page([{ id: "1", cost: "5.00" }], true, "CUR1")
          : page([{ id: "2", cost: "6.00" }], false, null),
      ),
    );
    const out = await fetchShipHeroCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out.map((c) => c.externalId)).toEqual(["1:0", "2:0"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((mockFetch.mock.calls[1][1] as RequestInit).body)).variables.after).toBe("CUR1");
  });

  it("drops zero-cost labels mid-page but keeps the priced ones (zero-cost guard end-to-end)", async () => {
    const mixed = {
      data: {
        shipments: {
          data: {
            edges: [
              {
                node: {
                  id: "shipZ",
                  created_date: "2026-06-03T00:00:00Z",
                  order: { partner_order_id: "ordZ", order_number: "#Z" },
                  shipping_labels: [
                    { cost: "0.00", tracking_number: "free", carrier: "USPS" }, // dropped
                    { cost: "8.25", tracking_number: "paid", carrier: "USPS" }, // kept
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    const mockFetch = vi.fn(async () => okResponse(mixed));
    const out = await fetchShipHeroCharges("k", null, mockFetch as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "shipZ:1", costCents: 825 });
  });

  it("throws on a GraphQL errors array (200 + errors must not be silently empty — rule 12)", async () => {
    const mockFetch = vi.fn(async () => okResponse({ errors: [{ message: "throttled: credits exhausted" }] }));
    await expect(
      fetchShipHeroCharges("k", null, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/ShipHero GraphQL error: throttled/);
  });

  it("throws with status + snippet on a non-2xx (so the cron records sync_error)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad token",
    } as Response));
    await expect(
      fetchShipHeroCharges("bad", null, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow(/ShipHero 401 Unauthorized: bad token/);
  });
});
