import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const responseBody = {
  available: true,
  variants: [],
  draftId: "33333333-3333-4333-8333-333333333333",
  destinationUrl: "https://shop.example/products/pack",
  imageUrl: null,
  fallback: {
    headline: "Pack lighter",
    primaryText: "Built to move.",
    cta: "SHOP_NOW",
  },
  regenerationsLeft: 2,
};

const generationContext = {
  placement: "instagram" as const,
  budgetCents: 1500,
  selectedCreativeIndex: 0,
  draftId: null,
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
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { generateFirstRunCreatives } = await import("../client");

    const first = generateFirstRunCreatives(
      "product-1",
      "run-1",
      1,
      generationContext,
    );
    const duplicate = generateFirstRunCreatives(
      "product-1",
      "run-1",
      1,
      generationContext,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    if (!requestInit) throw new Error("generation request init was missing");
    expect(JSON.parse(String(requestInit.body))).toEqual(
      expect.objectContaining({
        placement: "instagram",
        budgetCents: 1500,
        selectedCreativeIndex: 0,
        draftId: null,
      }),
    );
    resolveFetch(ok());
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      responseBody,
      responseBody,
    ]);

    fetchMock.mockResolvedValueOnce(ok());
    await generateFirstRunCreatives(
      "product-1",
      "run-1",
      1,
      generationContext,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("builds three honest product-image placeholders when generation is unavailable", async () => {
    const { buildFirstRunPlaceholderVariants } = await import("../client");
    const variants = buildFirstRunPlaceholderVariants({
      imageUrl: "https://cdn.example/product.png",
      fallback: responseBody.fallback,
    });

    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.rationale)).toEqual([
      "Original product framing",
      "Alternate product crop",
      "Closer product detail",
    ]);
    expect(variants.every((variant) => !variant.imageGenerated)).toBe(true);
    expect(variants.every((variant) => variant.score === null)).toBe(true);
    expect(variants.every((variant) => variant.imageUrl?.includes("product.png"))).toBe(true);

    const abstract = buildFirstRunPlaceholderVariants({
      imageUrl: null,
      fallback: responseBody.fallback,
    });
    expect(abstract.map((variant) => variant.imageUrl)).toEqual([
      "/campaign-placeholders/studio.svg",
      "/campaign-placeholders/scene.svg",
      "/campaign-placeholders/detail.svg",
    ]);
  });
});
