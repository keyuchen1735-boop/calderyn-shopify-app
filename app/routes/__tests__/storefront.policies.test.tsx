import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StorefrontPolicyRoute, { loader, meta } from "../storefront.policies.$policyId";

const { loaderDataRef, loadPolicyMock, resolveShopMock, settingsMock } = vi.hoisted(() => ({
  loaderDataRef: { current: null as unknown },
  loadPolicyMock: vi.fn(),
  resolveShopMock: vi.fn(),
  settingsMock: vi.fn(),
}));

vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));
vi.mock("~/lib/storefront/policies.server", () => ({
  loadStorefrontPolicy: (...args: unknown[]) => loadPolicyMock(...args),
}));
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...args: unknown[]) => resolveShopMock(...args),
}));
vi.mock("~/lib/storefront/settings.server", () => ({
  getStoreSettings: (...args: unknown[]) => settingsMock(...args),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const policy = {
  id: "privacy" as const,
  title: "How Northline uses data",
  body: "We use order details only to fulfill purchases.\n\n<script>alert('unsafe')</script>",
  updatedAt: "2026-07-14T12:00:00.000Z",
};

function args(policyId = "privacy") {
  return {
    request: new Request(`https://northline.calderyncompany.com/storefront/policies/${policyId}`),
    params: { policyId },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveShopMock.mockResolvedValue(SHOP);
  loadPolicyMock.mockResolvedValue(policy);
  settingsMock.mockResolvedValue({
    shopId: SHOP,
    storeName: "Northline Supply",
    logoUrl: null,
    palette: { primary: "#17352d", background: "#f6f1e7", text: "#17201d" },
    voiceTagline: null,
    vibe: "warm",
    typeStyle: "editorial",
    density: "roomy",
  });
});

describe("merchant storefront policy route", () => {
  it("resolves the request tenant and returns the matching merchant policy with strict storefront headers", async () => {
    const response = await loader(args());
    const data = await response.json();

    expect(resolveShopMock).toHaveBeenCalledWith(expect.any(Request));
    expect(loadPolicyMock).toHaveBeenCalledWith(SHOP, "privacy");
    expect(data).toMatchObject({ runtime: 1, policy, store: { name: "Northline Supply" } });
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(response.headers.get("Vercel-Cache-Tag")).toBe(`storefront-shop-${SHOP}`);
    expect(response.headers.get("X-Calderyn-Storefront-Renderer")).toBe("bundle-v1");
    expect(data.nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(response.headers.get("X-Calderyn-Storefront-Nonce")).toBe(data.nonce);
  });

  it("returns a real 404 for an unknown or unpublished policy", async () => {
    loadPolicyMock.mockResolvedValueOnce(null);
    await expect(loader(args("refund"))).rejects.toMatchObject({ status: 404 });
  });

  it("renders merchant branding and escaped plain-text policy content", () => {
    loaderDataRef.current = {
      runtime: 1,
      policy,
      store: {
        name: "Northline Supply",
        logo: null,
        palette: { primary: "#17352d", background: "#f6f1e7", text: "#17201d" },
        vibe: "warm",
        typeStyle: "editorial",
        density: "roomy",
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontPolicyRoute));

    expect(html).toContain('data-cd-storefront-policy="privacy"');
    expect(html).toContain("Northline Supply");
    expect(html).toContain("How Northline uses data");
    expect(html).toContain("&lt;script&gt;alert(&#x27;unsafe&#x27;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(meta({ data: loaderDataRef.current } as never)).toEqual(expect.arrayContaining([
      { title: "How Northline uses data · Northline Supply" },
    ]));
  });
});
