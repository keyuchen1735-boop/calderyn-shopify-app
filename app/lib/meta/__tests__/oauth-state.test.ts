/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createOAuthState,
  consumeOAuthState,
  packOAuthState,
  parseOAuthState,
  embeddedReturnUrl,
  OAUTH_STATE_TTL_MS,
} from "../oauth-state.server";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let inserting: Row[] | null = null;
  let deleting = false;

  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));

  const api: any = {
    select: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    insert: (vals: Row | Row[]) => {
      inserting = Array.isArray(vals) ? vals : [vals];
      return api;
    },
    delete: () => {
      deleting = true;
      return api;
    },
    maybeSingle: async () => {
      if (deleting) {
        const hit = matches()[0] ?? null;
        if (hit) store[table] = (store[table] ?? []).filter((r) => r !== hit);
        return { data: hit, error: null };
      }
      return { data: matches()[0] ?? null, error: null };
    },
    then: (resolve: (v: { data: any; error: null }) => void) => {
      if (inserting) {
        const rows = inserting.map((v) => ({ created_at: new Date().toISOString(), ...v }));
        store[table] = [...(store[table] ?? []), ...rows];
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

const sb = { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("createOAuthState", () => {
  it("stores a nonce bound to the shop and returns it", async () => {
    const nonce = await createOAuthState(sb, "shop-A");
    expect(nonce).toBeTruthy();
    expect(store["oauth_state"]).toHaveLength(1);
    expect(store["oauth_state"][0]).toMatchObject({ nonce, shop_id: "shop-A" });
  });

  it("generates a distinct, unguessable nonce each call", async () => {
    const a = await createOAuthState(sb, "shop-A");
    const b = await createOAuthState(sb, "shop-A");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("consumeOAuthState", () => {
  it("returns the bound shop_id and consumes the nonce (single-use)", async () => {
    const nonce = await createOAuthState(sb, "shop-A");
    expect(await consumeOAuthState(sb, nonce)).toBe("shop-A");
    // Replay must fail: the row is gone.
    expect(await consumeOAuthState(sb, nonce)).toBeNull();
  });

  it("returns null for an unknown nonce", async () => {
    expect(await consumeOAuthState(sb, "never-issued")).toBeNull();
  });

  it("returns null for an empty nonce without touching the store", async () => {
    expect(await consumeOAuthState(sb, "")).toBeNull();
  });

  it("rejects an expired nonce (older than the TTL)", async () => {
    const old = new Date(Date.now() - OAUTH_STATE_TTL_MS - 1000).toISOString();
    store["oauth_state"] = [{ nonce: "stale", shop_id: "shop-A", created_at: old }];
    expect(await consumeOAuthState(sb, "stale")).toBeNull();
  });

  it("validates the nonce inside a packed state and stays single-use", async () => {
    const state = await createOAuthState(sb, "shop-A", {
      host: "b64host",
      shop: "demo.myshopify.com",
    });
    // The stored nonce is bare; the returned `state` is packed (carries context).
    const bareNonce = store["oauth_state"][0].nonce;
    expect(state).not.toBe(bareNonce);
    expect(parseOAuthState(state)).toMatchObject({
      nonce: bareNonce,
      host: "b64host",
      shop: "demo.myshopify.com",
    });
    expect(await consumeOAuthState(sb, state)).toBe("shop-A");
    // Replay of the packed state must also fail (row consumed).
    expect(await consumeOAuthState(sb, state)).toBeNull();
  });
});

describe("packOAuthState / parseOAuthState", () => {
  it("round-trips host and shop through a packed state", () => {
    const state = packOAuthState("nonce-1", { host: "aHsdf==", shop: "demo.myshopify.com" });
    expect(state).not.toBe("nonce-1");
    expect(parseOAuthState(state)).toEqual({
      nonce: "nonce-1",
      host: "aHsdf==",
      shop: "demo.myshopify.com",
      popup: false,
      dashboard: false,
    });
  });

  it("round-trips the popup flag (new-tab onboarding connect)", () => {
    // popup alone is enough context to force a packed (non-bare) state, so the
    // callback can route to the standalone /auth/connected page.
    const state = packOAuthState("nonce-1", { popup: true });
    expect(state).not.toBe("nonce-1");
    expect(parseOAuthState(state)).toEqual({
      nonce: "nonce-1",
      host: null,
      shop: null,
      popup: true,
      dashboard: false,
    });
  });

  it("round-trips the dashboard flag (dashboard-native connect)", () => {
    // dashboard alone forces a packed state, so the callback can route back to
    // /dashboard instead of the embedded admin or the popup result page.
    const state = packOAuthState("nonce-1", { dashboard: true });
    expect(state).not.toBe("nonce-1");
    expect(parseOAuthState(state)).toEqual({
      nonce: "nonce-1",
      host: null,
      shop: null,
      popup: false,
      dashboard: true,
    });
  });

  it("returns the bare nonce when no context is supplied", () => {
    expect(packOAuthState("nonce-1")).toBe("nonce-1");
    expect(packOAuthState("nonce-1", {})).toBe("nonce-1");
    expect(packOAuthState("nonce-1", { host: null, shop: null })).toBe("nonce-1");
    expect(packOAuthState("nonce-1", { popup: false })).toBe("nonce-1");
    expect(packOAuthState("nonce-1", { dashboard: false })).toBe("nonce-1");
  });

  it("parses a plain nonce as the nonce with null context", () => {
    expect(parseOAuthState("just-a-nonce")).toEqual({
      nonce: "just-a-nonce",
      host: null,
      shop: null,
      popup: false,
      dashboard: false,
    });
  });

  // States minted BEFORE the dashboard flag shipped ({n,h,s,p} with no `d`
  // key) stay in flight for up to OAUTH_STATE_TTL_MS across a deploy — they
  // must keep parsing with dashboard:false, not fall back to bare-nonce.
  it("parses a pre-dashboard packed state (no `d` key) as dashboard:false", () => {
    const legacy = Buffer.from(
      JSON.stringify({ n: "nonce-1", h: "b64host", s: "demo.myshopify.com", p: 1 }),
      "utf8",
    ).toString("base64url");
    expect(parseOAuthState(legacy)).toEqual({
      nonce: "nonce-1",
      host: "b64host",
      shop: "demo.myshopify.com",
      popup: true,
      dashboard: false,
    });
  });
});

describe("embeddedReturnUrl", () => {
  beforeEach(() => {
    delete process.env.SHOPIFY_API_KEY;
    delete process.env.DASHBOARD_PUBLIC_URL;
    delete process.env.SHOPIFY_APP_URL;
  });

  // The reliable way back into a SPECIFIC embedded page after a top-level OAuth
  // callback is Shopify's admin deep link — admin.shopify.com loads the app
  // iframe at the exact path and forwards the query params. Returning to our
  // own domain instead bounces through authenticate.admin, which re-enters at
  // the app ROOT and drops the path + connection notice.
  it("returns the admin deep link when shop and the app api key are known", () => {
    process.env.SHOPIFY_API_KEY = "testapikey";
    expect(
      embeddedReturnUrl(
        "/app/settings",
        { quickbooks: "connected" },
        { host: null, shop: "demo.myshopify.com" },
      ),
    ).toBe(
      "https://admin.shopify.com/store/demo/apps/testapikey/app/settings?quickbooks=connected",
    );
  });

  it("appends shop and host when both are present", () => {
    const url = embeddedReturnUrl(
      "/app/settings",
      { google: "connected" },
      { host: "b64host", shop: "demo.myshopify.com" },
    );
    const parsed = new URL(url, "https://x.example");
    expect(parsed.pathname).toBe("/app/settings");
    expect(parsed.searchParams.get("google")).toBe("connected");
    expect(parsed.searchParams.get("shop")).toBe("demo.myshopify.com");
    expect(parsed.searchParams.get("host")).toBe("b64host");
  });

  it("falls back to a bare path when context is missing", () => {
    expect(
      embeddedReturnUrl("/app/settings", { google: "connected" }, { host: null, shop: null }),
    ).toBe("/app/settings?google=connected");
  });

  // `host` is merely base64url("admin.shopify.com/store/<handle>") — derivable
  // from the shop domain. The connect form loses ?host= after client-side
  // navigation, so a missing host must not dump the merchant on the login page.
  it("synthesizes host from the shop domain when only shop is known", () => {
    const url = embeddedReturnUrl(
      "/app/settings",
      { quickbooks: "connected" },
      { host: null, shop: "demo.myshopify.com" },
    );
    const parsed = new URL(url, "https://x.example");
    expect(parsed.searchParams.get("shop")).toBe("demo.myshopify.com");
    const host = parsed.searchParams.get("host")!;
    expect(Buffer.from(host, "base64url").toString("utf8")).toBe(
      "admin.shopify.com/store/demo",
    );
  });

  it("prefers the real packed host over a synthesized one", () => {
    const url = embeddedReturnUrl(
      "/app/settings",
      { quickbooks: "connected" },
      { host: "realhost", shop: "demo.myshopify.com" },
    );
    expect(new URL(url, "https://x.example").searchParams.get("host")).toBe("realhost");
  });

  // Dashboard-native connects never re-enter the Shopify admin: the callback
  // lands on the dashboard SPA with the same one-shot notice params, and the
  // embedded /app/* path is dropped (it has no meaning outside the admin).
  // The URL must be absolute on the PUBLIC dashboard origin — the __Host-
  // session cookie is host-only and the callback runs on SHOPIFY_APP_URL, so
  // a relative redirect would land on a host where the merchant has no session.
  it("returns the absolute public-dashboard URL when the state carried the dashboard flag", () => {
    process.env.SHOPIFY_API_KEY = "testapikey";
    process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(
      embeddedReturnUrl(
        "/app/settings",
        { meta: "connected" },
        { host: null, shop: "demo.myshopify.com", dashboard: true },
      ),
    ).toBe("https://calderyncompany.com/dashboard?meta=connected");
  });

  it("falls back to the app host, then a relative path, when the public URL is unset", () => {
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(
      embeddedReturnUrl("/app/settings", { meta: "connected" }, { host: null, shop: null, dashboard: true }),
    ).toBe("https://app.calderyncompany.com/dashboard?meta=connected");
    delete process.env.SHOPIFY_APP_URL;
    expect(
      embeddedReturnUrl("/app/settings", { meta: "connected" }, { host: null, shop: null, dashboard: true }),
    ).toBe("/dashboard?meta=connected");
  });

  it("keeps the error reason on a dashboard return", () => {
    process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
    expect(
      embeddedReturnUrl(
        "/app/settings",
        { google: "error", reason: "access_denied" },
        { host: null, shop: null, dashboard: true },
      ),
    ).toBe("https://calderyncompany.com/dashboard?google=error&reason=access_denied");
  });
});
