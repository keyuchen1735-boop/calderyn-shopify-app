import { describe, it, expect, beforeEach } from "vitest";
import { readCartId, commitCartId, clearCartId } from "../cart-cookie.server";

// The helper signs with SHOPIFY_API_SECRET (read lazily per call), so the test
// sets it the same way the mcp_oauth tests set MCP_OAUTH_COOKIE_SECRET.
const SECRET = "test-app-secret-0000000000000000000000000000";

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
    const setCookie = await commitCartId("cart-123");
    expect(setCookie).toContain("cd_cart=");
    expect(setCookie).toContain("HttpOnly");
    expect(await readCartId(requestWithCookie(setCookie))).toBe("cart-123");
  });

  it("returns null when no cookie is present", async () => {
    const req = new Request("https://shop.example/storefront/cart");
    expect(await readCartId(req)).toBeNull();
  });

  it("rejects a cookie signed with a different secret (tamper-resistance)", async () => {
    const setCookie = await commitCartId("cart-xyz");
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
