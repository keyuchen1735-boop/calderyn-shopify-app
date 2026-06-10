import { describe, it, expect, vi, beforeEach } from "vitest";
// Importing the shared chain mock also registers its beforeEach state reset.
// Each `maybeSingle()` drains the queued responses (the helper runs two
// sequential lookups: alerts → shops).
import { setSupabaseResponses, getRecorded } from "./_supabase_chain_mock";
import { adminAlertDeepLink, adminDeepLinkRedirect } from "../admin-deeplink.server";

vi.mock("../supabase.server", async () => {
  const { buildChain } = await import("./_supabase_chain_mock");
  return { getSupabase: () => buildChain() };
});

const ALERT_ID = "67091f82-bd08-4333-b892-3b034ef720c9";
const CONFIRM_URL = `https://app.calderyncompany.com/app/alerts/${ALERT_ID}?action=create_po_draft`;

function loginBounce(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/auth/login" },
  });
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
});

describe("adminAlertDeepLink", () => {
  it("builds the admin deep link, preserving the action query param", async () => {
    setSupabaseResponses([
      { data: { shop_id: "shop-uuid-1" }, error: null },
      { data: { shop_domain: "calderyn-shop-tester.myshopify.com" }, error: null },
    ]);
    expect(await adminAlertDeepLink(CONFIRM_URL)).toBe(
      `https://admin.shopify.com/store/calderyn-shop-tester/apps/test-api-key/app/alerts/${ALERT_ID}?action=create_po_draft`,
    );
  });

  it("returns null for non-alert paths", async () => {
    expect(await adminAlertDeepLink("https://app.calderyncompany.com/app/audit")).toBeNull();
  });

  it("returns null for a non-UUID alert id", async () => {
    expect(
      await adminAlertDeepLink("https://app.calderyncompany.com/app/alerts/not-a-uuid"),
    ).toBeNull();
  });

  it("excludes uninstalled shops from the lookup", async () => {
    // shops rows survive uninstall for a 30-day grace window; the deep link
    // must not send those to an admin app URL that no longer exists.
    setSupabaseResponses([
      { data: { shop_id: "shop-uuid-1" }, error: null },
      { data: { shop_domain: "calderyn-shop-tester.myshopify.com" }, error: null },
    ]);
    await adminAlertDeepLink(CONFIRM_URL);
    expect(getRecorded("is")).toContainEqual(["uninstalled_at", null]);
  });

  it("returns null when the alert lookup misses", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    expect(await adminAlertDeepLink(CONFIRM_URL)).toBeNull();
  });

  it("returns null when SHOPIFY_API_KEY is unset", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "");
    expect(await adminAlertDeepLink(CONFIRM_URL)).toBeNull();
  });
});

describe("adminDeepLinkRedirect", () => {
  it("rewrites the stock login bounce to the admin deep link", async () => {
    setSupabaseResponses([
      { data: { shop_id: "shop-uuid-1" }, error: null },
      { data: { shop_domain: "calderyn-shop-tester.myshopify.com" }, error: null },
    ]);
    const res = await adminDeepLinkRedirect(new Request(CONFIRM_URL), loginBounce());
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe(
      `https://admin.shopify.com/store/calderyn-shop-tester/apps/test-api-key/app/alerts/${ALERT_ID}?action=create_po_draft`,
    );
  });

  it("ignores non-Response throwables", async () => {
    expect(await adminDeepLinkRedirect(new Request(CONFIRM_URL), new Error("x"))).toBeNull();
  });

  it("ignores redirects that are not the login bounce", async () => {
    const other = new Response(null, { status: 302, headers: { location: "/app" } });
    expect(await adminDeepLinkRedirect(new Request(CONFIRM_URL), other)).toBeNull();
  });

  it("falls through (null) when the shop can't be resolved", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    expect(await adminDeepLinkRedirect(new Request(CONFIRM_URL), loginBounce())).toBeNull();
  });
});
