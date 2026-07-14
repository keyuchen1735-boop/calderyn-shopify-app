import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const responseBody = {
  available: true,
  variants: [],
  destinationUrl: "https://shop.example/products/pack",
  imageUrl: null,
  fallback: {
    headline: "Pack lighter",
    primaryText: "Built to move.",
    cta: "SHOP_NOW",
  },
  regenerationsLeft: 2,
};

function ok(): Response {
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("first-run creative client", () => {
  beforeEach(() => {
    vi.stubGlobal("location", {
      origin: "https://app.calderyncompany.com",
      assign: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shares one in-flight generation request for the same run and product", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { generateFirstRunCreatives } = await import("../client");

    const first = generateFirstRunCreatives("product-1", "run-1", 1);
    const duplicate = generateFirstRunCreatives("product-1", "run-1", 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(ok());
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      responseBody,
      responseBody,
    ]);

    fetchMock.mockResolvedValueOnce(ok());
    await generateFirstRunCreatives("product-1", "run-1", 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
