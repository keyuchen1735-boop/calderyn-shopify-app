# Analytics Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Live" subtab in the dashboard Analytics screen showing real-time owned-storefront activity (visitors now, today's sales/sessions/orders, cart→checkout→purchase funnel, sessions by location, new vs returning, top products), fed by server-side events emitted from the SSR storefront, refreshed by a 60s visibility-gated poll plus a Supabase Realtime "order ping".

**Architecture:** Storefront loaders/actions emit PII-free rows into a new `storefront_event` table via the service-role Supabase client (fire-and-forget, failure-isolated). One new resource route `dashboard.api.analytics-live` assembles a snapshot DTO with plain PostgREST reads + JS aggregation (repo convention). The dashboard subtab self-fetches via `apiGet` and becomes the first consumer of the existing `getRealtimeToken()` seam.

**Tech Stack:** Remix (Vite), TypeScript strict, Supabase (PostgREST + Realtime), vitest (mock-DB convention, no real test DB), cd-* dashboard primitives.

**Spec:** `docs/superpowers/specs/2026-07-02-analytics-live-view-design.md`. Grounded deviations from the spec (all verified against the codebase):
1. `checkout_complete` is emitted from the **confirmation page loader** (payment is confirmed by the Stripe webhook, which has no browser cookies). Reload duplicates are harmless — the funnel counts distinct sessions.
2. `cart_add` is emitted from the **PDP action** (`storefront.products.$handle.tsx`) — the cart route is read-only.
3. The order ping listens to **INSERT + UPDATE** on `orders` (rows are born `checkout_pending`; the paid flip is an UPDATE).
4. `top_products[].product_id` carries `order_line.variant_id` (repo invariant: owned `variant_dim.id == sku_dim.id`); titles come from `order_line.title_snapshot` — no `sku_dim` join needed.
5. Retention rides the existing `cron.gdpr` sweep — no new cron entry.
6. Cookie names are `cd_vid` / `cd_sid` (matching the existing `cd_cart` convention), not `cal_*`.

**Worktree:** `/Users/ericchen/Developer/calderyn-analytics-live-view` on branch `feat/analytics-live-view`. All commands run there. Baselines verified green: `npm run typecheck` exit 0, `npx vitest run` exit 0.

---

### Task 1: Migration — `storefront_event` table + orders Realtime

**Files:**
- Create: `supabase/migrations/20260702160000_storefront_event.sql`
- Read (decision step): `app/lib/security/__tests__/tenant-tables.test.ts`, `app/lib/security/tenant-tables.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Live View event intake (spec 2026-07-02-analytics-live-view-design.md).
-- Server-side pageview/funnel events from the owned SSR storefront. No PII by
-- design: opaque visitor/session UUIDs + coarse Vercel geo only — no IP, no
-- user-agent, no email. Written and read via the service-role client; the RLS
-- shop-scope policy follows the Step 10 tenant-isolation convention. Realtime
-- is NOT enabled on this table — the dashboard live ping rides `orders`.

create table if not exists public.storefront_event (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  session_id   uuid not null,
  visitor_id   uuid not null,
  is_returning boolean not null default false,
  type         text not null check (type in ('page_view','cart_add','checkout_start','checkout_complete')),
  path         text not null,
  product_id   text,
  country      text,
  city         text,
  created_at   timestamptz not null default now()
);

-- The live endpoint always filters shop_id + a created_at window.
create index if not exists storefront_event_shop_time_idx
  on public.storefront_event (shop_id, created_at desc);

alter table public.storefront_event enable row level security;
drop policy if exists storefront_event_shop_scope on public.storefront_event;
create policy storefront_event_shop_scope on public.storefront_event
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.storefront_event from anon, authenticated;

-- Dashboard live "order ping": let the shop-scoped dashboard Realtime JWT see
-- this shop's orders change events (INSERT at checkout creation, UPDATE on the
-- paid flip) — same pattern as 20260609140000_dashboard_realtime.sql. The JWT
-- policy is additive (permissive OR) next to orders_shop_scope, which resolves
-- to NULL/deny for role `authenticated`. Orders rows hold no direct PII
-- (buyer PII lives in buyer_dim).
grant select on table public.orders to authenticated;
drop policy if exists dashboard_read_orders on public.orders;
create policy dashboard_read_orders on public.orders
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

do $$
begin
  begin
    alter publication supabase_realtime add table public.orders;
  exception when duplicate_object then null;
  end;
end $$;
```

- [ ] **Step 2: Classify the table in the tenant-isolation manifest — decision rule**

Read `app/lib/security/__tests__/tenant-tables.test.ts`. It asserts the manifest against migration `20260702120000_tenant_isolation_hardening.sql`:
- If the test only asserts the original 49-table set against that one migration (`NO_POLICY_TABLE_COUNT = 49` style assertions), do NOT touch the manifest — our migration self-contains its RLS.
- If the test scans all migrations / the live table list, add `"storefront_event"` to `SHOP_SCOPE_POLICY_TABLES` in `app/lib/security/tenant-tables.ts` and update any count constant it enforces.

- [ ] **Step 3: Run the tenant-tables test**

Run: `npx vitest run app/lib/security/__tests__/tenant-tables.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260702160000_storefront_event.sql app/lib/security/tenant-tables.ts
git commit -m "supabase/migrations: storefront_event table + orders realtime for live view"
```

---

### Task 2: Visitor/session cookies

**Files:**
- Create: `app/lib/storefront/visitor-cookie.server.ts`
- Test: `app/lib/storefront/__tests__/visitor-cookie.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/visitor-cookie.test.ts
import { describe, it, expect } from "vitest";
import { ensureVisitorSession, SESSION_IDLE_SEC } from "../visitor-cookie.server";

/** Turn Set-Cookie headers from a previous response into a Cookie request header. */
function cookieHeaderFrom(headers: Headers, names: string[]): string {
  const pairs: string[] = [];
  for (const sc of headers.getSetCookie()) {
    const first = sc.split(";")[0];
    if (names.some((n) => first.startsWith(`${n}=`))) pairs.push(first);
  }
  return pairs.join("; ");
}

function req(cookie?: string): Request {
  return new Request("https://x.example/storefront", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("ensureVisitorSession", () => {
  it("first visit: mints visitor + session, not returning, sets both cookies", async () => {
    const s = await ensureVisitorSession(req());
    expect(s.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.isReturning).toBe(false);
    const setCookies = s.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("cd_vid="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("cd_sid="))).toBe(true);
    // rolling session: sid carries the 30-min max-age
    const sid = setCookies.find((c) => c.startsWith("cd_sid="))!;
    expect(sid).toContain(`Max-Age=${SESSION_IDLE_SEC}`);
  });

  it("same session: ids stable, vid cookie not re-set, sid re-committed (rolling)", async () => {
    const first = await ensureVisitorSession(req());
    const cookie = cookieHeaderFrom(first.headers, ["cd_vid", "cd_sid"]);
    const second = await ensureVisitorSession(req(cookie));
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.isReturning).toBe(first.isReturning);
    const setCookies = second.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("cd_vid="))).toBe(false);
    expect(setCookies.some((c) => c.startsWith("cd_sid="))).toBe(true);
  });

  it("expired session with surviving visitor cookie: new session marked returning", async () => {
    const first = await ensureVisitorSession(req());
    const vidOnly = cookieHeaderFrom(first.headers, ["cd_vid"]);
    const second = await ensureVisitorSession(req(vidOnly));
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.isReturning).toBe(true);
  });

  it("returning flag is frozen at session start (mid-session requests can't flip it)", async () => {
    const first = await ensureVisitorSession(req());
    const vidOnly = cookieHeaderFrom(first.headers, ["cd_vid"]);
    const returning = await ensureVisitorSession(req(vidOnly)); // returning session starts
    const both = cookieHeaderFrom(returning.headers, ["cd_sid"]) + "; " + vidOnly;
    const mid = await ensureVisitorSession(req(both));
    expect(mid.sessionId).toBe(returning.sessionId);
    expect(mid.isReturning).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/storefront/__tests__/visitor-cookie.test.ts`
Expected: FAIL — cannot resolve `../visitor-cookie.server`

- [ ] **Step 3: Implement**

```ts
// app/lib/storefront/visitor-cookie.server.ts
// First-party visitor/session identity for storefront live analytics
// (spec 2026-07-02-analytics-live-view-design.md). cd_vid: 1-year visitor id.
// cd_sid: 30-minute rolling session id carrying the is_returning flag frozen
// at session start. Opaque UUIDs only — never PII. Mirrors cart-cookie.server.
import { createCookie } from "@remix-run/node";
import { randomUUID } from "node:crypto";

const VID_NAME = "cd_vid";
const SID_NAME = "cd_sid";
const VID_MAX_AGE_SEC = 60 * 60 * 24 * 365;
export const SESSION_IDLE_SEC = 60 * 30;

function cookieOpts(maxAge: number) {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge,
    secrets: secret ? [secret] : [],
  };
}

const vidCookie = () => createCookie(VID_NAME, cookieOpts(VID_MAX_AGE_SEC));
const sidCookie = () => createCookie(SID_NAME, cookieOpts(SESSION_IDLE_SEC));

export interface VisitorSession {
  visitorId: string;
  sessionId: string;
  isReturning: boolean;
  /** Set-Cookie headers to append to the response (vid once, sid rolling). */
  headers: Headers;
}

const SID_VALUE_RE = /^([0-9a-f-]{36})\.(r|n)$/;

/** Read-or-create the visitor + session identity for this request. */
export async function ensureVisitorSession(request: Request): Promise<VisitorSession> {
  const cookieHeader = request.headers.get("Cookie");
  const vidRaw: unknown = await vidCookie().parse(cookieHeader);
  const sidRaw: unknown = await sidCookie().parse(cookieHeader);

  const hadVisitor = typeof vidRaw === "string" && vidRaw.length > 0;
  const visitorId = hadVisitor ? (vidRaw as string) : randomUUID();

  // The sid value is "<uuid>.r" | "<uuid>.n" — freezing the returning flag at
  // session start so a mid-session request can't flip it after the vid lands.
  const m = typeof sidRaw === "string" ? SID_VALUE_RE.exec(sidRaw) : null;
  const sessionId = m ? m[1] : randomUUID();
  const isReturning = m ? m[2] === "r" : hadVisitor;

  const headers = new Headers();
  if (!hadVisitor) {
    headers.append("Set-Cookie", await vidCookie().serialize(visitorId));
  }
  // Always re-commit the sid: rolling 30-minute inactivity expiry.
  headers.append(
    "Set-Cookie",
    await sidCookie().serialize(`${sessionId}.${isReturning ? "r" : "n"}`),
  );
  return { visitorId, sessionId, isReturning, headers };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/storefront/__tests__/visitor-cookie.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/storefront/visitor-cookie.server.ts app/lib/storefront/__tests__/visitor-cookie.test.ts
git commit -m "lib/storefront: visitor/session cookies for live analytics"
```

---

### Task 3: Event emitter

**Files:**
- Create: `app/lib/storefront/events.server.ts`
- Test: `app/lib/storefront/__tests__/events.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

import { trackStorefrontEvent } from "../events.server";

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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/storefront/__tests__/events.server.test.ts`
Expected: FAIL — cannot resolve `../events.server`

- [ ] **Step 3: Implement**

```ts
// app/lib/storefront/events.server.ts
// Live-analytics event emitter for the owned storefront (spec
// 2026-07-02-analytics-live-view-design.md). Awaited for serverless safety but
// failure-isolated: a failed insert logs and never blocks a buyer-facing
// render (rule 12: visible in logs, invisible to the buyer). No PII: opaque
// ids + coarse Vercel geo only. The user-agent is checked for bots, never stored.
import { getSupabase } from "../supabase.server";
import { ensureVisitorSession, type VisitorSession } from "./visitor-cookie.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ponytail: naive UA screen; upgrade to real bot scoring only if numbers skew.
const BOT_UA_RE = /bot|crawler|spider|crawling|preview|headless|lighthouse|slurp|curl\b/i;

export type StorefrontEventType =
  | "page_view"
  | "cart_add"
  | "checkout_start"
  | "checkout_complete";

/**
 * Record one storefront event and return the visitor/session Set-Cookie
 * headers the caller must attach to its response. Cookies are always
 * returned — even when the emit is skipped (demo tenant, bot) or fails.
 */
export async function trackStorefrontEvent(
  request: Request,
  shopId: string,
  type: StorefrontEventType,
  opts: { productId?: string | null } = {},
): Promise<Headers> {
  const session = await ensureVisitorSession(request);
  await insertEvent(request, shopId, type, session, opts.productId ?? null);
  return session.headers;
}

async function insertEvent(
  request: Request,
  shopId: string,
  type: StorefrontEventType,
  s: VisitorSession,
  productId: string | null,
): Promise<void> {
  try {
    // Fixture tenants (resolveStorefrontShop's "demo-shop") never reach the DB.
    if (!UUID_RE.test(shopId)) return;
    const ua = request.headers.get("user-agent") ?? "";
    if (BOT_UA_RE.test(ua)) return;
    const { error } = await getSupabase().from("storefront_event").insert({
      shop_id: shopId,
      session_id: s.sessionId,
      visitor_id: s.visitorId,
      is_returning: s.isReturning,
      type,
      path: new URL(request.url).pathname,
      product_id: productId,
      country: request.headers.get("x-vercel-ip-country"),
      city: request.headers.get("x-vercel-ip-city"),
    });
    if (error) throw error;
  } catch (err) {
    console.error("[storefront_event] emit failed", err);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/storefront/__tests__/events.server.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/storefront/events.server.ts app/lib/storefront/__tests__/events.server.test.ts
git commit -m "lib/storefront: live-analytics event emitter (PII-free, bot-screened)"
```

---

### Task 4: Wire the storefront routes

**Files:**
- Modify: `app/routes/storefront._index.tsx` (loader)
- Modify: `app/routes/storefront.products.$handle.tsx` (loader + action)
- Modify: `app/routes/storefront.collections.$handle.tsx` (loader)
- Modify: `app/routes/storefront.cart.tsx` (loader)
- Modify: `app/routes/storefront.checkout.tsx` (loader)
- Modify: `app/routes/storefront.checkout.confirmation.$token.tsx` (loader)
- Test: `app/routes/__tests__/storefront.track-wiring.test.ts`

Pattern for every GET loader — emit exactly one event, merge the returned cookie headers into the existing `json(...)`. The confirmation route already returns `json(data, { headers })`; follow that exact convention everywhere (verified shipped-and-working for the cart-clear cookie).

- [ ] **Step 1: Write the failing wiring test (one representative loader + the PDP action)**

```ts
// app/routes/__tests__/storefront.track-wiring.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const track = vi.fn(async () => {
  const h = new Headers();
  h.append("Set-Cookie", "cd_sid=test.n; Path=/");
  return h;
});
vi.mock("../../lib/storefront/events.server", () => ({
  trackStorefrontEvent: (...a: unknown[]) => track(...a),
}));
vi.mock("../../lib/storefront/shop.server", () => ({
  resolveStorefrontShop: vi.fn(async () => "11111111-2222-3333-4444-555555555555"),
}));
vi.mock("../../lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    getProduct: vi.fn(async () => ({ id: "p1", handle: "mug", title: "Mug", variants: [] })),
  }),
}));
vi.mock("../../lib/storebuilder/page-document.server", () => ({
  loadPublishedDoc: vi.fn(async () => null),
}));
vi.mock("../../lib/storebuilder/resolve-data.server", () => ({
  resolveRenderData: vi.fn(async () => null),
}));
vi.mock("../../lib/storefront/cart-cookie.server", () => ({
  readCartId: vi.fn(async () => "cart-1"),
  commitCartId: vi.fn(async () => "cd_cart=cart-1; Path=/"),
  clearCartId: vi.fn(async () => "cd_cart=; Path=/"),
}));
vi.mock("../../lib/order/cart.server", () => ({
  buildCart: vi.fn(async () => ({ id: "cart-1" })),
  addCartLine: vi.fn(async () => undefined),
}));

import { loader as pdpLoader, action as pdpAction } from "../storefront.products.$handle";

beforeEach(() => track.mockClear());

describe("storefront live-analytics wiring", () => {
  it("PDP loader emits page_view with the variant id and forwards Set-Cookie", async () => {
    const res = (await pdpLoader({
      request: new Request("https://x.example/storefront/products/mug"),
      params: { handle: "mug" },
      context: {},
    })) as Response;
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("page_view");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cd_sid="))).toBe(true);
  });

  it("PDP action emits cart_add and still redirects to the cart", async () => {
    const form = new FormData();
    form.set("variantId", "v1");
    const res = (await pdpAction({
      request: new Request("https://x.example/storefront/products/mug", { method: "POST", body: form }),
      params: { handle: "mug" },
      context: {},
    })) as Response;
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("cart_add");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cd_sid="))).toBe(true);
  });
});
```

NOTE: before writing this test, open `app/routes/storefront.products.$handle.tsx` and confirm the exact module specifiers it imports (`~/lib/...` maps to relative `../../lib/...` in vi.mock — vitest resolves `~` via vite-tsconfig-paths, so mock with the SAME specifier the route uses, e.g. `vi.mock("~/lib/storefront/events.server", ...)` if that is how imports appear). Adjust the mock specifiers to match; the existing `app/routes/__tests__/storefront.cart-action.test.ts` shows the working convention — copy it.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/storefront.track-wiring.test.ts`
Expected: FAIL — `track` not called (wiring absent)

- [ ] **Step 3: Wire each route**

`storefront._index.tsx` loader — replace the final `return json({ doc, data });` with:

```ts
  const track = await trackStorefrontEvent(request, shopId, "page_view");
  return json({ doc, data }, { headers: track });
```

and add the import at the top:

```ts
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
```

`storefront.products.$handle.tsx` loader — replace `return json({ product, doc, data, record });` with:

```ts
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    productId: product.id,
  });
  return json({ product, doc, data, record }, { headers: track });
```

`storefront.products.$handle.tsx` action — after `await addCartLine(shopId, cartId, variantId, 1);` and before the redirect, emit and merge cookie headers into the SAME `headers` object the action already builds:

```ts
  const track = await trackStorefrontEvent(request, shopId, "cart_add", {
    productId: variantId,
  });
  for (const c of track.getSetCookie()) headers.append("Set-Cookie", c);
  return redirect("/storefront/cart", { headers });
```

`storefront.collections.$handle.tsx` loader — replace `return json({ handle, title, products, doc, data, record });` with:

```ts
  const track = await trackStorefrontEvent(request, shopId, "page_view");
  return json({ handle, title, products, doc, data, record }, { headers: track });
```

`storefront.cart.tsx` loader — both returns get headers:

```ts
  const track = await trackStorefrontEvent(request, shopId, "page_view");
  if (!cartId) return json({ cart: null }, { headers: track });
  const cart = await priceCart(shopId, cartId);
  return json({ cart }, { headers: track });
```

(move the `readCartId` call above the track call if needed; order is not significant)

`storefront.checkout.tsx` loader — emit `checkout_start` and merge into its existing return (open the file; it returns `json({...})` after pricing the cart — add `{ headers: track }` the same way).

`storefront.checkout.confirmation.$token.tsx` loader — the loader already builds `const headers = new Headers();`. After the `captured` computation, add:

```ts
  const track = await trackStorefrontEvent(
    request,
    shopId,
    captured ? "checkout_complete" : "page_view",
  );
  for (const c of track.getSetCookie()) headers.append("Set-Cookie", c);
```

(the existing `return json({...}, { headers })` then carries both cookie sets)

- [ ] **Step 4: Run the wiring test + full suite + typecheck**

Run: `npx vitest run app/routes/__tests__/storefront.track-wiring.test.ts` → PASS
Run: `npx vitest run` → PASS (existing storefront route tests must still pass; if `storefront.cart-action.test.ts` / `storefront.checkout-action.test.ts` fail on the new emitter import, add the same `vi.mock` for `events.server` there returning empty Headers)
Run: `npm run typecheck` → exit 0

- [ ] **Step 5: Commit**

```bash
git add app/routes/storefront._index.tsx app/routes/storefront.products.\$handle.tsx \
  app/routes/storefront.collections.\$handle.tsx app/routes/storefront.cart.tsx \
  app/routes/storefront.checkout.tsx app/routes/storefront.checkout.confirmation.\$token.tsx \
  app/routes/__tests__/storefront.track-wiring.test.ts
git commit -m "routes/storefront.*: emit live-analytics events from loaders/actions"
```

---

### Task 5: Snapshot builder (server aggregation)

**Files:**
- Create: `app/lib/dashboard/live-analytics.server.ts`
- Test: `app/lib/dashboard/__tests__/live-analytics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/dashboard/__tests__/live-analytics.test.ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildLiveSnapshot, storeTodayStartIso } from "../live-analytics.server";

const NOW = new Date("2026-07-02T20:00:00Z"); // 4pm America/New_York (EDT, UTC-4)

describe("storeTodayStartIso", () => {
  it("returns the most recent store-local midnight as a UTC instant", () => {
    // New York local midnight on Jul 2 EDT = 04:00Z
    expect(storeTodayStartIso("America/New_York", NOW)).toBe("2026-07-02T04:00:00.000Z");
  });
  it("UTC store: plain UTC midnight", () => {
    expect(storeTodayStartIso("UTC", NOW)).toBe("2026-07-02T00:00:00.000Z");
  });
});

/** Minimal chainable PostgREST stub returning canned rows per table. */
function sbStub(rows: {
  guardrail_config?: { timezone: string } | null;
  storefront_event: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  order_line: Array<Record<string, unknown>>;
}): SupabaseClient {
  const table = (name: string) => {
    const result =
      name === "guardrail_config"
        ? { data: rows.guardrail_config ?? null, error: null }
        : { data: (rows as Record<string, unknown[]>)[name] ?? [], error: null };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      in: () => chain,
      maybeSingle: async () => result,
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return chain;
  };
  return { from: table } as unknown as SupabaseClient;
}

const SESS = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  is_returning: false,
  type,
  country: "US",
  created_at: "2026-07-02T19:00:00Z",
  ...extra,
});

describe("buildLiveSnapshot", () => {
  it("counts distinct sessions, not events, everywhere", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("s1", "page_view"),
        SESS("s1", "page_view"),
        SESS("s1", "cart_add"),
        SESS("s1", "cart_add"),
        SESS("s2", "page_view", { is_returning: true, country: "DE" }),
      ],
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.sessions_today).toBe(2);
    expect(snap.funnel).toEqual({ cart_sessions: 1, checkout_sessions: 0, purchased_sessions: 0 });
    expect(snap.new_vs_returning).toEqual({ new: 1, returning: 1 });
    expect(snap.by_location).toEqual([
      { country: "US", sessions: 1 },
      { country: "DE", sessions: 1 },
    ]);
  });

  it("visitors_now = distinct sessions with an event in the last 5 minutes", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("old", "page_view", { created_at: "2026-07-02T10:00:00Z" }),
        SESS("fresh", "page_view", { created_at: "2026-07-02T19:58:00Z" }),
        SESS("fresh", "cart_add", { created_at: "2026-07-02T19:59:00Z" }),
      ],
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.visitors_now).toBe(1);
  });

  it("money + top products come from paid orders and their lines", async () => {
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: [
        SESS("s1", "checkout_start"),
        SESS("s1", "checkout_complete"),
      ],
      orders: [
        { id: "o1", total_cents: 5000, currency: "usd", created_at: "2026-07-02T18:00:00Z" },
        { id: "o2", total_cents: 2500, currency: "usd", created_at: "2026-07-02T19:00:00Z" },
      ],
      order_line: [
        { order_id: "o1", variant_id: "v1", quantity: 2, unit_price_cents: 2000, title_snapshot: "Mug" },
        { order_id: "o2", variant_id: "v2", quantity: 1, unit_price_cents: 2500, title_snapshot: "Cap" },
      ],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.total_sales_today_cents).toBe(7500);
    expect(snap.orders_today).toBe(2);
    expect(snap.currency).toBe("usd");
    expect(snap.funnel.checkout_sessions).toBe(1);
    expect(snap.funnel.purchased_sessions).toBe(1);
    expect(snap.top_products).toEqual([
      { product_id: "v1", title: "Mug", sales_cents: 4000, units: 2 },
      { product_id: "v2", title: "Cap", sales_cents: 2500, units: 1 },
    ]);
  });

  it("folds locations beyond the top 8 into Other and nulls into Unknown", async () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      SESS(`s${i}`, "page_view", { country: `C${i}` }),
    );
    events.push(SESS("s10", "page_view", { country: null }));
    const sb = sbStub({
      guardrail_config: { timezone: "UTC" },
      storefront_event: events,
      orders: [],
      order_line: [],
    });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.by_location).toHaveLength(9); // top 8 + Other
    expect(snap.by_location[8].country).toBe("Other");
    expect(snap.by_location.reduce((n, l) => n + l.sessions, 0)).toBe(11);
    expect(
      snap.by_location.some((l) => l.country === "Unknown") ||
        snap.by_location[8].sessions >= 1,
    ).toBe(true);
  });

  it("all-zero snapshot is valid (cold start)", async () => {
    const sb = sbStub({ guardrail_config: null, storefront_event: [], orders: [], order_line: [] });
    const snap = await buildLiveSnapshot(sb, "shop-1", NOW);
    expect(snap.visitors_now).toBe(0);
    expect(snap.total_sales_today_cents).toBe(0);
    expect(snap.top_products).toEqual([]);
    expect(typeof snap.generated_at).toBe("string");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/live-analytics.test.ts`
Expected: FAIL — cannot resolve `../live-analytics.server`

- [ ] **Step 3: Implement**

```ts
// app/lib/dashboard/live-analytics.server.ts
// Snapshot assembly for the Analytics Live subtab (spec
// 2026-07-02-analytics-live-view-design.md). Plain PostgREST reads + JS
// aggregation, matching calderyn.server.ts convention. All counts are
// DISTINCT sessions, never raw events. "Today" = the store's local midnight
// (guardrail_config.timezone), deviating deliberately from the UTC-day budget
// convention — a live merchant-facing "today" must reset at the store's
// midnight. Same accepted DST rounding as business-hours.ts.
// ponytail: no rollup tables; revisit past ~100k events/day per shop.
import type { SupabaseClient } from "@supabase/supabase-js";
import { tzOffsetHours } from "./business-hours";

export interface LiveAnalyticsSnapshot {
  generated_at: string;
  visitors_now: number;
  sessions_today: number;
  total_sales_today_cents: number;
  currency: string;
  orders_today: number;
  funnel: { cart_sessions: number; checkout_sessions: number; purchased_sessions: number };
  by_location: Array<{ country: string; sessions: number }>;
  new_vs_returning: { new: number; returning: number };
  top_products: Array<{ product_id: string; title: string; sales_cents: number; units: number }>;
}

const VISITORS_NOW_WINDOW_MS = 5 * 60_000;
const TOP_LOCATIONS = 8;
const TOP_PRODUCTS = 5;
const DEFAULT_TZ = "America/New_York"; // matches rowToGuardrails default

/** UTC instant of the most recent store-local midnight (offset sampled at `now`). */
export function storeTodayStartIso(tz: string, now = new Date()): string {
  const offsetMs = tzOffsetHours(tz, now) * 3_600_000;
  const local = new Date(now.getTime() + offsetMs);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(localMidnight - offsetMs).toISOString();
}

type EventRow = {
  session_id: string;
  is_returning: boolean;
  type: string;
  country: string | null;
  created_at: string;
};
type OrderRow = { id: string; total_cents: number; currency: string; created_at: string };
type LineRow = {
  order_id: string;
  variant_id: string;
  quantity: number;
  unit_price_cents: number;
  title_snapshot: string;
};

export async function buildLiveSnapshot(
  sb: SupabaseClient,
  shopId: string,
  now = new Date(),
): Promise<LiveAnalyticsSnapshot> {
  const tzRes = await sb
    .from("guardrail_config")
    .select("timezone")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (tzRes.error) throw tzRes.error;
  const tz = String((tzRes.data as { timezone?: string } | null)?.timezone ?? DEFAULT_TZ);
  const todayStart = storeTodayStartIso(tz, now);
  const nowWindowStart = new Date(now.getTime() - VISITORS_NOW_WINDOW_MS).toISOString();

  const [eventsRes, ordersRes] = await Promise.all([
    sb
      .from("storefront_event")
      .select("session_id, is_returning, type, country, created_at")
      .eq("shop_id", shopId)
      .gte("created_at", todayStart),
    sb
      .from("orders")
      .select("id, total_cents, currency, created_at")
      .eq("shop_id", shopId)
      .eq("financial_status", "paid")
      .gte("created_at", todayStart),
  ]);
  if (eventsRes.error) throw eventsRes.error;
  if (ordersRes.error) throw ordersRes.error;
  const events = (eventsRes.data ?? []) as EventRow[];
  const orders = (ordersRes.data ?? []) as OrderRow[];

  let lines: LineRow[] = [];
  if (orders.length > 0) {
    const linesRes = await sb
      .from("order_line")
      .select("order_id, variant_id, quantity, unit_price_cents, title_snapshot")
      .eq("shop_id", shopId)
      .in("order_id", orders.map((o) => String(o.id)));
    if (linesRes.error) throw linesRes.error;
    lines = (linesRes.data ?? []) as LineRow[];
  }

  // --- distinct-session aggregation ---
  const sessions = new Set<string>();
  const now5m = new Set<string>();
  const byType: Record<string, Set<string>> = {
    cart_add: new Set(),
    checkout_start: new Set(),
    checkout_complete: new Set(),
  };
  const returningBySession = new Map<string, boolean>();
  const byCountry = new Map<string, Set<string>>();
  for (const e of events) {
    const sid = String(e.session_id);
    sessions.add(sid);
    if (e.created_at >= nowWindowStart) now5m.add(sid);
    byType[e.type]?.add(sid);
    // The flag is frozen at session start, so first-seen wins is safe.
    if (!returningBySession.has(sid)) returningBySession.set(sid, Boolean(e.is_returning));
    const country = e.country ?? "Unknown";
    (byCountry.get(country) ?? byCountry.set(country, new Set()).get(country)!).add(sid);
  }

  const locations = [...byCountry.entries()]
    .map(([country, set]) => ({ country, sessions: set.size }))
    .sort((a, b) => b.sessions - a.sessions);
  const topLocations = locations.slice(0, TOP_LOCATIONS);
  const rest = locations.slice(TOP_LOCATIONS).reduce((n, l) => n + l.sessions, 0);
  if (rest > 0) topLocations.push({ country: "Other", sessions: rest });

  let returning = 0;
  for (const r of returningBySession.values()) if (r) returning += 1;

  const byVariant = new Map<string, { title: string; sales_cents: number; units: number }>();
  for (const l of lines) {
    const acc =
      byVariant.get(l.variant_id) ??
      byVariant.set(l.variant_id, { title: l.title_snapshot, sales_cents: 0, units: 0 }).get(l.variant_id)!;
    acc.sales_cents += Number(l.unit_price_cents) * Number(l.quantity);
    acc.units += Number(l.quantity);
  }
  const topProducts = [...byVariant.entries()]
    .map(([product_id, v]) => ({ product_id, ...v }))
    .sort((a, b) => b.sales_cents - a.sales_cents)
    .slice(0, TOP_PRODUCTS);

  return {
    generated_at: now.toISOString(),
    visitors_now: now5m.size,
    sessions_today: sessions.size,
    // ponytail: orders.created_at, not a paid-at timestamp (none exists) — an
    // order created before midnight but paid after lands on yesterday.
    total_sales_today_cents: orders.reduce((n, o) => n + Number(o.total_cents), 0),
    currency: orders[0]?.currency ?? "usd",
    orders_today: orders.length,
    funnel: {
      cart_sessions: byType.cart_add.size,
      checkout_sessions: byType.checkout_start.size,
      purchased_sessions: byType.checkout_complete.size,
    },
    by_location: topLocations,
    new_vs_returning: { new: returningBySession.size - returning, returning },
    top_products: topProducts,
  };
}
```

NOTE: the stub's `then:` trick makes the awaited chain resolve; if vitest complains about thenable recursion, replace `then` with making `gte`/`in` async-terminal instead — match how `api-write-routes.test.ts` builds its chainable stub.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/live-analytics.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/live-analytics.server.ts app/lib/dashboard/__tests__/live-analytics.test.ts
git commit -m "lib/dashboard: live-analytics snapshot builder (distinct-session aggregates)"
```

---

### Task 6: Resource route `dashboard.api.analytics-live`

**Files:**
- Create: `app/routes/dashboard.api.analytics-live.tsx`
- Test: `app/lib/dashboard/__tests__/api-analytics-live-route.test.ts`

- [ ] **Step 1: Write the failing test** (copy of the `api-analytics-route.test.ts` pattern)

```ts
// app/lib/dashboard/__tests__/api-analytics-live-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

import { loader as liveLoader } from "../../../routes/dashboard.api.analytics-live";

const requireDashboardSession = vi.fn();
const buildLiveSnapshot = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("../live-analytics.server", () => ({
  buildLiveSnapshot: (...a: unknown[]) => buildLiveSnapshot(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/analytics-live", () => {
  it("propagates the 401 thrown by the session guard", async () => {
    requireDashboardSession.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(
      liveLoader({
        request: new Request("https://calderyncompany.com/dashboard/api/analytics-live"),
        params: {},
        context: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns the snapshot DTO scoped to the shop", async () => {
    buildLiveSnapshot.mockResolvedValueOnce({ visitors_now: 3, sessions_today: 9 });
    const res = (await liveLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/analytics-live"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ visitors_now: 3, sessions_today: 9 });
    expect(buildLiveSnapshot).toHaveBeenCalledWith({}, "shop-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/api-analytics-live-route.test.ts`
Expected: FAIL — cannot resolve the route module

- [ ] **Step 3: Implement the route**

```tsx
// app/routes/dashboard.api.analytics-live.tsx
// Live View snapshot for the dashboard Analytics screen. GET-only resource
// route; named analytics-live (not analytics.live) so it stays a sibling of
// the existing analytics resource route instead of nesting under it.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { buildLiveSnapshot } from "~/lib/dashboard/live-analytics.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => buildLiveSnapshot(getSupabase(), session.shopId));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/api-analytics-live-route.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.analytics-live.tsx app/lib/dashboard/__tests__/api-analytics-live-route.test.ts
git commit -m "routes/dashboard.api.analytics-live: live snapshot endpoint"
```

---

### Task 7: Realtime token returns the Supabase URL

**Files:**
- Modify: `app/routes/dashboard.api.realtime-token.tsx`
- Modify: `app/lib/dashboard/client.ts` (`getRealtimeToken`)
- Test: find the existing realtime-token test with `grep -rl "realtime-token" app/lib/dashboard/__tests__/ app/routes/__tests__/` and extend it; if none exists, add assertions to the Task 8 hook test instead.

- [ ] **Step 1: Modify the route** — the browser needs the project URL to open the socket; it is public info (ships in every supabase-js app):

In `app/routes/dashboard.api.realtime-token.tsx`, replace:

```ts
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return jsonError(503, "realtime_not_configured");
```

with:

```ts
  const secret = process.env.SUPABASE_JWT_SECRET;
  const url = process.env.SUPABASE_URL;
  if (!secret || !url) return jsonError(503, "realtime_not_configured");
```

and replace the final return with:

```ts
  return jsonOk({ token, url, expires_at: new Date(exp * 1000).toISOString() });
```

- [ ] **Step 2: Extend `getRealtimeToken` in `app/lib/dashboard/client.ts`** — replace the existing function body:

```ts
export async function getRealtimeToken(): Promise<{
  token: string;
  url: string;
  expiresAt: string;
} | null> {
  try {
    const data = await apiGet<{ token: string; url: string; expires_at: string }>(
      "/dashboard/api/realtime-token",
    );
    return { token: data.token, url: data.url, expiresAt: data.expires_at };
  } catch (err) {
    if (err instanceof DashboardApiError && err.status === 503) return null;
    throw err;
  }
}
```

- [ ] **Step 3: Verify**

Run: `grep -rln "getRealtimeToken" app/ | grep -v client.ts` — update any existing test asserting the old shape.
Run: `npx vitest run` → PASS; `npm run typecheck` → exit 0

- [ ] **Step 4: Commit**

```bash
git add app/routes/dashboard.api.realtime-token.tsx app/lib/dashboard/client.ts
git commit -m "dashboard.api.realtime-token: include supabase url for browser realtime"
```

---

### Task 8: Client fetcher + `useLiveAnalytics` hook

**Files:**
- Modify: `app/lib/dashboard/client.ts` (add `LiveAnalyticsSnapshot` + `fetchLiveAnalytics`)
- Create: `app/components/dashboard/use-live-analytics.ts`
- Test: `app/components/dashboard/__tests__/use-live-analytics.test.ts` (pure parts only — the poll gate; hooks themselves follow the repo's no-jsdom convention, so DOM wiring is smoke-verified)

- [ ] **Step 1: Add to `app/lib/dashboard/client.ts`** (near `fetchAnalytics`) — the browser-side DTO type mirrors the server exactly (this is the design handoff contract):

```ts
export interface LiveAnalyticsSnapshot {
  generated_at: string;
  visitors_now: number;
  sessions_today: number;
  total_sales_today_cents: number;
  currency: string;
  orders_today: number;
  funnel: { cart_sessions: number; checkout_sessions: number; purchased_sessions: number };
  by_location: Array<{ country: string; sessions: number }>;
  new_vs_returning: { new: number; returning: number };
  top_products: Array<{ product_id: string; title: string; sales_cents: number; units: number }>;
}

export async function fetchLiveAnalytics(): Promise<LiveAnalyticsSnapshot> {
  return apiGet<LiveAnalyticsSnapshot>("/dashboard/api/analytics-live");
}
```

- [ ] **Step 2: Write the failing test for the poll gate**

```ts
// app/components/dashboard/__tests__/use-live-analytics.test.ts
import { describe, it, expect } from "vitest";
import { shouldPollNow } from "../use-live-analytics";

describe("shouldPollNow", () => {
  it("polls only when the subtab is active and the document is visible", () => {
    expect(shouldPollNow(true, "visible")).toBe(true);
    expect(shouldPollNow(true, "hidden")).toBe(false);
    expect(shouldPollNow(false, "visible")).toBe(false);
    expect(shouldPollNow(false, "hidden")).toBe(false);
  });
});
```

Run: `npx vitest run app/components/dashboard/__tests__/use-live-analytics.test.ts` → FAIL (module missing)

- [ ] **Step 3: Implement the hook**

```ts
// app/components/dashboard/use-live-analytics.ts
// Refresh model for the Analytics Live subtab (approach C from the spec):
// 60s poll gated on subtab + document visibility, plus a Supabase Realtime
// "order ping" (INSERT at checkout creation, UPDATE on the paid flip) that
// triggers an immediate refetch. The ping carries no data — aggregation only
// ever lives server-side. Realtime failing/unconfigured (503) degrades
// silently to the poll. First real consumer of getRealtimeToken().
import { useEffect, useState } from "react";
import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import {
  fetchLiveAnalytics,
  getRealtimeToken,
  DashboardApiError,
  type LiveAnalyticsSnapshot,
} from "~/lib/dashboard/client";

export const LIVE_POLL_MS = 60_000;

/** Pure gate: poll only when the Live subtab is active and the tab is visible. */
export function shouldPollNow(active: boolean, visibility: DocumentVisibilityState): boolean {
  return active && visibility === "visible";
}

export function useLiveAnalytics(active: boolean): {
  snapshot: LiveAnalyticsSnapshot | null;
  error: string | null;
} {
  const [snapshot, setSnapshot] = useState<LiveAnalyticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const load = () => {
      if (!shouldPollNow(active, document.visibilityState)) return;
      fetchLiveAnalytics()
        .then((s) => {
          if (!alive) return;
          setSnapshot(s);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setError(err instanceof DashboardApiError ? err.message : "Couldn't load live view.");
        });
    };

    load();
    const id = setInterval(load, LIVE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    let sb: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    getRealtimeToken()
      .then((tok) => {
        if (!alive || !tok) return; // 503 → poll-only fallback, silently
        sb = createClient(tok.url, tok.token, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        sb.realtime.setAuth(tok.token);
        channel = sb
          .channel("live-orders")
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "orders" }, // RLS scopes delivery to this shop
            () => load(),
          )
          .subscribe();
      })
      .catch(() => {
        // realtime is an enhancement; the poll is the contract
      });

    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      if (sb && channel) void sb.removeChannel(channel);
    };
  }, [active]);

  return { snapshot, error };
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run app/components/dashboard/__tests__/use-live-analytics.test.ts` → PASS
Run: `npm run typecheck` → exit 0

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/client.ts app/components/dashboard/use-live-analytics.ts \
  app/components/dashboard/__tests__/use-live-analytics.test.ts
git commit -m "components/dashboard: useLiveAnalytics hook (60s poll + order ping)"
```

---

### Task 9: `AnalyticsLive` component + subtab wiring

**Files:**
- Create: `app/components/dashboard/screens/AnalyticsLive.tsx`
- Modify: `app/components/dashboard/screens/Analytics.tsx`
- Test: `app/components/dashboard/screens/__tests__/analytics-live.test.ts`

- [ ] **Step 1: Write the failing component test** (renderToString convention from `dashboard-stat-row.test.ts`)

```ts
// app/components/dashboard/screens/__tests__/analytics-live.test.ts
import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { LiveSnapshotView } from "../AnalyticsLive";
import type { LiveAnalyticsSnapshot } from "~/lib/dashboard/client";

const SNAP: LiveAnalyticsSnapshot = {
  generated_at: "2026-07-02T20:00:00.000Z",
  visitors_now: 7,
  sessions_today: 128,
  total_sales_today_cents: 123400,
  currency: "usd",
  orders_today: 12,
  funnel: { cart_sessions: 30, checkout_sessions: 14, purchased_sessions: 11 },
  by_location: [
    { country: "US", sessions: 90 },
    { country: "DE", sessions: 20 },
    { country: "Other", sessions: 18 },
  ],
  new_vs_returning: { new: 100, returning: 28 },
  top_products: [{ product_id: "v1", title: "Mug", sales_cents: 80000, units: 40 }],
};

function render(snapshot: LiveAnalyticsSnapshot | null, error: string | null = null): string {
  return renderToString(h(LiveSnapshotView, { snapshot, error })).replace(/<!-- -->/g, "");
}

describe("LiveSnapshotView", () => {
  it("renders every tile from the snapshot DTO", () => {
    const html = render(SNAP);
    expect(html).toContain("Visitors right now");
    expect(html).toContain("Sales today");
    expect(html).toContain("Sessions");
    expect(html).toContain("Orders");
    expect(html).toContain("Behavior");
    expect(html).toContain("Locations");
    expect(html).toContain("New vs returning");
    expect(html).toContain("Top products");
    expect(html).toContain("Mug");
    expect(html).toContain("US");
  });

  it("zero snapshot renders (cold start is a valid state, not an error)", () => {
    const html = render({
      ...SNAP,
      visitors_now: 0,
      sessions_today: 0,
      total_sales_today_cents: 0,
      orders_today: 0,
      funnel: { cart_sessions: 0, checkout_sessions: 0, purchased_sessions: 0 },
      by_location: [],
      new_vs_returning: { new: 0, returning: 0 },
      top_products: [],
    });
    expect(html).toContain("Visitors right now");
    expect(html).not.toContain("Couldn't load");
  });

  it("error state renders the placeholder", () => {
    const html = render(null, "boom");
    expect(html).toContain("Couldn&#x27;t load live view");
  });

  it("loading state renders the placeholder", () => {
    const html = render(null, null);
    expect(html).toContain("Loading live view");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/components/dashboard/screens/__tests__/analytics-live.test.ts`
Expected: FAIL — cannot resolve `../AnalyticsLive`

- [ ] **Step 3: Implement the component** — functionally complete, visually plain (Claude Design restyles against the same DTO):

```tsx
// app/components/dashboard/screens/AnalyticsLive.tsx
// Live subtab of the Analytics screen (spec
// 2026-07-02-analytics-live-view-design.md). Data plumbing + plain cd-*
// rendering only — final visual design is owned by the design pass; the
// LiveAnalyticsSnapshot DTO is the handoff contract. Split into a pure view
// (LiveSnapshotView, SSR-testable) and a thin fetching wrapper.
import { Card, CountMoney, CountNum, Meter, Placeholder } from "../ui";
import { useLiveAnalytics } from "../use-live-analytics";
import type { LiveAnalyticsSnapshot } from "~/lib/dashboard/client";

export function LiveSnapshotView({
  snapshot,
  error,
}: {
  snapshot: LiveAnalyticsSnapshot | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Card pad={false}>
        <Placeholder icon="warn" title="Couldn't load live view" sub={error} />
      </Card>
    );
  }
  if (!snapshot) {
    return (
      <Card pad={false}>
        <Placeholder icon="chart" title="Loading live view" sub="Reading current storefront activity." />
      </Card>
    );
  }

  const funnelMax = Math.max(snapshot.funnel.cart_sessions, 1);
  const locMax = Math.max(...snapshot.by_location.map((l) => l.sessions), 1);
  const prodMax = Math.max(...snapshot.top_products.map((p) => p.sales_cents), 1);
  const nvr = snapshot.new_vs_returning;
  const nvrTotal = Math.max(nvr.new + nvr.returning, 1);

  return (
    <>
      <div className="cd-stat-grid">
        <Card className="cd-stat">
          <span className="cd-stat-label">
            <span className="cd-dot" /> Visitors right now
          </span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.visitors_now} />
          </span>
          <span className="cd-caption">active in the last 5 minutes</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Sales today</span>
          <span className="cd-stat-value">
            <CountMoney cents={snapshot.total_sales_today_cents} />
          </span>
          <span className="cd-caption">{snapshot.orders_today} paid orders</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Sessions</span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.sessions_today} />
          </span>
          <span className="cd-caption">since store midnight</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Orders</span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.orders_today} />
          </span>
          <span className="cd-caption">paid today</span>
        </Card>
      </div>

      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2">Behavior</h2>
            <div className="cd-rows">
              {(
                [
                  ["Carts", snapshot.funnel.cart_sessions],
                  ["Checkouts", snapshot.funnel.checkout_sessions],
                  ["Purchased", snapshot.funnel.purchased_sessions],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="cd-row">
                  <span className="cd-row-title">{label}</span>
                  <Meter pct={(n / funnelMax) * 100} />
                  <span className="cd-row-num tabular-nums">{n}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <h2 className="cd-h2">New vs returning</h2>
            <div className="cd-rows">
              <div className="cd-row">
                <span className="cd-row-title">New</span>
                <Meter pct={(nvr.new / nvrTotal) * 100} />
                <span className="cd-row-num tabular-nums">{nvr.new}</span>
              </div>
              <div className="cd-row">
                <span className="cd-row-title">Returning</span>
                <Meter pct={(nvr.returning / nvrTotal) * 100} />
                <span className="cd-row-num tabular-nums">{nvr.returning}</span>
              </div>
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2">Locations</h2>
            {snapshot.by_location.length === 0 ? (
              <Placeholder icon="scan" title="No sessions yet" sub="Sessions by country will list here." />
            ) : (
              <div className="cd-rows">
                {snapshot.by_location.map((l) => (
                  <div key={l.country} className="cd-row">
                    <span className="cd-row-title">{l.country}</span>
                    <Meter pct={(l.sessions / locMax) * 100} />
                    <span className="cd-row-num tabular-nums">{l.sessions}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <h2 className="cd-h2">Top products</h2>
            {snapshot.top_products.length === 0 ? (
              <Placeholder icon="sparkle" title="No sales yet" sub="Today's sales by product will list here." />
            ) : (
              <div className="cd-rows">
                {snapshot.top_products.map((p) => (
                  <div key={p.product_id} className="cd-row">
                    <span className="cd-row-title">{p.title}</span>
                    <Meter pct={(p.sales_cents / prodMax) * 100} />
                    <span className="cd-row-num tabular-nums">
                      <CountMoney cents={p.sales_cents} /> · {p.units}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default function AnalyticsLive() {
  const { snapshot, error } = useLiveAnalytics(true);
  return <LiveSnapshotView snapshot={snapshot} error={error} />;
}
```

NOTE: verify the exact props of `Meter` (`{ pct, tone?, height? }`) and `CountNum` against `app/components/dashboard/ui.tsx` before finalizing; adjust if signatures differ.

- [ ] **Step 4: Wire the subtab into `Analytics.tsx`**

In `app/components/dashboard/screens/Analytics.tsx`:

1. Add imports:

```tsx
import AnalyticsLive from "./AnalyticsLive";
```

2. Inside the component, next to the existing `range` state:

```tsx
const [view, setView] = useState<"performance" | "live">("performance");
```

3. The loading/error early returns only apply to the performance view. Change both early-return conditions from `if (loading)` / `if (error)` to `if (view === "performance" && loading)` / `if (view === "performance" && error)` — and add the view Segmented to those early-return headers too so the user can switch to Live while Performance loads/errors:

```tsx
<ScreenHeader title="Analytics" sub="...unchanged...">
  <Segmented
    small
    value={view}
    onChange={(v) => setView(v as "performance" | "live")}
    options={[
      { value: "performance", label: "Performance" },
      { value: "live", label: "Live" },
    ]}
  />
</ScreenHeader>
```

4. In the main return's header, render BOTH segmented controls, hiding the range control on the Live view:

```tsx
<ScreenHeader title="Analytics" sub={view === "live" ? "Your storefront right now." : "Blended performance across Meta, Google and TikTok — margin-aware."}>
  <Segmented
    small
    value={view}
    onChange={(v) => setView(v as "performance" | "live")}
    options={[
      { value: "performance", label: "Performance" },
      { value: "live", label: "Live" },
    ]}
  />
  {view === "performance" && (
    <Segmented small value={range} onChange={(v) => setRange(v as Range)} options={["7d", "14d", "30d"]} />
  )}
</ScreenHeader>
```

5. Wrap the entire existing performance body (everything below the header inside `cd-screen`) in `{view === "performance" ? (<>...existing body...</>) : (<AnalyticsLive />)}`.

Guard against `data` being `null` on the live view — the early returns no longer guarantee it; the performance branch must keep its own `data &&` guards or bail with the existing loading placeholder when `view === "performance"`.

- [ ] **Step 5: Verify**

Run: `npx vitest run app/components/dashboard/screens/__tests__/analytics-live.test.ts` → PASS
Run: `npx vitest run` → PASS (full suite)
Run: `npm run typecheck` → exit 0

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/screens/AnalyticsLive.tsx \
  app/components/dashboard/screens/Analytics.tsx \
  app/components/dashboard/screens/__tests__/analytics-live.test.ts
git commit -m "components/dashboard/screens: Live subtab in Analytics"
```

---

### Task 10: Retention — trim `storefront_event` in the GDPR sweep

**Files:**
- Modify: `app/lib/gdpr/sweep.server.ts`
- Modify: its existing test (find with `ls app/lib/gdpr/__tests__/`)

- [ ] **Step 1: Extend the failing test** — in the existing sweep test, add a case asserting a `storefront_event` delete with a 30-day cutoff and a `storefrontEventRowsDeleted` count in the result (mirror however the existing test asserts `rawWebhookRowsDeleted`).

- [ ] **Step 2: Implement** — in `app/lib/gdpr/sweep.server.ts`:

```ts
export const RETENTION_STOREFRONT_EVENT_DAYS = 30;
```

Extend `SweepResult`:

```ts
  storefrontEventRowsDeleted: number;
```

After the raw-webhook trim block, add (same shape as the existing trim):

```ts
  // 3. Live-view event retention. storefront_event feeds the live view, not
  //    the warehouse — rows older than 30 days are dead weight (spec
  //    2026-07-02-analytics-live-view-design.md).
  const eventCutoff = new Date(
    Date.now() - RETENTION_STOREFRONT_EVENT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error: evErr, count: evCount } = await sb
    .from("storefront_event")
    .delete({ count: "exact" })
    .lt("created_at", eventCutoff);
  if (evErr) {
    throw new Error(`gdpr sweep: storefront_event trim failed: ${evErr.message}`);
  }
```

and include `storefrontEventRowsDeleted: evCount ?? 0` in the returned result. Match the exact error-handling style of the raw-webhook block when you open the file (if it records rather than throws, do the same — rule 11).

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run app/lib/gdpr/` → PASS

```bash
git add app/lib/gdpr/sweep.server.ts app/lib/gdpr/__tests__/
git commit -m "lib/gdpr: 30-day retention trim for storefront_event"
```

---

### Task 11: Apply migration + full-suite gate + smoke every touched route

**Files:** none created — verification only.

- [ ] **Step 1: Full local gate**

Run in the worktree, in order; all must be green:

```bash
npm run typecheck        # exit 0
npm run lint             # exit 0, no new warnings
npx vitest run           # all pass
npm run build            # Remix+Vite build + verify-client-bundle green
```

The client-bundle verifier matters here: the new hook/component ship to the browser — no provenance strings, no sourcemaps.

- [ ] **Step 2: Apply the migration to the Supabase project**

Use the supabase MCP `apply_migration` with the contents of `20260702160000_storefront_event.sql` (additive: new table + grant/policy/publication on orders; no destructive statements). Verify with `list_tables` that `storefront_event` exists and RLS is enabled. **Call this out explicitly in the final report — it changes the production database.**

- [ ] **Step 3: Smoke the storefront routes** (dev server so `?shop=` tenant override works)

```bash
cd /Users/ericchen/Developer/calderyn-analytics-live-view
set -a; [ -f .env ] && source .env; source .env.local; set +a
npx remix vite:dev --port 4321
```

With chrome-devtools MCP against `http://localhost:4321`, using a real shop slug (find one: `select org_slug, shop_domain from shops limit 5` via supabase MCP `execute_sql`):
1. `GET /storefront?shop=<slug>` → 200, response sets `cd_vid` + `cd_sid` cookies (check via list_network_requests).
2. `GET /storefront/products/<handle>?shop=<slug>` → 200.
3. Add to cart (submit the PDP form) → 302 to `/storefront/cart`, page renders.
4. `GET /storefront/cart?shop=<slug>` → 200.
5. `GET /storefront/checkout?shop=<slug>` → 200 (or 302 to cart when empty — both are correct behavior; exercise with a non-empty cart).
6. Verify rows landed: supabase `execute_sql`: `select type, path, country, is_returning from storefront_event where shop_id = '<uuid>' order by created_at desc limit 10;` → expect the page_view/cart_add/checkout_start rows, one session_id shared across them, no PII columns.

- [ ] **Step 4: Smoke the dashboard side**

1. `GET /dashboard/api/analytics-live` unauthenticated → 401 `{"error":"unauthenticated"}` (correct guard behavior).
2. Sign in at `/dashboard/signin` (use the dev/test dashboard account; if none exists, create a session row directly via the established dev path — check `scripts/reset-test-store.sh` — or verify the endpoint by temporarily calling `buildLiveSnapshot` through a one-off script with the service client and the smoke shop's UUID, asserting the DTO shape matches the browser contract).
3. Authenticated `GET /dashboard/api/analytics-live` → 200 DTO with the smoke traffic reflected (visitors_now ≥ 1, sessions_today ≥ 1, funnel.cart_sessions ≥ 1).
4. Open the dashboard → Analytics → Live subtab: tiles render the same numbers; no console errors (chrome-devtools `list_console_messages`).
5. Order ping: `update orders set financial_status = financial_status where shop_id='<uuid>' and id='<any>'` via execute_sql while the Live tab is open → observe an immediate refetch (network request to analytics-live within ~2s). If no orders row exists for the smoke shop, verify instead that the realtime channel subscribes cleanly (no error in console) and the 60s poll fires.

- [ ] **Step 5: Record evidence**

Save the smoke evidence (screenshots + the SQL row output + network traces) into the PR description draft. Every touched route must appear in the checklist with its observed status.

---

### Task 12: Pre-commit gate + PR

- [ ] **Step 1: `/code-review`** on the working tree — resolve every blocker; downgrade nits explicitly.
- [ ] **Step 2: Patch sanity** — `git diff main --stat` and `git diff --check`; no stray console.log (the emitter's `console.error` is deliberate rule-12 logging), no `.only`, no provenance strings.
- [ ] **Step 3: Re-run the eval pipeline** (typecheck, lint, build) — paste results.
- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/analytics-live-view
gh pr create --title "Analytics Live View: real-time owned-storefront subtab" --body "<summary + smoke evidence + migration callout>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

PR body must include: spec + plan links, the six grounded deviations, the smoke-evidence checklist per route, the production-migration callout, the dashboard-parity exemption note, and the platform-pivot progress footer (per CLAUDE.md).
