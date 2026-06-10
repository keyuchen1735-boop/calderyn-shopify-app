import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminAlertDeepLink, adminDeepLinkRedirect } from "../admin-deeplink.server";

// Queue-driven Supabase stub: each `maybeSingle()` resolves the next queued
// response (the helper runs two sequential lookups: alerts → shops).
const { supabaseState } = vi.hoisted(() => ({
  supabaseState: {
    queue: [] as Array<{ data: unknown; error: unknown }>,
  },
}));

vi.mock("../supabase.server", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq"]) {
      c[m] = () => c;
    }
    c.maybeSingle = () =>
      Promise.resolve(supabaseState.queue.shift() ?? { data: null, error: null });
    return c;
  };
  return { getSupabase: () => chain() };
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
  supabaseState.queue = [];
  vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
});

describe("adminAlertDeepLink", () => {
  it("builds the admin deep link, preserving the action query param", async () => {
    supabaseState.queue = [
      { data: { shop_id: "shop-uuid-1" }, error: null },
      { data: { shop_domain: "calderyn-shop-tester.myshopify.com" }, error: null },
    ];
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

  it("returns null when the alert lookup misses", async () => {
    supabaseState.queue = [{ data: null, error: null }];
    expect(await adminAlertDeepLink(CONFIRM_URL)).toBeNull();
  });

  it("returns null when SHOPIFY_API_KEY is unset", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "");
    expect(await adminAlertDeepLink(CONFIRM_URL)).toBeNull();
  });
});

describe("adminDeepLinkRedirect", () => {
  it("rewrites the stock login bounce to the admin deep link", async () => {
    supabaseState.queue = [
      { data: { shop_id: "shop-uuid-1" }, error: null },
      { data: { shop_domain: "calderyn-shop-tester.myshopify.com" }, error: null },
    ];
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
    supabaseState.queue = [{ data: null, error: null }];
    expect(await adminDeepLinkRedirect(new Request(CONFIRM_URL), loginBounce())).toBeNull();
  });
});
