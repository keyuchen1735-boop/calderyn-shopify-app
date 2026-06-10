# Web Dashboard Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchant-gated JSON backend at `calderyncompany.com/dashboard/*` (proxied to this Remix app) with Sign-in-with-Shopify auth, reusing the existing Calderyn data/action pipeline so the web dashboard and the embedded Shopify app stay in two-way sync automatically.

**Architecture:** New `dashboard.*` flat routes in `calderyn-shopify-app` (Remix v2, deployed at `app.calderyncompany.com`). Standalone Shopify OAuth proves shop ownership; an opaque session token (hashed, peppered) in a `__Host-` cookie gates every `/dashboard/api/*` route. All reads/writes delegate to `calderynClient` / `app/lib/actions/*`. The waitlist repo (`calderyncompany.com`) gains only Vercel rewrites. Spec: `docs/superpowers/specs/2026-06-09-web-dashboard-backend-design.md`.

**Tech Stack:** Remix v2 flat routes, Supabase JS (service role), node:crypto, jose (already a dep) for the Realtime JWT, vitest with the existing `_supabase_chain_mock.ts` pattern.

**Repos:** All tasks are in `C:\Users\famou\Desktop\calderyn-shopify-app` except Task 10 (waitlist repo `C:\Users\famou\Desktop\calderyn-waitlist`).

**New env vars (set locally in `.env`, and in Vercel for the calderyn-shopify-app project):**
- `DASHBOARD_SESSION_PEPPER` — 32+ char random secret (HMAC pepper for session token hashes).
- `DASHBOARD_PUBLIC_URL` — `https://calderyncompany.com` in prod; the app's own URL in dev.
- `SUPABASE_JWT_SECRET` — the project's JWT secret (Supabase dashboard → Settings → API → JWT Secret). Only needed by Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260609130000_dashboard_sessions.sql` | `dashboard_sessions` table |
| `supabase/migrations/20260609140000_dashboard_realtime.sql` | RLS read policies + Realtime publication for shop-scoped subscriptions |
| `app/lib/dashboard/session.server.ts` | Token mint/hash, session CRUD, `requireDashboardSession`, cookie helpers |
| `app/lib/dashboard/shopify-oauth.server.ts` | Shop-domain validation, authorize URL, HMAC verify, code exchange |
| `app/lib/dashboard/http.server.ts` | JSON error helper, origin check, in-memory rate limiter |
| `app/lib/dashboard/__tests__/*.test.ts` | Unit tests for the three libs + route tests |
| `app/routes/dashboard.login.tsx` | Starts OAuth |
| `app/routes/dashboard.auth.callback.tsx` | Finishes OAuth, sets session cookie |
| `app/routes/dashboard.api.*.tsx` | JSON API (one file per endpoint, all thin) |
| `app/routes/webhooks.app.uninstalled.tsx` (modify) | Revoke dashboard sessions on uninstall |
| `shopify.app.calderynextension.toml` (modify) | Register apex redirect URL |
| `.env.example` (modify) | Document new vars (names only, no values) |
| waitlist `vercel.json` (modify) | `/dashboard/*` rewrites + CSP `connect-src` |

---

### Task 1: `dashboard_sessions` migration

**Files:**
- Create: `supabase/migrations/20260609130000_dashboard_sessions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Sessions for the merchant web dashboard (calderyncompany.com/dashboard).
-- Only the HMAC-SHA256 hash of the opaque cookie token is stored.
-- Service-role access only; RLS enabled with no policies as a belt-and-braces
-- guard against accidental anon/authenticated grants.
create table if not exists public.dashboard_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_domain text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists dashboard_sessions_shop_id_idx
  on public.dashboard_sessions (shop_id);

alter table public.dashboard_sessions enable row level security;
```

- [ ] **Step 2: Apply the migration to the Supabase project**

Use the Supabase MCP tool: `mcp__supabase__apply_migration` with `project_id: "ajgrmnvzxfxxlwrxcgnu"`, `name: "dashboard_sessions"`, and the SQL above. (Fallback: paste into the Supabase SQL editor.)
Expected: success; `mcp__supabase__list_tables` shows `dashboard_sessions`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260609130000_dashboard_sessions.sql
git commit -m "feat(dashboard): dashboard_sessions table"
```

---

### Task 2: Session library

**Files:**
- Create: `app/lib/dashboard/session.server.ts`
- Test: `app/lib/dashboard/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/dashboard/__tests__/session.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

import {
  newSessionToken,
  hashSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readSessionTokenFromCookie,
  createSession,
  getSessionFromRequest,
  requireDashboardSession,
  revokeAllSessionsForShop,
  SESSION_COOKIE_NAME,
} from "../session.server";

beforeEach(() => {
  process.env.DASHBOARD_SESSION_PEPPER = "test-pepper-that-is-at-least-32-chars!!";
});

describe("token mint + hash", () => {
  it("mints dash_live_ tokens with 32-char base32 bodies, unique per call", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^dash_live_[a-z2-7]{32}$/);
    expect(a).not.toEqual(b);
  });

  it("hashes deterministically with the pepper and changes when pepper changes", () => {
    const t = newSessionToken();
    const h1 = hashSessionToken(t);
    expect(h1).toEqual(hashSessionToken(t));
    process.env.DASHBOARD_SESSION_PEPPER = "another-pepper-that-is-32-chars-long!!!";
    expect(hashSessionToken(t)).not.toEqual(h1);
  });

  it("throws when the pepper is missing or short", () => {
    process.env.DASHBOARD_SESSION_PEPPER = "short";
    expect(() => hashSessionToken("dash_live_x")).toThrow();
  });
});

describe("cookie round-trip", () => {
  it("serializes a __Host- cookie and reads it back from a Request", () => {
    const raw = newSessionToken();
    const header = sessionCookieHeader(raw);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=${raw}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");

    const req = new Request("https://calderyncompany.com/dashboard/api/me", {
      headers: { Cookie: `foo=bar; ${SESSION_COOKIE_NAME}=${raw}; baz=qux` },
    });
    expect(readSessionTokenFromCookie(req)).toEqual(raw);
  });

  it("returns null when the cookie is absent", () => {
    const req = new Request("https://calderyncompany.com/dashboard/api/me");
    expect(readSessionTokenFromCookie(req)).toBeNull();
  });

  it("clear header expires the cookie", () => {
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});

describe("createSession", () => {
  it("inserts a hashed row and returns the raw token once", async () => {
    setSupabaseResponses([{ data: { id: "sess-1" }, error: null }]);
    const { raw } = await createSession("x.myshopify.com");
    expect(raw).toMatch(/^dash_live_/);
    const inserts = getRecorded("insert");
    expect(inserts.length).toBe(1);
    const row = inserts[0][0] as Record<string, unknown>;
    expect(row.shop_domain).toBe("x.myshopify.com");
    expect(row.token_hash).toEqual(hashSessionToken(raw));
    expect(row.token_hash).not.toContain(raw.slice(10)); // raw never stored
  });
});

describe("getSessionFromRequest / requireDashboardSession", () => {
  function reqWithToken(raw: string) {
    return new Request("https://calderyncompany.com/dashboard/api/me", {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${raw}` },
    });
  }

  it("returns the shop for a live session and bumps last_seen_at", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          revoked_at: null,
        },
        error: null,
      },
      { data: null, error: null }, // last_seen_at update
    ]);
    const s = await getSessionFromRequest(reqWithToken(newSessionToken()));
    expect(s).toEqual({ shopId: "shop-1", shopDomain: "x.myshopify.com", sessionId: "sess-1" });
  });

  it("returns null for expired sessions", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() - 1000).toISOString(),
          revoked_at: null,
        },
        error: null,
      },
    ]);
    expect(await getSessionFromRequest(reqWithToken(newSessionToken()))).toBeNull();
  });

  it("returns null for revoked sessions and missing cookies", async () => {
    setSupabaseResponses([
      {
        data: {
          id: "sess-1",
          shop_id: "shop-1",
          shop_domain: "x.myshopify.com",
          expires_at: new Date(Date.now() + 1000).toISOString(),
          revoked_at: new Date().toISOString(),
        },
        error: null,
      },
    ]);
    expect(await getSessionFromRequest(reqWithToken(newSessionToken()))).toBeNull();
    expect(
      await getSessionFromRequest(new Request("https://calderyncompany.com/x")),
    ).toBeNull();
  });

  it("requireDashboardSession throws a 401 JSON Response when unauthenticated", async () => {
    const req = new Request("https://calderyncompany.com/dashboard/api/me");
    try {
      await requireDashboardSession(req);
      expect.unreachable("should have thrown");
    } catch (e) {
      const res = e as Response;
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });
});

describe("revokeAllSessionsForShop", () => {
  it("marks every live session for the shop revoked", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    await revokeAllSessionsForShop("x.myshopify.com");
    const updates = getRecorded("update");
    expect(updates.length).toBe(1);
    expect((updates[0][0] as Record<string, unknown>).revoked_at).toBeTruthy();
    const eqs = getRecorded("eq").flat();
    expect(eqs).toContain("x.myshopify.com");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/session.test.ts` (in `calderyn-shopify-app`)
Expected: FAIL — cannot resolve `../session.server`.

- [ ] **Step 3: Implement the session library**

```typescript
// app/lib/dashboard/session.server.ts
//
// Sessions for the merchant web dashboard. Opaque bearer token in a __Host-
// cookie; only its peppered HMAC-SHA256 hash is stored (same pattern as
// mcp_tokens.server.ts). Session identity is the SHOP, not a person (v1).

import { createHmac, randomBytes } from "node:crypto";
import { getSupabase, resolveShopId } from "../supabase.server";

export const SESSION_COOKIE_NAME = "__Host-calderyn_dash";
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days

function pepper(): string {
  const p = process.env.DASHBOARD_SESSION_PEPPER;
  if (!p || p.length < 32) {
    throw new Error("DASHBOARD_SESSION_PEPPER must be set to a 32+ char secret");
  }
  return p;
}

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

export function newSessionToken(): string {
  // 32 random bytes → 32 base32 chars; 256 % 32 === 0 so `byte % 32` is unbiased.
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < bytes.length; i++) body += BASE32_ALPHA[bytes[i] % 32];
  return `dash_live_${body}`;
}

export function hashSessionToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

export function sessionCookieHeader(raw: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${raw}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionTokenFromCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

export async function createSession(shopDomain: string): Promise<{ raw: string }> {
  const shopId = await resolveShopId(shopDomain);
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .insert({
      shop_id: shopId,
      shop_domain: shopDomain,
      token_hash: hashSessionToken(raw),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export type DashboardSession = {
  shopId: string;
  shopDomain: string;
  sessionId: string;
};

export async function getSessionFromRequest(
  request: Request,
): Promise<DashboardSession | null> {
  const raw = readSessionTokenFromCookie(request);
  if (!raw) return null;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("dashboard_sessions")
    .select("id, shop_id, shop_domain, expires_at, revoked_at")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.revoked_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;

  // Sliding activity marker; failure here must not block the request.
  try {
    await sb
      .from("dashboard_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", data.id);
  } catch {
    /* best effort */
  }

  return {
    shopId: String(data.shop_id),
    shopDomain: String(data.shop_domain),
    sessionId: String(data.id),
  };
}

/** Throws a 401 JSON Response when there is no live session. */
export async function requireDashboardSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function revokeAllSessionsForShop(shopDomain: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain)
    .is("revoked_at", null);
  if (error) throw error;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/session.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/session.server.ts app/lib/dashboard/__tests__/session.test.ts
git commit -m "feat(dashboard): peppered opaque-token session library"
```

---

### Task 3: Shopify OAuth helpers

**Files:**
- Create: `app/lib/dashboard/shopify-oauth.server.ts`
- Test: `app/lib/dashboard/__tests__/shopify-oauth.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/dashboard/__tests__/shopify-oauth.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/shopify-oauth.test.ts`
Expected: FAIL — cannot resolve `../shopify-oauth.server`.

- [ ] **Step 3: Implement the OAuth helpers**

```typescript
// app/lib/dashboard/shopify-oauth.server.ts
//
// Standalone Shopify OAuth for the web dashboard. We run the code grant only
// to PROVE the requester controls the shop — the embedded app already holds
// offline tokens, so the access token returned here is discarded.

import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

export function buildAuthorizeUrl(opts: {
  shop: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const sp = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://${opts.shop}/admin/oauth/authorize?${sp.toString()}`;
}

/**
 * Shopify signs callback query strings: HMAC-SHA256 over the params (minus
 * `hmac`), sorted by key, joined `k=v` with `&`, keyed by the app secret.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */
export function verifyShopifyHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns true if Shopify accepted the code (token is discarded on purpose). */
export async function exchangeCodeForToken(opts: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<boolean> {
  const res = await fetch(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });
  return res.ok;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/shopify-oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/shopify-oauth.server.ts app/lib/dashboard/__tests__/shopify-oauth.test.ts
git commit -m "feat(dashboard): standalone Shopify OAuth helpers"
```

---

### Task 4: HTTP helpers (JSON errors, origin check, rate limit)

**Files:**
- Create: `app/lib/dashboard/http.server.ts`
- Test: `app/lib/dashboard/__tests__/http.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/dashboard/__tests__/http.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  jsonError,
  jsonOk,
  requireSameOrigin,
  rateLimit,
  __resetRateLimiterForTests,
} from "../http.server";

beforeEach(() => {
  process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  __resetRateLimiterForTests();
});

describe("jsonOk / jsonError", () => {
  it("sets content type, no-store, and the error contract", async () => {
    const ok = jsonOk({ a: 1 });
    expect(ok.headers.get("Content-Type")).toContain("application/json");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.json()).toEqual({ a: 1 });

    const err = jsonError(422, "invalid_shop", "Shop domain is malformed");
    expect(err.status).toBe(422);
    expect(await err.json()).toEqual({
      error: "invalid_shop",
      message: "Shop domain is malformed",
    });
  });
});

describe("requireSameOrigin", () => {
  function req(origin?: string) {
    return new Request("https://calderyncompany.com/dashboard/api/x", {
      method: "POST",
      headers: origin ? { Origin: origin } : {},
    });
  }
  it("allows the public and app origins", () => {
    expect(() => requireSameOrigin(req("https://calderyncompany.com"))).not.toThrow();
    expect(() => requireSameOrigin(req("https://app.calderyncompany.com"))).not.toThrow();
  });
  it("throws 403 for foreign or missing origins", () => {
    for (const r of [req("https://evil.com"), req()]) {
      try {
        requireSameOrigin(r);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as Response).status).toBe(403);
      }
    }
  });
});

describe("rateLimit", () => {
  it("allows up to the limit within the window, then refuses", () => {
    for (let i = 0; i < 10; i++) expect(rateLimit("k", 10, 60_000)).toBe(true);
    expect(rateLimit("k", 10, 60_000)).toBe(false);
    expect(rateLimit("other", 10, 60_000)).toBe(true); // independent keys
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/http.test.ts`
Expected: FAIL — cannot resolve `../http.server`.

- [ ] **Step 3: Implement**

```typescript
// app/lib/dashboard/http.server.ts
//
// Shared HTTP plumbing for /dashboard/api/*: JSON envelopes, a CSRF origin
// check for state-changing requests, and a fixed-window in-memory rate
// limiter (per serverless instance — coarse abuse damping, not a guarantee).

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export function jsonOk(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string>) },
  });
}

export function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: JSON_HEADERS,
  });
}

function allowedOrigins(): string[] {
  return [process.env.DASHBOARD_PUBLIC_URL, process.env.SHOPIFY_APP_URL]
    .filter((v): v is string => Boolean(v))
    .map((v) => new URL(v).origin);
}

/** CSRF guard for POST/PUT/DELETE: Origin (or Referer origin) must be ours. */
export function requireSameOrigin(request: Request): void {
  const origin =
    request.headers.get("Origin") ??
    (() => {
      const ref = request.headers.get("Referer");
      try {
        return ref ? new URL(ref).origin : null;
      } catch {
        return null;
      }
    })();
  if (!origin || !allowedOrigins().includes(origin)) {
    throw jsonError(403, "bad_origin");
  }
}

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

export function __resetRateLimiterForTests(): void {
  windows.clear();
}

/** Stable per-client key for rate limiting (Vercel sets x-forwarded-for). */
export function clientIpKey(request: Request, scope: string): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `${scope}:${ip}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/http.server.ts app/lib/dashboard/__tests__/http.test.ts
git commit -m "feat(dashboard): JSON/CSRF/rate-limit HTTP helpers"
```

---

### Task 5: Login + OAuth callback routes

**Files:**
- Create: `app/routes/dashboard.login.tsx`
- Create: `app/routes/dashboard.auth.callback.tsx`
- Test: `app/lib/dashboard/__tests__/auth-routes.test.ts`

The whole flow runs on the apex origin (`DASHBOARD_PUBLIC_URL`) because the waitlist site proxies `/dashboard/*` here — so the state cookie set by `login` IS sent back to `callback`.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/dashboard/__tests__/auth-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const createSession = vi.fn(async () => ({ raw: "dash_live_token" }));
const resolveShopId = vi.fn(async () => "shop-1");
const exchangeCodeForToken = vi.fn(async () => true);

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  createSession,
}));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({}),
  resolveShopId,
}));
vi.mock("../shopify-oauth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shopify-oauth.server")>()),
  exchangeCodeForToken,
}));

import { loader as loginLoader } from "../../../routes/dashboard.login";
import { loader as callbackLoader } from "../../../routes/dashboard.auth.callback";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_KEY = "client-1";
  process.env.SHOPIFY_API_SECRET = "secret-1";
  process.env.SCOPES = "read_products";
  process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  process.env.DASHBOARD_SESSION_PEPPER = "test-pepper-that-is-at-least-32-chars!!";
});

function signedCallbackUrl(params: Record<string, string>): string {
  const sp = new URLSearchParams(params);
  const message = [...sp.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  sp.set("hmac", createHmac("sha256", "secret-1").update(message).digest("hex"));
  return `https://calderyncompany.com/dashboard/auth/callback?${sp.toString()}`;
}

describe("dashboard.login loader", () => {
  it("422s on an invalid shop", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login?shop=evil.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
  });

  it("redirects to the shop's authorize URL and sets a state cookie", async () => {
    const res = (await loginLoader({
      request: new Request(
        "https://calderyncompany.com/dashboard/login?shop=x.myshopify.com",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://x.myshopify.com/admin/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "https://calderyncompany.com/dashboard/auth/callback",
    );
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("dash_oauth=");
    expect(cookie).toContain("HttpOnly");
    expect(loc.searchParams.get("state")).toBe(
      decodeURIComponent(cookie.match(/dash_oauth=([^;]+)/)![1]).split(":")[0],
    );
  });
});

describe("dashboard.auth.callback loader", () => {
  function callbackRequest(url: string, stateCookie: string) {
    return new Request(url, { headers: { Cookie: `dash_oauth=${stateCookie}` } });
  }

  it("sets the session cookie and redirects to /dashboard on success", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=dash_live_token");
    expect(exchangeCodeForToken).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("rejects a state mismatch", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-WRONG",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects a bad HMAC", async () => {
    const url =
      "https://calderyncompany.com/dashboard/auth/callback?shop=x.myshopify.com&code=c&state=nonce-1&timestamp=1&hmac=deadbeef";
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
  });

  it("403s app_not_installed when the shop is unknown", async () => {
    resolveShopId.mockRejectedValueOnce(new Error("Shop not found in Supabase: x"));
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "app_not_installed" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/auth-routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the login route**

```typescript
// app/routes/dashboard.login.tsx
// GET /dashboard/login?shop=x.myshopify.com → 302 to Shopify authorize.
// The state nonce lives in a short-lived HttpOnly cookie as `nonce:shop`.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { randomBytes } from "node:crypto";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
} from "~/lib/dashboard/shopify-oauth.server";
import { jsonError, rateLimit, clientIpKey } from "~/lib/dashboard/http.server";

export const STATE_COOKIE_NAME = "dash_oauth";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!rateLimit(clientIpKey(request, "dash-login"), 10, 60_000)) {
    return jsonError(429, "rate_limited");
  }

  const shop = (new URL(request.url).searchParams.get("shop") ?? "")
    .trim()
    .toLowerCase();
  if (!isValidShopDomain(shop)) {
    return jsonError(422, "invalid_shop", "Expected <name>.myshopify.com");
  }

  const state = randomBytes(16).toString("hex");
  const publicUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    scopes: process.env.SCOPES ?? "",
    redirectUri: `${publicUrl}/dashboard/auth/callback`,
    state,
  });

  return redirect(authorizeUrl, {
    headers: {
      "Set-Cookie": `${STATE_COOKIE_NAME}=${state}:${shop}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
```

- [ ] **Step 4: Implement the callback route**

```typescript
// app/routes/dashboard.auth.callback.tsx
// Finishes the dashboard OAuth round-trip. The exchanged access token is
// discarded — the grant only proves the requester controls the shop. The shop
// must already exist in Supabase (app installed) to get a session.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  isValidShopDomain,
  verifyShopifyHmac,
  exchangeCodeForToken,
} from "~/lib/dashboard/shopify-oauth.server";
import { createSession, sessionCookieHeader } from "~/lib/dashboard/session.server";
import { jsonError, rateLimit, clientIpKey } from "~/lib/dashboard/http.server";
import { resolveShopId } from "~/lib/supabase.server";
import { STATE_COOKIE_NAME } from "./dashboard.login";

function readStateCookie(request: Request): { nonce: string; shop: string } | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE_NAME) {
      const [nonce, shop] = decodeURIComponent(rest.join("=")).split(":");
      if (nonce && shop) return { nonce, shop };
    }
  }
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!rateLimit(clientIpKey(request, "dash-callback"), 10, 60_000)) {
    return jsonError(429, "rate_limited");
  }

  const publicUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  const failure = redirect(`${publicUrl}/dashboard/login?error=oauth_failed`, {
    headers: { "Set-Cookie": `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` },
  });

  const url = new URL(request.url);
  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";

  const cookieState = readStateCookie(request);
  if (
    !isValidShopDomain(shop) ||
    !code ||
    !cookieState ||
    cookieState.nonce !== state ||
    cookieState.shop !== shop ||
    !verifyShopifyHmac(url.searchParams, process.env.SHOPIFY_API_SECRET ?? "")
  ) {
    return failure;
  }

  const accepted = await exchangeCodeForToken({
    shop,
    code,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
  });
  if (!accepted) return failure;

  // Gate: only shops with the app installed (provisioned in Supabase) may in.
  try {
    await resolveShopId(shop);
  } catch {
    return jsonError(403, "app_not_installed");
  }

  const { raw } = await createSession(shop);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return redirect(`${publicUrl}/dashboard`, { headers });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/auth-routes.test.ts`
Expected: PASS. Note: the success-case Set-Cookie assertion checks only the first header; if `headers.get("Set-Cookie")` returns the combined value, `toContain` still passes.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.login.tsx app/routes/dashboard.auth.callback.tsx app/lib/dashboard/__tests__/auth-routes.test.ts
git commit -m "feat(dashboard): Sign-in-with-Shopify login + callback routes"
```

---

### Task 6: Read API endpoints

**Files:**
- Create: `app/routes/dashboard.api.me.tsx`
- Create: `app/routes/dashboard.api.overview.tsx`
- Create: `app/routes/dashboard.api.campaigns._index.tsx`
- Create: `app/routes/dashboard.api.campaigns.$id.tsx`
- Create: `app/routes/dashboard.api.alerts._index.tsx`
- Create: `app/routes/dashboard.api.alerts.$id.tsx`
- Create: `app/routes/dashboard.api.skus.tsx`
- Create: `app/routes/dashboard.api.audit._index.tsx`
- Create: `app/routes/dashboard.api.integrations.tsx`
- Test: `app/lib/dashboard/__tests__/api-read-routes.test.ts`

Every read endpoint is the same thin shape: `requireDashboardSession` → `calderynClient(shopDomain)` query → `jsonOk`. `CalderynError` maps to its own `status`/`code`.

- [ ] **Step 1: Write the failing tests** (representative coverage: the guard, one list route, one detail route with CalderynError mapping)

```typescript
// app/lib/dashboard/__tests__/api-read-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireDashboardSession = vi.fn();
const campaignsList = vi.fn();
const campaignsGet = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession,
}));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      campaigns: { list: campaignsList, get: campaignsGet },
    }),
  };
});

import { CalderynError } from "../../calderyn.server";
import { loader as campaignsLoader } from "../../../routes/dashboard.api.campaigns._index";
import { loader as campaignLoader } from "../../../routes/dashboard.api.campaigns.$id";

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/campaigns", () => {
  it("propagates the 401 thrown by the session guard", async () => {
    requireDashboardSession.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(
      campaignsLoader({
        request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
        params: {},
        context: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns the shop's campaigns as JSON", async () => {
    campaignsList.mockResolvedValueOnce([{ id: "c1", name: "Spring" }]);
    const res = (await campaignsLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ campaigns: [{ id: "c1", name: "Spring" }] });
  });
});

describe("GET /dashboard/api/campaigns/:id", () => {
  it("maps CalderynError to its status and code", async () => {
    campaignsGet.mockRejectedValueOnce(
      new CalderynError({ code: "CAMPAIGN_NOT_FOUND", status: 404, message: "nope" }),
    );
    const res = (await campaignLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns/c9"),
      params: { id: "c9" },
      context: {},
    })) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "CAMPAIGN_NOT_FOUND", message: "nope" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/api-read-routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the shared error mapper** — add to `app/lib/dashboard/http.server.ts`:

```typescript
import { CalderynError } from "../calderyn.server";

/** Wrap a loader/action body: CalderynError → its status/code; rethrow Responses. */
export async function dashboardJson(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return jsonOk(await fn());
  } catch (err) {
    if (err instanceof Response) throw err;
    if (err instanceof CalderynError) {
      return jsonError(err.status, err.code, err.message);
    }
    console.error("[dashboard.api] unhandled error", err);
    return jsonError(500, "internal_error");
  }
}
```

(Add the import at the top of `http.server.ts`.)

- [ ] **Step 4: Implement the routes** — each file is the same pattern; all nine shown:

```typescript
// app/routes/dashboard.api.me.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const onboarding = await calderynClient(session.shopDomain).onboarding.getState();
    return { shop_domain: session.shopDomain, onboarding };
  });
}
```

```typescript
// app/routes/dashboard.api.overview.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [roasSeries, campaigns, openAlerts] = await Promise.all([
      client.analytics.dailyRoasSeries(30),
      client.campaigns.list(),
      client.alerts.list({ status: "open" }),
    ]);
    return {
      roas_series: roasSeries,
      campaign_count: campaigns.length,
      active_campaign_count: campaigns.filter((c) => c.status === "active").length,
      open_alert_count: openAlerts.length,
      open_alert_dollar_impact_cents: openAlerts.reduce(
        (sum, a) => sum + a.dollar_impact,
        0,
      ),
    };
  });
}
```

```typescript
// app/routes/dashboard.api.campaigns._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    campaigns: await calderynClient(session.shopDomain).campaigns.list(),
  }));
}
```

```typescript
// app/routes/dashboard.api.campaigns.$id.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    campaign: await calderynClient(session.shopDomain).campaigns.get(String(params.id)),
  }));
}
```

```typescript
// app/routes/dashboard.api.alerts._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const sp = new URL(request.url).searchParams;
  return dashboardJson(async () => ({
    alerts: await calderynClient(session.shopDomain).alerts.list({
      status: sp.get("status") ?? undefined,
      severity: sp.get("severity") ?? undefined,
      detector: sp.get("detector") ?? undefined,
    }),
  }));
}
```

```typescript
// app/routes/dashboard.api.alerts.$id.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    alert: await calderynClient(session.shopDomain).alerts.get(String(params.id)),
  }));
}
```

```typescript
// app/routes/dashboard.api.skus.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    skus: await calderynClient(session.shopDomain).skus.list(),
  }));
}
```

```typescript
// app/routes/dashboard.api.audit._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    audit: await calderynClient(session.shopDomain).audit.list(),
  }));
}
```

```typescript
// app/routes/dashboard.api.integrations.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    integrations: await calderynClient(session.shopDomain).integrations.list(),
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/api-read-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.*.tsx app/lib/dashboard/http.server.ts app/lib/dashboard/__tests__/api-read-routes.test.ts
git commit -m "feat(dashboard): read API (me, overview, campaigns, alerts, skus, audit, integrations)"
```

---

### Task 7: Write API endpoints (campaign action, guardrails, undo, logout)

**Files:**
- Create: `app/routes/dashboard.api.campaigns.$id.action.tsx`
- Create: `app/routes/dashboard.api.guardrails.tsx` (GET + PUT in one file)
- Create: `app/routes/dashboard.api.audit.$id.undo.tsx`
- Create: `app/routes/dashboard.api.logout.tsx`
- Test: `app/lib/dashboard/__tests__/api-write-routes.test.ts`

Writes delegate to `executeAction` (`app/lib/actions/execute.server.ts`) and `undoAction` (`app/lib/actions/undo.server.ts`) — the exact functions the embedded app and autopilot use — so audit rows, idempotency, retries, and platform calls are identical across surfaces. This is what makes dashboard↔Shopify-app sync structural.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/dashboard/__tests__/api-write-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeAction = vi.fn();
const undoAction = vi.fn();
const guardrailsUpdate = vi.fn();
const revokeSession = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession,
  revokeSession,
}));
vi.mock("../http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http.server")>()),
  requireSameOrigin,
}));
vi.mock("../../actions/execute.server", () => ({ executeAction }));
vi.mock("../../actions/undo.server", () => ({ undoAction }));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      guardrails: { get: vi.fn(async () => ({ cooldown_minutes: 30 })), update: guardrailsUpdate },
    }),
  };
});

import { action as campaignAction } from "../../../routes/dashboard.api.campaigns.$id.action";
import { action as undoRoute } from "../../../routes/dashboard.api.audit.$id.undo";
import { action as guardrailsAction } from "../../../routes/dashboard.api.guardrails";
import { action as logoutAction } from "../../../routes/dashboard.api.logout";

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

function post(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}

describe("POST /dashboard/api/campaigns/:id/action", () => {
  it("executes a pause through the shared action pipeline", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-1", outcome: "succeeded" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "key-1",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-1", outcome: "succeeded" });
    expect(executeAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        kind: "pause_campaign",
        campaignId: "c1",
        idempotencyKey: "key-1",
        actor: "merchant:web-dashboard",
      }),
      expect.anything(),
    );
  });

  it("422s on a bad action type and on a missing budget for budget changes", async () => {
    for (const body of [
      { type: "delete_campaign", idempotency_key: "k" },
      { type: "reduce_campaign_budget", idempotency_key: "k" },
    ]) {
      const res = (await campaignAction({
        request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", body),
        params: { id: "c1" },
        context: {},
      })) as Response;
      expect(res.status).toBe(422);
    }
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("returns 502 with the audit id when the platform call failed", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-2", outcome: "failed" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "k2",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "action_failed",
      audit_id: "audit-2",
      outcome: "failed",
    });
  });
});

describe("PUT /dashboard/api/guardrails", () => {
  it("applies the patch via calderynClient.guardrails.update", async () => {
    guardrailsUpdate.mockResolvedValueOnce({ cooldown_minutes: 45 });
    const res = (await guardrailsAction({
      request: post(
        "https://calderyncompany.com/dashboard/api/guardrails",
        { cooldown_minutes: 45 },
        "PUT",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(guardrailsUpdate).toHaveBeenCalledWith({ cooldown_minutes: 45 });
  });

  it("405s non-PUT methods", async () => {
    const res = (await guardrailsAction({
      request: post("https://calderyncompany.com/dashboard/api/guardrails", {}, "PATCH"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(405);
  });
});

describe("POST /dashboard/api/audit/:id/undo", () => {
  it("delegates to undoAction with the session's shop", async () => {
    undoAction.mockResolvedValueOnce({ id: "audit-3" });
    const res = (await undoRoute({
      request: post("https://calderyncompany.com/dashboard/api/audit/a1/undo", {}),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-3" });
    expect(undoAction).toHaveBeenCalledWith("shop-1", "a1", expect.anything());
  });
});

describe("POST /dashboard/api/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const res = (await logoutAction({
      request: post("https://calderyncompany.com/dashboard/api/logout", {}),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith("sess-1");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/lib/dashboard/__tests__/api-write-routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement the four routes**

```typescript
// app/routes/dashboard.api.campaigns.$id.action.tsx
// POST { type, idempotency_key, daily_budget_cents? } → shared action pipeline.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import { getSupabase } from "~/lib/supabase.server";

const KINDS: ExecutableKind[] = ["pause_campaign", "resume_campaign", "reduce_campaign_budget"];

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const kind = body.type as ExecutableKind;
  const idempotencyKey = String(body.idempotency_key ?? "");
  const dailyBudgetCents =
    body.daily_budget_cents === undefined ? undefined : Number(body.daily_budget_cents);

  if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");
  if (
    kind === "reduce_campaign_budget" &&
    (!Number.isFinite(dailyBudgetCents) || (dailyBudgetCents as number) <= 0)
  ) {
    return jsonError(422, "invalid_daily_budget_cents");
  }

  return dashboardJson(async () => {
    const result = await executeAction(
      session.shopId,
      {
        alertId: typeof body.alert_id === "string" ? body.alert_id : null,
        kind,
        campaignId: String(params.id),
        idempotencyKey,
        dailyBudgetCents,
        actor: "merchant:web-dashboard",
      },
      getSupabase(),
    );
    if (result.outcome === "failed") {
      // Surface the pipeline's terminal failure; retrying is parked for cron.
      throw new Response(
        JSON.stringify({ error: "action_failed", audit_id: result.id, outcome: result.outcome }),
        { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    return { audit_id: result.id, outcome: result.outcome };
  }).catch((e) => (e instanceof Response ? e : Promise.reject(e)));
}
```

```typescript
// app/routes/dashboard.api.guardrails.tsx
// GET returns the config; PUT applies a partial update through calderynClient
// (same column mapping the embedded settings page uses).

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import type { GuardrailConfig } from "~/lib/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.get(),
  }));
}

const PATCHABLE_KEYS: (keyof GuardrailConfig)[] = [
  "daily_action_budget_cents",
  "dollar_cap_cents",
  "cooldown_minutes",
  "business_hours",
  "autopilot_enabled",
  "autopilot_daily_action_cap",
  "autopilot_min_spend_cents",
  "autopilot_max_budget_cut_pct",
];

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const patch: Partial<GuardrailConfig> = {};
  for (const key of PATCHABLE_KEYS) {
    if (key in body) (patch as Record<string, unknown>)[key] = body[key];
  }
  if (Object.keys(patch).length === 0) return jsonError(422, "empty_patch");

  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.update(patch),
  }));
}
```

```typescript
// app/routes/dashboard.api.audit.$id.undo.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { undoAction } from "~/lib/actions/undo.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  return dashboardJson(async () => {
    const result = await undoAction(session.shopId, String(params.id), getSupabase());
    return { audit_id: result.id };
  });
}
```

```typescript
// app/routes/dashboard.api.logout.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import {
  requireDashboardSession,
  revokeSession,
  clearSessionCookieHeader,
} from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  await revokeSession(session.sessionId);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/lib/dashboard/__tests__/api-write-routes.test.ts`
Expected: PASS. (If the 502 test fails because `dashboardJson` converts the thrown Response: the `.catch` in the campaign action route returns thrown Responses — verify that path. The thrown Response must be RETURNED to the client, not rethrown to Remix.)

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.campaigns.\$id.action.tsx app/routes/dashboard.api.guardrails.tsx app/routes/dashboard.api.audit.\$id.undo.tsx app/routes/dashboard.api.logout.tsx app/lib/dashboard/__tests__/api-write-routes.test.ts
git commit -m "feat(dashboard): write API via shared action pipeline + logout"
```

---

### Task 8: Realtime token endpoint + RLS migration

**Files:**
- Create: `supabase/migrations/20260609140000_dashboard_realtime.sql`
- Create: `app/routes/dashboard.api.realtime-token.tsx`
- Test: `app/lib/dashboard/__tests__/realtime-token.test.ts`

- [ ] **Step 1: Verify the MCP server is not relying on table grants for the affected tables**

Run in `C:\Users\famou\Desktop\calderyn-mcp`:
```powershell
Get-Content .env.local; Select-String -Path src\*.ts,src\**\*.ts -Pattern "SERVICE_ROLE|ANON"
```
Expected: the MCP server uses `SUPABASE_SERVICE_ROLE_KEY` (service role bypasses RLS, so enabling RLS on `alerts`, `action_audit`, `ad_campaign_dim` is safe). **If it uses the anon key, STOP and flag to the user before applying the migration** — enabling RLS would break the MCP server.

- [ ] **Step 2: Write the migration**

```sql
-- Shop-scoped read access for dashboard Realtime subscriptions.
-- The dashboard backend mints short-lived JWTs (role=authenticated) carrying a
-- `shop_id` claim; these policies let that JWT SELECT only its shop's rows.
-- Service-role access (app, MCP, crons) bypasses RLS and is unaffected.

alter table public.alerts enable row level security;
alter table public.action_audit enable row level security;
alter table public.ad_campaign_dim enable row level security;

drop policy if exists dashboard_read_alerts on public.alerts;
create policy dashboard_read_alerts on public.alerts
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

drop policy if exists dashboard_read_action_audit on public.action_audit;
create policy dashboard_read_action_audit on public.action_audit
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

drop policy if exists dashboard_read_ad_campaign_dim on public.ad_campaign_dim;
create policy dashboard_read_ad_campaign_dim on public.ad_campaign_dim
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

-- Realtime publication (idempotent adds).
do $$
begin
  begin
    alter publication supabase_realtime add table public.alerts;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.action_audit;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ad_campaign_dim;
  exception when duplicate_object then null;
  end;
end $$;
```

- [ ] **Step 3: Apply the migration**

Use `mcp__supabase__apply_migration` with `project_id: "ajgrmnvzxfxxlwrxcgnu"`, `name: "dashboard_realtime"`, and the SQL above.
Expected: success. Then run `mcp__supabase__get_advisors` (type: security) and confirm no new criticals.

- [ ] **Step 4: Write the failing test**

```typescript
// app/lib/dashboard/__tests__/realtime-token.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { jwtVerify } from "jose";

const requireDashboardSession = vi.fn();
vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession,
}));

import { loader } from "../../../routes/dashboard.api.realtime-token";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = "super-secret-jwt-key-for-tests-32chars";
  requireDashboardSession.mockResolvedValue({
    shopId: "11111111-2222-3333-4444-555555555555",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/realtime-token", () => {
  it("mints a 1h authenticated JWT carrying the shop_id claim", async () => {
    const res = (await loader({
      request: new Request("https://calderyncompany.com/dashboard/api/realtime-token"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };

    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET),
    );
    expect(payload.role).toBe("authenticated");
    expect(payload.shop_id).toBe("11111111-2222-3333-4444-555555555555");
    const ttlMs = (payload.exp! * 1000) - Date.now();
    expect(ttlMs).toBeGreaterThan(55 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60_000);
    expect(new Date(expires_at).getTime()).toBeCloseTo(payload.exp! * 1000, -3);
  });

  it("503s when SUPABASE_JWT_SECRET is not configured", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const res = (await loader({
      request: new Request("https://calderyncompany.com/dashboard/api/realtime-token"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -- app/lib/dashboard/__tests__/realtime-token.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 6: Implement the route**

```typescript
// app/routes/dashboard.api.realtime-token.tsx
// Mints a short-lived Supabase JWT (role=authenticated, shop_id claim) so the
// dashboard UI can open a Realtime subscription scoped by the RLS policies in
// migration 20260609140000_dashboard_realtime.sql. Polling the read API is the
// fallback when this is unavailable.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { SignJWT } from "jose";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonOk, jsonError } from "~/lib/dashboard/http.server";

const TTL_SECONDS = 3600;

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return jsonError(503, "realtime_not_configured");

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = await new SignJWT({
    role: "authenticated",
    shop_id: session.shopId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(secret));

  return jsonOk({ token, expires_at: new Date(exp * 1000).toISOString() });
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- app/lib/dashboard/__tests__/realtime-token.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260609140000_dashboard_realtime.sql app/routes/dashboard.api.realtime-token.tsx app/lib/dashboard/__tests__/realtime-token.test.ts
git commit -m "feat(dashboard): shop-scoped Realtime token + RLS policies"
```

---

### Task 9: Revoke sessions on uninstall + config/env

**Files:**
- Modify: `app/routes/webhooks.app.uninstalled.tsx`
- Modify: `shopify.app.calderynextension.toml`
- Modify: `.env.example`

- [ ] **Step 1: Add session revocation to the uninstall webhook** — in `app/routes/webhooks.app.uninstalled.tsx`, add the import and a revocation block after `markShopUninstalled`:

```typescript
import { revokeAllSessionsForShop } from "~/lib/dashboard/session.server";
```

and after the `markShopUninstalled(shop)` try/catch:

```typescript
  try {
    await revokeAllSessionsForShop(shop);
  } catch (err) {
    console.error(`Failed to revoke dashboard sessions for ${shop}`, err);
  }
```

- [ ] **Step 2: Register the apex redirect URL** — in `shopify.app.calderynextension.toml`, extend `[auth].redirect_urls`:

```toml
redirect_urls = [
  "https://app.calderyncompany.com/auth/callback",
  "https://app.calderyncompany.com/auth/shopify/callback",
  "https://app.calderyncompany.com/api/auth/callback",
  "https://calderyncompany.com/dashboard/auth/callback",
  "https://app.calderyncompany.com/dashboard/auth/callback"
]
```

- [ ] **Step 3: Document the new env vars** — append to `.env.example` (names only):

```bash
# Web dashboard (calderyncompany.com/dashboard)
DASHBOARD_SESSION_PEPPER=   # 32+ char random secret; HMAC pepper for session tokens
DASHBOARD_PUBLIC_URL=       # https://calderyncompany.com in prod; app URL in dev
SUPABASE_JWT_SECRET=        # Supabase project JWT secret (Settings -> API); for Realtime tokens
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 5: Push the config to Shopify**

Run: `npm run deploy` (i.e. `shopify app deploy`) — required for Shopify to accept the new redirect URL. If not authenticated in this terminal, flag to the user instead of guessing credentials.

- [ ] **Step 6: Commit**

```bash
git add app/routes/webhooks.app.uninstalled.tsx shopify.app.calderynextension.toml .env.example
git commit -m "feat(dashboard): uninstall revocation, apex redirect URL, env docs"
```

---

### Task 10: Waitlist repo — rewrites + CSP (repo: `C:\Users\famou\Desktop\calderyn-waitlist`)

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add rewrites** — in `vercel.json`, add a top-level `rewrites` key (order matters: Vercel checks filesystem first with `cleanUrls`, but `/dashboard` has no file, so rewrites apply):

```json
"rewrites": [
  { "source": "/dashboard", "destination": "https://app.calderyncompany.com/dashboard" },
  { "source": "/dashboard/:path*", "destination": "https://app.calderyncompany.com/dashboard/:path*" }
]
```

- [ ] **Step 2: Extend the CSP for the future dashboard UI** — in the existing `Content-Security-Policy` header value, change `connect-src 'self'` to:

```
connect-src 'self' https://ajgrmnvzxfxxlwrxcgnu.supabase.co wss://ajgrmnvzxfxxlwrxcgnu.supabase.co
```

- [ ] **Step 3: Deploy and verify the proxy**

```powershell
npm run deploy
Invoke-WebRequest -Uri "https://calderyncompany.com/dashboard/api/me" -SkipHttpErrorCheck | Select-Object StatusCode, Content
```
Expected: `401` with `{"error":"unauthenticated"}` — proves the rewrite reaches the new backend and the gate works. (Until the app side is deployed, this returns the app's 404 instead; deploy order: app first.)

- [ ] **Step 4: Commit**

```bash
git add vercel.json
git commit -m "feat(dashboard): proxy /dashboard/* to app backend + CSP for Supabase Realtime"
```

---

### Task 11: End-to-end verification

- [ ] **Step 1: Set the new env vars in Vercel** (calderyn-shopify-app project): `DASHBOARD_SESSION_PEPPER` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `DASHBOARD_PUBLIC_URL=https://calderyncompany.com`, `SUPABASE_JWT_SECRET` (from Supabase dashboard). Redeploy the app.

- [ ] **Step 2: Manual OAuth flow against the dev store**

Open `https://calderyncompany.com/dashboard/login?shop=<dev-store>.myshopify.com` in a browser. Expected: Shopify consent → redirect to `https://calderyncompany.com/dashboard` with the `__Host-calderyn_dash` cookie set.

- [ ] **Step 3: Cross-surface sync check**

```powershell
# With the browser cookie exported into $cookie:
Invoke-WebRequest "https://calderyncompany.com/dashboard/api/guardrails" -Headers @{Cookie=$cookie}
```
Then change a guardrail in the embedded Shopify admin app, re-fetch — the new value must appear. Then PUT a guardrail change via the dashboard API and confirm the embedded app's settings page reflects it.

- [ ] **Step 4: Confirm 401 after logout and after uninstall/reinstall of the dev store.**
