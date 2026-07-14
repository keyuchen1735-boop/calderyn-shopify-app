import { describe, it, expect, beforeEach } from "vitest";
import { readCartId, readCartIdentity, commitCartId, clearCartId } from "../cart-cookie.server";

// The helper signs with SHOPIFY_API_SECRET (read lazily per call), so the test
// sets it the same way the mcp_oauth tests set MCP_OAUTH_COOKIE_SECRET.
const SECRET = "test-app-secret-0000000000000000000000000000";
const CART_ID = "11111111-1111-4111-8111-111111111111";

/** Turn a Set-Cookie string into a Cookie request header (first `name=value` pair). */
function requestWithCookie(setCookie: string): Request {
  return new Request("https://shop.example/storefront/cart", {
    headers: { Cookie: setCookie.split(";")[0] },
  });
}

beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = SECRET;
});

describe("cart cookie", () => {
  it("round-trips a cart_id through commit -> read", async () => {
    const setCookie = await commitCartId(CART_ID);
    expect(setCookie).toContain("cd_cart=");
    expect(setCookie).toContain("HttpOnly");
    expect(await readCartId(requestWithCookie(setCookie))).toBe(CART_ID);
  });

  it("binds a new cart identity to its resolved shop inside the signed cookie", async () => {
    const setCookie = await commitCartId(CART_ID, "shop-a");
    const request = requestWithCookie(setCookie);

    expect(await readCartIdentity(request)).toEqual({ cartId: CART_ID, shopId: "shop-a" });
    expect(await readCartId(request)).toBe(CART_ID);
  });

  it("does not treat a legacy unbound cookie as an owned cart identity", async () => {
    const setCookie = await commitCartId(CART_ID);
    expect(await readCartIdentity(requestWithCookie(setCookie))).toBeNull();
  });

  it("rejects a signed shop-bound identity whose cart id is not a UUID", async () => {
    const setCookie = await commitCartId("not-a-uuid", "shop-a");
    expect(await readCartIdentity(requestWithCookie(setCookie))).toBeNull();
  });

  it("returns null when no cookie is present", async () => {
    const req = new Request("https://shop.example/storefront/cart");
    expect(await readCartId(req)).toBeNull();
  });

  it("rejects a cookie signed with a different secret (tamper-resistance)", async () => {
    const setCookie = await commitCartId(CART_ID);
    process.env.SHOPIFY_API_SECRET = "a-different-app-secret-1111111111111111111111";
    expect(await readCartId(requestWithCookie(setCookie))).toBeNull();
  });

  it("clearCartId emits an expiring cookie that reads back as no cart", async () => {
    const cleared = await clearCartId();
    expect(cleared).toContain("cd_cart=");
    // maxAge:0 -> Max-Age=0 (browser deletes); the empty value also reads back as absent.
    expect(cleared).toContain("Max-Age=0");
    expect(await readCartId(requestWithCookie(cleared))).toBeNull();
  });
});
