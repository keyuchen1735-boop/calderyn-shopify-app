// app/lib/__tests__/connect-deeplink.test.ts
import { describe, it, expect } from "vitest";
import { buildAppConnectUrl, SHOP_RE } from "../connect-deeplink";
import { readShopHintCookie, shopHintCookieHeader } from "../connect-deeplink.server";

describe("SHOP_RE", () => {
  it("accepts a myshopify domain and rejects anything else", () => {
    expect(SHOP_RE.test("my-shop.myshopify.com")).toBe(true);
    expect(SHOP_RE.test("evil.com")).toBe(false);
    expect(SHOP_RE.test("a.myshopify.com.evil.com")).toBe(false);
  });
});

describe("buildAppConnectUrl", () => {
  const base = { apiKey: "apikey123", appUrl: "https://app.calderyncompany.com", token: "tok 123" };

  it("builds an admin.shopify.com deep link for a known shop, url-encoding the token", () => {
    const url = buildAppConnectUrl({ ...base, shop: "myshop.myshopify.com" });
    expect(url).toBe("https://admin.shopify.com/store/myshop/apps/apikey123/app/connect?t=tok%20123");
  });

  it("falls back to the app URL when the shop is missing", () => {
    expect(buildAppConnectUrl({ ...base, shop: null })).toBe(
      "https://app.calderyncompany.com/app/connect?t=tok%20123",
    );
  });

  it("falls back to the app URL when the shop is not a myshopify domain", () => {
    expect(buildAppConnectUrl({ ...base, shop: "evil.com" })).toBe(
      "https://app.calderyncompany.com/app/connect?t=tok%20123",
    );
  });

  it("lowercases the handle even when SHOP_RE accepted a mixed-case shop", () => {
    expect(buildAppConnectUrl({ ...base, shop: "MyStore.myshopify.com" })).toBe(
      "https://admin.shopify.com/store/mystore/apps/apikey123/app/connect?t=tok%20123",
    );
  });
});

describe("__Host-cala_shop cookie helpers", () => {
  it("emits a hardened, host-scoped Set-Cookie value", () => {
    const h = shopHintCookieHeader("myshop.myshopify.com");
    expect(h).toContain("__Host-cala_shop=myshop.myshopify.com");
    expect(h).toContain("Path=/");
    expect(h).toContain("Secure");
    expect(h).toContain("HttpOnly");
    expect(h).toContain("SameSite=Lax");
  });

  it("reads a valid shop from the request cookie", () => {
    const req = new Request("https://app.calderyncompany.com/oauth/authorize", {
      headers: { Cookie: "x=1; __Host-cala_shop=Remembered.myshopify.com; y=2" },
    });
    expect(readShopHintCookie(req)).toBe("remembered.myshopify.com");
  });

  it("returns null when the cookie is absent", () => {
    expect(readShopHintCookie(new Request("https://app.calderyncompany.com/x"))).toBeNull();
  });

  it("rejects a non-myshopify cookie value (injection guard)", () => {
    const req = new Request("https://app.calderyncompany.com/x", {
      headers: { Cookie: "__Host-cala_shop=evil.com" },
    });
    expect(readShopHintCookie(req)).toBeNull();
  });

  it("throws rather than emit a cookie for an invalid shop (writer self-guard)", () => {
    expect(() => shopHintCookieHeader("evil.com")).toThrow();
    expect(() => shopHintCookieHeader("x; Path=/; Secure")).toThrow();
  });
});
