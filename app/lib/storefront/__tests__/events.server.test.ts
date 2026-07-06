// app/lib/storefront/__tests__/events.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
let insertError: { message: string } | null = null;

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ __table: table, ...row });
        return { error: insertError };
      },
    }),
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { trackStorefrontEvent } from "../events.server";
// eslint-disable-next-line import/first -- see above
import type { VisitorSession } from "../visitor-cookie.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

function req(opts: { ua?: string; country?: string; city?: string; path?: string } = {}): Request {
  const headers = new Headers();
  if (opts.ua) headers.set("user-agent", opts.ua);
  if (opts.country) headers.set("x-vercel-ip-country", opts.country);
  if (opts.city) headers.set("x-vercel-ip-city", opts.city);
  return new Request(`https://x.example${opts.path ?? "/storefront"}`, { headers });
}

beforeEach(() => {
  inserted.length = 0;
  insertError = null;
});

describe("trackStorefrontEvent", () => {
  it("inserts a PII-free row and returns Set-Cookie headers", async () => {
    const headers = await trackStorefrontEvent(
      req({ ua: "Mozilla/5.0", country: "US", city: "Austin", path: "/storefront/products/mug" }),
      SHOP,
      "page_view",
      { productId: "var-1" },
    );
    expect(headers.getSetCookie().length).toBeGreaterThan(0);
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.__table).toBe("storefront_event");
    expect(row.shop_id).toBe(SHOP);
    expect(row.type).toBe("page_view");
    expect(row.path).toBe("/storefront/products/mug");
    expect(row.product_id).toBe("var-1");
    expect(row.country).toBe("US");
    expect(row.city).toBe("Austin");
    // PII guard: only the whitelisted columns, never ip/ua/email
    expect(Object.keys(row).sort()).toEqual(
      ["__table", "city", "country", "is_returning", "path", "product_id", "session_id", "shop_id", "type", "visitor_id"].sort(),
    );
  });

  it("skips non-UUID tenants (demo-shop) but still returns cookies", async () => {
    const headers = await trackStorefrontEvent(req({ ua: "Mozilla/5.0" }), "demo-shop", "page_view");
    expect(inserted).toHaveLength(0);
    expect(headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("skips obvious bots by user-agent", async () => {
    await trackStorefrontEvent(req({ ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" }), SHOP, "page_view");
    expect(inserted).toHaveLength(0);
  });

  it("swallows insert failures (logs, never throws)", async () => {
    insertError = { message: "boom" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const headers = await trackStorefrontEvent(req({ ua: "Mozilla/5.0" }), SHOP, "cart_add");
    expect(headers).toBeInstanceOf(Headers);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses a pre-computed session without re-minting a second visitor id", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "cd_vid=fixed");
    const session: VisitorSession = {
      visitorId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sessionId: "ffffffff-1111-2222-3333-444444444444",
      isReturning: false,
      headers,
    };
    // Request carries no cd_vid cookie: a re-derive would mint a different id.
    const returned = await trackStorefrontEvent(
      req({ ua: "Mozilla/5.0" }),
      SHOP,
      "page_view",
      { experimentId: "99999999-8888-7777-6666-555555555555", variantKey: "b" },
      session,
    );
    expect(returned).toBe(session.headers);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].visitor_id).toBe(session.visitorId);
    expect(inserted[0].session_id).toBe(session.sessionId);
  });

  it("stamps experiment exposure columns only when a variant was served", async () => {
    const experimentId = "99999999-8888-7777-6666-555555555555";
    await trackStorefrontEvent(req({ ua: "Mozilla/5.0" }), SHOP, "page_view", {
      experimentId,
      variantKey: "b",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].experiment_id).toBe(experimentId);
    expect(inserted[0].variant_key).toBe("b");
    // Without an experiment the row keeps the exact pre-experiment column set
    // (asserted key-for-key in the first test above).
    inserted.length = 0;
    await trackStorefrontEvent(req({ ua: "Mozilla/5.0" }), SHOP, "page_view");
    expect(inserted).toHaveLength(1);
    expect("experiment_id" in inserted[0]).toBe(false);
    expect("variant_key" in inserted[0]).toBe(false);
  });
});
