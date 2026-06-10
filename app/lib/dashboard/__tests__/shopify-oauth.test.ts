import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
  verifyShopifyHmac,
  exchangeCodeForToken,
} from "../shopify-oauth.server";

describe("isValidShopDomain", () => {
  it("accepts real myshopify domains", () => {
    expect(isValidShopDomain("my-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("a1.myshopify.com")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isValidShopDomain("evil.com")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("https://x.myshopify.com")).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets the shop's authorize endpoint with all params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        shop: "x.myshopify.com",
        clientId: "client-1",
        scopes: "read_products,read_orders",
        redirectUri: "https://calderyncompany.com/dashboard/auth/callback",
        state: "nonce-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("scope")).toBe("read_products,read_orders");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://calderyncompany.com/dashboard/auth/callback",
    );
    expect(url.searchParams.get("state")).toBe("nonce-1");
  });
});

describe("verifyShopifyHmac", () => {
  const SECRET = "shh";
  function sign(params: Record<string, string>): URLSearchParams {
    const sp = new URLSearchParams(params);
    const message = [...sp.entries()]
      .filter(([k]) => k !== "hmac")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    sp.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
    return sp;
  }

  it("accepts a correctly signed query", () => {
    const sp = sign({ shop: "x.myshopify.com", code: "abc", state: "s", timestamp: "1" });
    expect(verifyShopifyHmac(sp, SECRET)).toBe(true);
  });

  it("rejects tampered queries and missing hmac", () => {
    const sp = sign({ shop: "x.myshopify.com", code: "abc", state: "s", timestamp: "1" });
    sp.set("code", "tampered");
    expect(verifyShopifyHmac(sp, SECRET)).toBe(false);
    expect(verifyShopifyHmac(new URLSearchParams({ shop: "x" }), SECRET)).toBe(false);
  });
});

describe("exchangeCodeForToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the code to the shop and returns ok on 200", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "tok", scope: "read_products" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ok = await exchangeCodeForToken({
      shop: "x.myshopify.com",
      code: "abc",
      clientId: "client-1",
      clientSecret: "shh",
    });
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.myshopify.com/admin/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: "client-1",
      client_secret: "shh",
      code: "abc",
    });
  });

  it("returns false on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    const ok = await exchangeCodeForToken({
      shop: "x.myshopify.com",
      code: "bad",
      clientId: "c",
      clientSecret: "s",
    });
    expect(ok).toBe(false);
  });
});
