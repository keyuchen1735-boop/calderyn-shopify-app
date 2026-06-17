import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseLabelCostToCents,
  mapLabelToNormalized,
  fetchShipHeroCharges,
  shipHeroAdapter,
} from "../shiphero.server";

// connect() reads a stored credential, decrypts it (= the REFRESH token), mints an access
// token from it via refreshShipHeroToken, then hands fetchShipHeroCharges that access token.
// Mock the three module boundaries so the credential→refresh→Bearer wiring is testable
// without supabase / real crypto / network. (The pure-function describes above don't touch
// these mocks.)
const maybeSingleMock = vi.fn();
vi.mock("../../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
    }),
  }),
}));
vi.mock("../../../crypto.server", () => ({
  // The stored ciphertext decrypts to the merchant's refresh token.
  decrypt: (cipher: string) => (cipher === "enc(refresh_tok)" ? "refresh_tok" : `dec(${cipher})`),
}));
const refreshMock = vi.fn();
vi.mock("../../../shiphero/auth.server", () => ({
  refreshShipHeroToken: (rt: string) => refreshMock(rt),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  maybeSingleMock.mockReset();
  refreshMock.mockReset();
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

  it("maps a label, preferring partner_order_id (GID → numeric id) and a composite externalId", () => {
    // partner_order_id is a GraphQL GID; the mapper extracts the trailing numeric id so it
    // ref-matches order_fact.order_number ("#1001") after the matcher strips the '#'.
    const r = mapLabelToNormalized(
      shipment,
      { cost: "7.39", tracking_number: "1Z999", carrier: "UPS" },
      0,
    );
    expect(r).toEqual({
      externalId: "ship_1:0",
      orderRef: "1001",
      trackingNo: "1Z999",
      costCents: 739,
      currency: "USD",
      shippedAt: "2026-06-01T10:00:00Z",
      carrier: "UPS",
    });
  });

  it("passes a non-GID partner_order_id through unchanged (numeric ref already)", () => {
    const r = mapLabelToNormalized(
      { ...shipment, order: { partner_order_id: "1001", order_number: "#1001" } },
      { cost: "4.00" },
      0,
    );
    expect(r?.orderRef).toBe("1001");
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

// ── shipHeroAdapter.connect(): refresh-token → access-token derivation ──────────
describe("shipHeroAdapter.connect", () => {
  it("derives an access token from the stored refresh token, then uses it as the Bearer", async () => {
    // Stored credential decrypts to the refresh token; refresh mints a fresh access token.
    maybeSingleMock.mockResolvedValue({
      data: { access_token_encrypted: "enc(refresh_tok)" },
      error: null,
    });
    refreshMock.mockResolvedValue({ accessToken: "acc_minted", expiresIn: 2419200 });

    // fetchCharges uses the DEFAULT global fetch; stub it to a single empty page and assert
    // the Authorization header carries the MINTED access token (not the refresh token).
    const globalFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse(page([], false, null)),
    );
    vi.stubGlobal("fetch", globalFetch);

    const source = await shipHeroAdapter.connect("shop-1");
    expect(source).not.toBeNull();
    expect(refreshMock).toHaveBeenCalledWith("refresh_tok");

    await source!.fetchCharges("2026-06-01T00:00:00Z");
    const init = globalFetch.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer acc_minted");
  });

  it("returns null when there is no stored credential (→ cron marks skipped)", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect(await shipHeroAdapter.connect("shop-1")).toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("returns null when the refresh fails (revoked/expired token → skipped, not a thrown sweep)", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { access_token_encrypted: "enc(refresh_tok)" },
      error: null,
    });
    refreshMock.mockRejectedValue(new Error("ShipHero token refresh 401 Unauthorized: nope"));
    expect(await shipHeroAdapter.connect("shop-1")).toBeNull();
  });
});
