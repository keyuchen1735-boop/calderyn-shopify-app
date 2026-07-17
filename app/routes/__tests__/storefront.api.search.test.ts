import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";

const sequence = vi.hoisted(() => [] as string[]);
const resolveStorefrontShop = vi.hoisted(() => vi.fn(async () => { sequence.push("resolve"); return "shop-a"; }));
const rateLimit = vi.hoisted(() => vi.fn(async () => true));
const searchStorefront = vi.hoisted(() => vi.fn(async () => { sequence.push("search"); return { items: [], facets: {}, nextCursor: null, total: 0 }; }));

const InvalidSearchRequestError = vi.hoisted(() => class InvalidSearchRequestError extends Error {});

vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop, DEMO_SHOP_ID: "demo-shop" }));
vi.mock("~/lib/rate-limit.server", () => ({ rateLimit, clientIpKey: () => "search:ip" }));
vi.mock("~/lib/storefront/search.server", () => ({
  InvalidSearchRequestError,
  parseStorefrontSearchParams: vi.fn(() => ({ query: "", limit: 12 })),
  searchStorefront,
}));

// eslint-disable-next-line import/first -- route import follows hoisted mocks
import { loader } from "../storefront.api.search";

const args = (request: Request) => ({ request, params: {}, context: {} }) as LoaderFunctionArgs;

beforeEach(() => {
  vi.clearAllMocks();
  sequence.length = 0;
  resolveStorefrontShop.mockImplementation(async () => { sequence.push("resolve"); return "shop-a"; });
  rateLimit.mockResolvedValue(true);
  searchStorefront.mockImplementation(async () => { sequence.push("search"); return { items: [], facets: {}, nextCursor: null, total: 0 }; });
});

describe("storefront search API", () => {
  it("resolves the tenant before bounded catalog search and returns no-store JSON", async () => {
    searchStorefront.mockImplementationOnce(async () => {
      sequence.push("search");
      return {
        items: [], facets: {}, nextCursor: null, total: 0,
        presentationProducts: [{ id: "internal-card" }],
      };
    });
    const response = await loader(args(new Request("https://shop.example/storefront/api/search?q=clean")));
    expect(sequence).toEqual(["resolve", "search"]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json();
    expect(body).toEqual({ ok: true, data: expect.objectContaining({ items: [] }) });
    expect(body.data).not.toHaveProperty("presentationProducts");
  });

  it("returns a structured 429 without searching", async () => {
    rateLimit.mockResolvedValueOnce(false);
    const response = await loader(args(new Request("https://shop.example/storefront/api/search?q=clean")));
    expect(response.status).toBe(429);
    expect(searchStorefront).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
  });
});
