# Sign-in Shopify OAuth + Data Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class "Continue with Shopify" on `/login` that lands merchants on the data-port screen, dashboard-styled `/dashboard/login`, customer import into the buyer PII store, and a security sweep.

**Architecture:** Reuse everything: the existing dashboard OAuth round-trip (`/dashboard/login` → `/dashboard/auth/callback`), the `AuthShell`/`cd-auth-*` design system, the `import_run` state machine, and the buyer identity helpers (`upsertGuestBuyer`/`addBuyerAddress`/`recordConsent`). New code is one ingest generator (`fetchCustomers`), one import stage (`customers.server.ts`), and steering/UI edits.

**Tech Stack:** Remix (Vite), vitest 4, Supabase (service-role client), Shopify Admin GraphQL.

**Spec:** `docs/superpowers/specs/2026-07-03-signin-shopify-port-design.md`

**Prerequisites (verify before Task 1):**
- PR #277 is merged to `main` (its `login.tsx` / `dashboard.login.tsx` / `cookies.server.ts` shapes are assumed everywhere below).
- Work in an isolated worktree: `git worktree add ../calderyn-signin-shopify-port -b feat/signin-shopify-port` from updated `main` (superpowers:using-git-worktrees). First commit = the spec + this plan (`docs/superpowers/{specs,plans}/2026-07-03-signin-shopify-port*.md`).
- All paths below are relative to that worktree. Run tests with `npx vitest run <file>`.

---

### Task 1: Auth error copy for the Shopify OAuth states

**Files:**
- Modify: `app/lib/auth/messages.ts` (add 3 codes to `AUTH_ERROR_MESSAGES`)

The codes are consumed/asserted by Task 2's page tests — no dedicated test file for a string map.

- [ ] **Step 1: Add the codes**

In `AUTH_ERROR_MESSAGES`, after the `send_failed` entry, add:

```ts
  oauth_failed: "Shopify sign-in didn't complete. Try again.",
  app_not_installed:
    "This store isn't connected to Calderyn yet. Install the Calderyn app from your Shopify admin first — that's what links your store and lets us bring your data over.",
  invalid_shop: "Enter your store's .myshopify.com domain, like example.myshopify.com.",
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/auth/messages.ts
git commit -m "lib/auth/messages: copy for shopify oauth error states"
```

---

### Task 2: `/dashboard/login` becomes a dashboard-styled React page

**Files:**
- Rewrite: `app/routes/dashboard.login.tsx` (kill `loginInfoPage`/`loginFormPage` HTML strings)
- Modify: `app/routes/__tests__/dashboard-login-returnto.test.ts` (form assertions move to loader-data + component render)
- Test: `app/routes/__tests__/dashboard-login-page.test.tsx` (new — component render)

Behavior contract (unchanged): rate-limit → 429 JSON; `?shop=` invalid → 422 JSON; `?shop=` valid → 302 to authorize with `nonce:shop[:enc(returnTo)]` state cookie; no `?shop=` → store-domain form (hint pre-fills, never auto-redirects); `?error=` → error state. New: the two rendered states use `AuthShell`; `?error=` codes flow to `AuthError`.

- [ ] **Step 1: Update the existing return_to tests for the new contract**

In `dashboard-login-returnto.test.ts`, the two 302/state-cookie tests are unchanged. Replace the two form-rendering tests (`renders a shop-entry form…`, `renders the form WITHOUT…`) with loader-data assertions:

```ts
  it("returns form data (not a dead end) when there is no shop and no cookie", async () => {
    const r = (await loader(
      req(
        "https://app.calderyncompany.com/dashboard/login?return_to=%2Fdashboard%2Fconnect%3Ft%3Dabc",
      ) as never,
    )) as { mode: string; returnTo: string | null; hintShop: string | null };
    expect(r.mode).toBe("form");
    // The connector destination survives into the form so it resumes after login.
    expect(r.returnTo).toBe("/dashboard/connect?t=abc");
  });

  it("omits return_to from the form data when none is given", async () => {
    const r = (await loader(
      req("https://app.calderyncompany.com/dashboard/login") as never,
    )) as { mode: string; returnTo: string | null };
    expect(r.mode).toBe("form");
    expect(r.returnTo).toBeNull();
  });
```

- [ ] **Step 2: Write the new component test**

`app/routes/__tests__/dashboard-login-page.test.tsx` (model: `dashboard.builder.preview.test.ts` — mock `useLoaderData`, render with `renderToStaticMarkup`):

```tsx
// The store-domain page is the "Continue with Shopify" landing — it must render
// with the dashboard design system (AuthShell), carry return_to, and surface
// error states as friendly copy instead of raw JSON.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import DashboardLoginPage from "../dashboard.login";

describe("/dashboard/login page", () => {
  it("renders the store-domain form on the auth card, pre-filled from the hint", () => {
    loaderDataRef.current = { mode: "form", hintShop: "myshop.myshopify.com", returnTo: "/dashboard/connect?t=abc", errorCode: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-card");
    expect(html).toContain('name="shop"');
    expect(html).toContain('value="myshop.myshopify.com"');
    expect(html).toContain('name="return_to"');
    expect(html).toContain('value="/dashboard/connect?t=abc"');
    expect(html).not.toContain("#5b3df5"); // the off-brand inline style is gone
  });

  it("renders the app_not_installed error with install guidance and no retry loop", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "app_not_installed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    expect(html).toContain("Install the Calderyn app");
    expect(html).toContain("Try again"); // retry link back into the form
  });

  it("renders oauth_failed with a retry link for the known shop", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "oauth_failed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    expect(html).toContain("/dashboard/login?shop=myshop.myshopify.com");
  });
});
```

- [ ] **Step 3: Run both test files to verify the new/changed ones fail**

Run: `npx vitest run app/routes/__tests__/dashboard-login-returnto.test.ts app/routes/__tests__/dashboard-login-page.test.tsx`
Expected: FAIL (loader still returns HTML Responses; route has no default export).

- [ ] **Step 4: Rewrite the route**

Replace `app/routes/dashboard.login.tsx` in full:

```tsx
// app/routes/dashboard.login.tsx
// GET /dashboard/login?shop=x.myshopify.com → 302 to Shopify authorize.
// The state nonce lives in a short-lived HttpOnly cookie as `nonce:shop`.
//
// This is the Shopify-identity entry, reached from the embedded app's "Open
// dashboard" button (always ?shop=) and from /login's "Continue with Shopify"
// (no ?shop= — renders the store-domain form on the auth card, pre-filled from
// the __Host-dash_shop hint, never auto-redirecting: entering Shopify OAuth is
// always an explicit user action). ?error= renders the friendly failure state
// (oauth_failed, app_not_installed) instead of raw JSON.

import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError } from "~/components/auth/AuthCard";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
} from "~/lib/dashboard/shopify-oauth.server";
import {
  jsonError,
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
} from "~/lib/dashboard/http.server";
import { STATE_COOKIE_NAME, readShopHint } from "~/lib/dashboard/cookies.server";

export const meta: MetaFunction = () => [{ title: "Sign in with Shopify — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

type LoginPageData = {
  mode: "form" | "error";
  hintShop: string | null;
  returnTo: string | null;
  errorCode: string | null;
  shop: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (!(await rateLimit(clientIpKey(request, "dash-login"), 10, 60_000))) {
    throw jsonError(429, "rate_limited");
  }

  const url = new URL(request.url);
  const errorCode = url.searchParams.get("error");
  const rawShop = url.searchParams.get("shop");
  const hintShop = readShopHint(request);
  const returnTo = safeDashboardReturnTo(url.searchParams.get("return_to"));

  let shop: string | null = null;
  if (rawShop !== null) {
    // Explicit shop in the URL (the embedded-app entry point): validate strictly.
    const candidate = rawShop.trim().toLowerCase();
    if (!isValidShopDomain(candidate)) {
      throw jsonError(422, "invalid_shop", "Expected <name>.myshopify.com");
    }
    shop = candidate;
  }

  if (errorCode) {
    // Bounce-back from a failed round-trip: render the failure, never blindly
    // re-redirect (that would loop).
    return { mode: "error", hintShop, returnTo, errorCode, shop: shop ?? hintShop } satisfies LoginPageData;
  }
  if (!shop) {
    // No shop supplied (direct visit, /login button, connect redirect): ask for
    // it. The hint only pre-fills the form — no automatic redirect into OAuth.
    return { mode: "form", hintShop, returnTo, errorCode: null, shop: null } satisfies LoginPageData;
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

  // Carry a validated post-login destination (e.g. /dashboard/connect?t=…) in
  // the state cookie so it survives the OAuth round-trip. URL-encoded so its
  // query string can't collide with the cookie's `:` field separators.
  const stateValue = returnTo
    ? `${state}:${shop}:${encodeURIComponent(returnTo)}`
    : `${state}:${shop}`;

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=${stateValue}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  // The shop hint is set only AFTER a successful OAuth callback (see
  // dashboard.auth.callback), never here on an unauthenticated GET — otherwise a
  // crafted /dashboard/login?shop=... link could plant a 90-day hint that skews
  // the form pre-fill for the life of the cookie.
  return redirect(authorizeUrl, { headers });
}

export default function DashboardLoginPage() {
  const data = useLoaderData<typeof loader>() as LoginPageData;
  const retryHref = data.shop
    ? `/dashboard/login?shop=${encodeURIComponent(data.shop)}`
    : "/dashboard/login";
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in with Shopify</h1>
      <p className="cd-auth-sub">Connect your store and bring your data with you.</p>
      {data.mode === "error" ? (
        <>
          <AuthError code={data.errorCode} />
          <div className="cd-auth-links">
            <a href={retryHref}>Try again</a>
            <a href="/login">Sign in another way</a>
          </div>
        </>
      ) : (
        <>
          <form method="get" action="/dashboard/login">
            <label className="cd-auth-label" htmlFor="shop">
              Store domain
            </label>
            <input
              className="cd-auth-input"
              id="shop"
              name="shop"
              type="text"
              required
              placeholder="example.myshopify.com"
              defaultValue={data.hintShop ?? ""}
              pattern="[A-Za-z0-9][A-Za-z0-9-]*\.[Mm][Yy][Ss][Hh][Oo][Pp][Ii][Ff][Yy]\.[Cc][Oo][Mm]"
              autoComplete="on"
            />
            {data.returnTo ? <input type="hidden" name="return_to" value={data.returnTo} /> : null}
            <button className="cd-auth-submit" type="submit">
              Continue
            </button>
          </form>
          <p className="cd-auth-foot">
            Prefer email? <a href="/login">Sign in another way</a>
          </p>
        </>
      )}
    </AuthShell>
  );
}
```

- [ ] **Step 5: Run the two test files again**

Run: `npx vitest run app/routes/__tests__/dashboard-login-returnto.test.ts app/routes/__tests__/dashboard-login-page.test.tsx`
Expected: PASS.

- [ ] **Step 6: Sweep for other tests hitting this loader's removed behaviors**

Run: `grep -rln "dashboard.login\|dashboard/login" app --include='*.test.*'` and run each hit with `npx vitest run <files>`. Any test asserting the old HTML-string body or a *returned* (not thrown) 422/429 Response gets updated to the new contract (thrown Responses: `await expect(loader(...)).rejects.toMatchObject({ status: 429 })`). Do not weaken assertions — port them.

- [ ] **Step 7: Commit**

```bash
git add app/routes/dashboard.login.tsx app/routes/__tests__/dashboard-login-returnto.test.ts app/routes/__tests__/dashboard-login-page.test.tsx
git commit -m "routes/dashboard.login: store-domain + error pages on AuthShell"
```

---

### Task 3: "Continue with Shopify" provider button on `/login`

**Files:**
- Modify: `app/components/auth/AuthCard.tsx` (add `ShopifyButton`)
- Modify: `app/routes/login.tsx` (button replaces the foot link)
- Test: `app/routes/__tests__/login-shopify-button.test.tsx` (new)

Icon rule (CLAUDE.md): dashboard icons go through the `CD_ICONS` registry. First check `app/components/dashboard/icons.tsx` for an existing bag/store entry and reuse it; if none, import `Store` from `lucide-react` and add one registry line. Do NOT hand-draw an SVG or imitate the Shopify trademark glyph.

- [ ] **Step 1: Write the failing test**

```tsx
// "Continue with Shopify" is a first-class provider option on the sign-in
// page (not a foot link) and must carry return_to into the OAuth entry.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";

describe("/login Shopify provider button", () => {
  it("renders a provider button linking to /dashboard/login", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: null };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("Continue with Shopify");
    expect(html).toContain('href="/dashboard/login"');
    // No demoted foot-link variant left behind.
    expect(html).not.toContain("Sign in with Shopify instead");
  });

  it("carries return_to into the Shopify entry like the Google button does", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: "/dashboard/connect?t=abc" };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(
      `href="/dashboard/login?return_to=${encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;")}"`,
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run app/routes/__tests__/login-shopify-button.test.tsx`
Expected: FAIL ("Continue with Shopify" not found).

- [ ] **Step 3: Add `ShopifyButton` to AuthCard.tsx**

After `GoogleButton`, following its exact shape (same `cd-auth-google` class — it's the generic bordered provider-button style):

```tsx
export function ShopifyButton({ label, href = "/dashboard/login" }: { label: string; href?: string }) {
  return (
    <a className="cd-auth-google" href={href}>
      <CDIcon name="store" size={16} />
      {label}
    </a>
  );
}
```

(Adjust the icon name to whatever the registry check in the task intro settled on; add the one-line `CD_ICONS` entry if it was missing. Import `CDIcon` from `~/components/dashboard/icons`.)

- [ ] **Step 4: Wire it into login.tsx**

In `app/routes/login.tsx`: import `ShopifyButton` alongside the other AuthCard imports; compute the href next to `googleHref`:

```tsx
  const shopifyHref = returnTo
    ? `/dashboard/login?return_to=${encodeURIComponent(returnTo)}`
    : "/dashboard/login";
```

Render it directly under the Google button (before the divider):

```tsx
      <GoogleButton label="Continue with Google" href={googleHref} />
      <ShopifyButton label="Continue with Shopify" href={shopifyHref} />
      <div className="cd-auth-divider">or</div>
```

Delete the `cd-auth-foot` paragraph ("Store connected through Shopify? …") at the bottom.

- [ ] **Step 5: Run the test again**

Run: `npx vitest run app/routes/__tests__/login-shopify-button.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/auth/AuthCard.tsx app/components/dashboard/icons.tsx app/routes/login.tsx app/routes/__tests__/login-shopify-button.test.tsx
git commit -m "routes/login: promote Shopify OAuth to a provider button"
```

---

### Task 4: Callback — friendly not-installed page + import steering

**Files:**
- Modify: `app/routes/dashboard.auth.callback.tsx:90-108`
- Test: extend the existing callback coverage (find it: `grep -rln "dashboard.auth.callback" app --include='*.test.*'` — expected in `app/lib/dashboard/__tests__/auth-routes.test.ts`)

- [ ] **Step 1: Write the failing tests**

Add to the existing callback describe block (reusing its request/cookie helpers; mock the import poll at the top of the file with the other mocks):

```ts
const latestImport = vi.fn(async (_shopId: string) => null as unknown);
vi.mock("~/lib/import/run.server", () => ({
  latestImport: (...a: unknown[]) => latestImport(...a),
}));
```

```ts
  it("redirects an uninstalled shop to the friendly login error page, not raw JSON", async () => {
    resolveShopId.mockRejectedValueOnce(new Error("unknown shop"));
    const res = (await callbackLoader(validCallbackRequest())) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/login?error=app_not_installed");
    // The in-flight state cookie dies with the failure.
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-dash_oauth=;"))).toBe(true);
  });

  it("steers a shop with no completed import to the import screen", async () => {
    latestImport.mockResolvedValueOnce(null);
    const res = (await callbackLoader(validCallbackRequest())) as Response;
    expect(res.headers.get("Location")).toContain("/dashboard/settings/import");
  });

  it("sends a shop whose import is done to the dashboard home", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
    const res = (await callbackLoader(validCallbackRequest())) as Response;
    expect(res.headers.get("Location")).toContain("/dashboard");
    expect(res.headers.get("Location")).not.toContain("/settings/import");
  });

  it("lets an explicit return_to win over import steering", async () => {
    latestImport.mockResolvedValueOnce(null);
    const res = (await callbackLoader(validCallbackRequestWithReturnTo("/dashboard/connect?t=abc"))) as Response;
    expect(res.headers.get("Location")).toContain("/dashboard/connect?t=abc");
  });

  it("falls back to the dashboard when the import poll itself fails", async () => {
    latestImport.mockRejectedValueOnce(new Error("db down"));
    const res = (await callbackLoader(validCallbackRequest())) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).not.toContain("/settings/import");
  });
```

(`validCallbackRequest…` = whatever helper the existing tests use to build a passing HMAC/state request — reuse it verbatim; if the existing tests build requests inline, follow that.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run <the callback test file>` — Expected: new tests FAIL (403 JSON; Location is `/dashboard`).

- [ ] **Step 3: Implement**

In `dashboard.auth.callback.tsx`, replace the gate + destination block (lines 90-108) with:

```ts
  // Gate: only shops with the app installed (provisioned in Supabase) may sign
  // in — the import pipeline runs on the offline token minted at install, so an
  // uninstalled shop has nothing to port. Friendly page, not raw JSON.
  let shopId: string;
  try {
    shopId = await resolveShopId(shop);
  } catch {
    return redirect(`${publicUrl}/dashboard/login?error=app_not_installed&shop=${encodeURIComponent(shop)}`, {
      headers: { "Set-Cookie": expireCookieHeader(STATE_COOKIE_NAME) },
    });
  }

  const { raw } = await createSession(shop);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  // Remember the shop so a future visit to /dashboard/login pre-fills the
  // store-domain form (it no longer triggers any automatic redirect).
  headers.append("Set-Cookie", shopHintCookieHeader(shop));
  headers.append("Set-Cookie", expireCookieHeader(STATE_COOKIE_NAME));
  // Destination: an explicit validated return_to wins (connector consent flow);
  // otherwise a shop that never finished a data port lands on the import screen
  // (the "Continue with Shopify" promise), and everyone else on the home.
  let dest = safeDashboardReturnTo(cookieState.returnTo);
  if (!dest) {
    try {
      // Lazy-loaded: run.server pulls the ingest/shopify.server chain — keep
      // that out of this auth route's module graph (module-load env coupling).
      const { latestImport } = await import("~/lib/import/run.server");
      const last = await latestImport(shopId);
      dest = last?.state === "done" ? "/dashboard" : "/dashboard/settings/import";
    } catch {
      dest = "/dashboard"; // a broken poll must not break sign-in
    }
  }
  return redirect(`${publicUrl}${dest}`, { headers });
```

Note: the `?shop=` on the error redirect lets the login page's "Try again" retry the right store. Task 2's loader already reads it (`rawShop` branch runs even when `errorCode` is set).

- [ ] **Step 4: Run the callback tests**

Run: `npx vitest run <the callback test file>` — Expected: PASS (including the pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.auth.callback.tsx <the callback test file>
git commit -m "routes/dashboard.auth.callback: friendly not-installed page + first-import steering"
```

---

### Task 5: `fetchCustomers` ingest generator + scope

**Files:**
- Modify: `app/lib/ingest/shopify-admin.server.ts` (append `AdminCustomer` + `fetchCustomers`)
- Modify: `.env.example:3` (`SCOPES=…` gains `read_customers`)

No dedicated test — the generator is the same thin gql-pagination shape as `fetchProducts` (which is untested by convention here); the logic that can break lives in Task 6 and is tested there with this module mocked.

- [ ] **Step 1: Append to shopify-admin.server.ts**

```ts
export type AdminCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  defaultAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  emailMarketingConsent: { marketingState: string; consentUpdatedAt: string | null } | null;
};

type CustomersPage = { customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminCustomer[] } };

// Requires the read_customers scope AND Shopify's protected-customer-data
// approval (Partner Dashboard). Without them the query errors ACCESS_DENIED —
// the import stage classifies that as "blocked", never a silent skip.
export async function* fetchCustomers(shopDomain: string): AsyncGenerator<AdminCustomer> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data: CustomersPage = await gql<CustomersPage>(
      admin,
      `#graphql
      query Customers($cursor: String) {
        customers(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id email phone
            defaultAddress { name address1 address2 city province zip country phone }
            emailMarketingConsent { marketingState consentUpdatedAt }
          }
        }
      }`,
      { cursor },
    );
    for (const node of data.customers.nodes) yield node;
    cursor = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
  } while (cursor);
}
```

- [ ] **Step 2: Update `.env.example`**

Line 3 becomes:

```
SCOPES=read_products,read_inventory,write_inventory,read_orders,read_locations,write_shipping,read_customers
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/lib/ingest/shopify-admin.server.ts .env.example
git commit -m "lib/ingest: fetchCustomers generator + read_customers scope"
```

---

### Task 6: Customer import stage into the buyer PII store

**Files:**
- Create: `app/lib/import/customers.server.ts`
- Test: `app/lib/import/__tests__/customers-import.test.ts`

Hard invariant (migration `20260629100000_buyer_identity.sql`): buyer PII lives ONLY in `buyer_dim`/`buyer_address`/`buyer_consent` — never in warehouse tables. All writes go through the existing `~/lib/buyer/identity.server` helpers.

- [ ] **Step 1: Write the failing tests**

```ts
// Customer import: Shopify customers → the buyer PII store. The behaviors that
// matter: no-email customers are counted (not silently dropped), ACCESS_DENIED
// classifies as blocked (protected-customer-data approval pending), addresses
// are only added once (re-import idempotency), marketing consent is recorded
// only for explicit SUBSCRIBED/UNSUBSCRIBED states.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminCustomer } from "~/lib/ingest/shopify-admin.server";

const customers: AdminCustomer[] = [];
let fetchError: Error | null = null;
vi.mock("~/lib/ingest/shopify-admin.server", () => ({
  fetchCustomers: async function* () {
    if (fetchError) throw fetchError;
    yield* customers;
  },
}));

const upsertGuestBuyer = vi.fn(async (_shopId: string, input: { email: string }) => ({
  id: `buyer-${input.email}`,
  shopId: "shop-1",
  emailNormalized: input.email.toLowerCase(),
  phone: null,
  createdAt: "2026-07-03T00:00:00Z",
}));
const addBuyerAddress = vi.fn(async () => ({}) as unknown);
const recordConsent = vi.fn(async () => ({}) as unknown);
vi.mock("~/lib/buyer/identity.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/buyer/identity.server")>()),
  upsertGuestBuyer: (...a: unknown[]) => upsertGuestBuyer(...(a as [string, { email: string }])),
  addBuyerAddress: (...a: unknown[]) => addBuyerAddress(...a),
  recordConsent: (...a: unknown[]) => recordConsent(...a),
}));

const existingShippingAddress = vi.fn(async () => false);
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({
                data: (await existingShippingAddress()) ? [{ id: "addr-1" }] : [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// eslint-disable-next-line import/first
import { importCustomers } from "../customers.server";

function customer(over: Partial<AdminCustomer>): AdminCustomer {
  return {
    id: "gid://shopify/Customer/1",
    email: "a@example.com",
    phone: null,
    defaultAddress: null,
    emailMarketingConsent: null,
    ...over,
  };
}

describe("importCustomers", () => {
  beforeEach(() => {
    customers.length = 0;
    fetchError = null;
    existingShippingAddress.mockResolvedValue(false);
    vi.clearAllMocks();
  });

  it("upserts each emailed customer as a buyer and counts them", async () => {
    customers.push(customer({ email: "a@example.com" }), customer({ id: "2", email: "b@example.com" }));
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r).toEqual({ imported: 2, skipped: 0, blocked: false });
    expect(upsertGuestBuyer).toHaveBeenCalledTimes(2);
  });

  it("counts customers without an email as skipped — never silently dropped", async () => {
    customers.push(customer({ email: null }), customer({ id: "2", email: "b@example.com" }));
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r).toEqual({ imported: 1, skipped: 1, blocked: false });
  });

  it("classifies ACCESS_DENIED as blocked, not an error", async () => {
    fetchError = new Error('Admin GraphQL error: [{"extensions":{"code":"ACCESS_DENIED"}}]');
    const r = await importCustomers("s.myshopify.com", "shop-1");
    expect(r.blocked).toBe(true);
  });

  it("rethrows non-access errors so the run lands in state=error", async () => {
    fetchError = new Error("ECONNRESET");
    await expect(importCustomers("s.myshopify.com", "shop-1")).rejects.toThrow("ECONNRESET");
  });

  it("adds the default address once and skips it on re-import", async () => {
    customers.push(
      customer({ defaultAddress: { name: "A", address1: "1 Main St", address2: null, city: "NY", province: "NY", zip: "10001", country: "US", phone: null } }),
    );
    await importCustomers("s.myshopify.com", "shop-1");
    expect(addBuyerAddress).toHaveBeenCalledTimes(1);
    existingShippingAddress.mockResolvedValue(true);
    await importCustomers("s.myshopify.com", "shop-1");
    expect(addBuyerAddress).toHaveBeenCalledTimes(1); // unchanged
  });

  it("records marketing consent only for explicit states", async () => {
    customers.push(
      customer({ emailMarketingConsent: { marketingState: "SUBSCRIBED", consentUpdatedAt: "2026-01-01T00:00:00Z" } }),
      customer({ id: "2", email: "b@example.com", emailMarketingConsent: { marketingState: "NOT_SUBSCRIBED", consentUpdatedAt: null } }),
    );
    await importCustomers("s.myshopify.com", "shop-1");
    expect(recordConsent).toHaveBeenCalledTimes(1);
    expect(recordConsent).toHaveBeenCalledWith("shop-1", "buyer-a@example.com", expect.objectContaining({ policy: "marketing", accepted: true }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/lib/import/__tests__/customers-import.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement `app/lib/import/customers.server.ts`**

```ts
// Import-from-Shopify: the customer stage. Shopify customers land in the buyer
// PII store (buyer_dim / buyer_address / buyer_consent) — DELIBERATELY outside
// the analytics warehouse, via the same identity helpers the storefront uses.
// Requires read_customers + Shopify's protected-customer-data approval; until
// granted the stage reports itself blocked (visible in the import report),
// never silently empty.
import { fetchCustomers, type AdminCustomer } from "~/lib/ingest/shopify-admin.server";
import { getSupabase } from "~/lib/supabase.server";
import { upsertGuestBuyer, addBuyerAddress, recordConsent } from "~/lib/buyer/identity.server";

export interface CustomerImportResult {
  imported: number;
  skipped: number; // customers with no usable email — buyer identity is email-keyed
  blocked: boolean; // protected-customer-data access not granted yet
}

function isAccessDenied(err: unknown): boolean {
  return err instanceof Error && err.message.includes("ACCESS_DENIED");
}

async function hasShippingAddress(shopId: string, buyerId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("buyer_address")
    .select("id")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("kind", "shipping")
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function importOne(shopId: string, c: AdminCustomer): Promise<void> {
  const buyer = await upsertGuestBuyer(shopId, { email: c.email as string, phone: c.phone ?? undefined });

  const a = c.defaultAddress;
  // addBuyerAddress INSERTS (append) — only add when the buyer has no shipping
  // address yet, so a re-import doesn't stack duplicates. line1+country are the
  // helper's presence guard; an address without them is unusable anyway.
  if (a?.address1 && a.country && !(await hasShippingAddress(shopId, buyer.id))) {
    await addBuyerAddress(shopId, buyer.id, {
      kind: "shipping",
      isDefault: true,
      name: a.name,
      line1: a.address1,
      line2: a.address2,
      city: a.city,
      region: a.province,
      postal: a.zip,
      country: a.country,
      phone: a.phone,
    });
  }

  // Marketing consent: only explicit states carry over; PENDING/INVALID/unknown
  // record nothing. Version stamps the provenance so the append-only consent
  // ledger shows this row came from the Shopify port, dated by Shopify's own
  // consent timestamp when it has one.
  const state = c.emailMarketingConsent?.marketingState;
  if (state === "SUBSCRIBED" || state === "UNSUBSCRIBED") {
    await recordConsent(shopId, buyer.id, {
      policy: "marketing",
      version: "shopify-import-2026-07",
      accepted: state === "SUBSCRIBED",
      capturedAt: c.emailMarketingConsent?.consentUpdatedAt ?? undefined,
    });
  }
}

export async function importCustomers(shopDomain: string, shopId: string): Promise<CustomerImportResult> {
  const result: CustomerImportResult = { imported: 0, skipped: 0, blocked: false };
  try {
    for await (const c of fetchCustomers(shopDomain)) {
      if (!c.email || !c.email.includes("@")) {
        result.skipped += 1;
        continue;
      }
      await importOne(shopId, c);
      result.imported += 1;
    }
  } catch (err) {
    if (isAccessDenied(err)) return { ...result, blocked: true };
    throw err; // anything else fails the run visibly (state='error')
  }
  return result;
}
```

Note on re-import consent: `upsertGuestBuyer` is idempotent, but `recordConsent` appends — a re-import appends another identical consent row. Accepted: the ledger is append-only by design, `version` marks the source, and imports are rare. If it bothers the reviewer, the upgrade path is a latest-row check before insert — do NOT dedupe by mutating rows.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/lib/import/__tests__/customers-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/import/customers.server.ts app/lib/import/__tests__/customers-import.test.ts
git commit -m "lib/import: customer stage into the buyer PII store"
```

---

### Task 7: Wire customers into the import run + honest report

**Files:**
- Modify: `app/lib/import/promote.server.ts:24-41` (`buildImportReport` gains a customers param)
- Modify: `app/lib/import/run.server.ts:76-86` (drain calls the stage)
- Modify: `app/components/dashboard/screens/ImportShopify.tsx` — check for static "what gets imported" copy; if it hardcodes the customer exclusion, align it ("Customers come over too, once Shopify grants data access")
- Test: extend the existing import tests (`grep -rln "buildImportReport\|drainImports" app --include='*.test.*'`)

- [ ] **Step 1: Write the failing tests**

In the existing report/run test file (follow its local conventions):

```ts
  it("reports imported customers with the skipped count", () => {
    const report = buildImportReport(counts, 12, { imported: 40, skipped: 2, blocked: false });
    expect(report.imported).toContain("40 customers (2 skipped — no email address)");
    expect(report.notIncluded.join(" ")).not.toContain("customer");
  });

  it("keeps customers in notIncluded — with the real reason — when blocked", () => {
    const report = buildImportReport(counts, 12, { imported: 0, skipped: 0, blocked: true });
    expect(report.notIncluded.join(" ")).toContain("customer");
    expect(report.notIncluded.join(" ")).toContain("access");
  });

  it("drainImports runs the customer stage and feeds the report", async () => {
    importCustomersMock.mockResolvedValueOnce({ imported: 3, skipped: 0, blocked: false });
    await drainImports();
    expect(importCustomersMock).toHaveBeenCalledWith("s.myshopify.com", "shop-1");
    // the update() payload's report.imported includes the customers line
  });
```

(with `vi.mock("~/lib/import/customers.server", …)` at the top; assert the `update` payload the same way the existing drain tests inspect it.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run <that test file>` — Expected: FAIL (signature mismatch).

- [ ] **Step 3: Implement the report change**

Replace `buildImportReport` in `promote.server.ts`:

```ts
/**
 * Honest import summary. The exclusions are FIXED copy (not free-form) so the report can
 * never overstate what was brought over (rule 12). Customers appear in `imported` only
 * when the stage actually ran; while Shopify's protected-customer-data approval is
 * pending, they stay in notIncluded with the real reason.
 */
export function buildImportReport(
  counts: PromoteCounts,
  orderCount: number,
  customers: { imported: number; skipped: number; blocked: boolean },
): { imported: string[]; notIncluded: string[] } {
  const customersRan = !customers.blocked;
  return {
    imported: [
      `${counts.products} products (${counts.variants} variants)`,
      `${counts.collections} collections`,
      // counts.balances is stock RECORDS (one per variant at each location), not locations.
      `${counts.balances} stock records`,
      `${orderCount} past orders (last 12 months)`,
      ...(customersRan
        ? [
            customers.skipped > 0
              ? `${customers.imported} customers (${customers.skipped} skipped — no email address)`
              : `${customers.imported} customers`,
          ]
        : []),
    ],
    notIncluded: [
      ...(customersRan
        ? []
        : ["Your customer list — Shopify hasn't granted Calderyn customer-data access yet, so it couldn't come over this run."]),
      "Your store design / theme, which is re-created in Calderyn's builder later.",
    ],
  };
}
```

- [ ] **Step 4: Wire the drain**

In `run.server.ts`, add the import at top: `import { importCustomers } from "./customers.server";` and inside the try block of `drainImports`:

```ts
      const backfill = await backfillShop(domain, { sinceDays });
      const customers = await importCustomers(domain, shopId);
      await sb.from("import_run").update({ state: "promoting" }).eq("id", id);

      const counts = await promoteShopFromMirror(shopId);
      const report = buildImportReport(counts, backfill.orders, customers);
```

- [ ] **Step 5: Run the import test files + typecheck**

Run: `npx vitest run <import test files>` and `npm run typecheck` — Expected: PASS / exit 0. (Typecheck will flag any other `buildImportReport` caller — fix each with a real customers argument, never a dummy `{blocked:false}` that fakes a run.)

- [ ] **Step 6: Check ImportShopify.tsx static copy**

Read the screen; if its pre-import copy hardcodes "customers not included", update to match reality (imported when access granted, honest blocked line otherwise — the report drives the post-run truth). If the copy just renders the server report, no change.

- [ ] **Step 7: Commit**

```bash
git add app/lib/import/promote.server.ts app/lib/import/run.server.ts app/components/dashboard/screens/ImportShopify.tsx <test files>
git commit -m "lib/import: customer stage wired into the run + honest report"
```

---

### Task 8: Security sweep of the sign-in surfaces

**Files:** findings-driven; expected candidates: `app/routes/login.tsx`, `dashboard.login.tsx`, `dashboard.signin.tsx`, `dashboard.auth.callback.tsx`, `dashboard.auth.google*.tsx`

- [ ] **Step 1: Run the branch security review**

Invoke the `security-review` skill on the working tree (it reviews the branch's pending changes). Every finding: fix on the branch, or downgrade with a one-line justification. No silent dismissals.

- [ ] **Step 2: Targeted auth-surface checklist**

Verify each, and fix inline where broken (each is one small change):
- `return_to` never reaches a redirect/header un-revalidated (`safeDashboardReturnTo` at every consumption point, including the new callback steering and both new hidden form fields).
- The new `?shop=` on the error redirect (Task 4) is only ever emitted after `isValidShopDomain` and is re-validated by the login loader on the way back in.
- Rate limits still cover: `/dashboard/login` GET, callback GET, signin POST (per-IP + per-account) — the rewrites must not have dropped one.
- Cookie flags intact on every Set-Cookie the diff touches (`__Host-` name, `HttpOnly; Secure; SameSite=Lax`, Max-Age where bounded).
- Error responses don't distinguish "wrong password" from "no such account" (enumeration), and the new `app_not_installed` page doesn't leak whether a shop exists in Supabase beyond what OAuth already proved (requester controls the shop — acceptable).
- `autocomplete` attributes correct: `current-password` on signin, `new-password` on signup/reset-confirm, `email` on email fields.
- No PII (emails, shop tokens) added to `console.*` in the diff; customer import errors truncate to the existing 500-char cap.
- `npm run build` passes `scripts/verify-client-bundle.mjs` (no server-only import leaked into the client bundle by the route rewrites).

- [ ] **Step 3: Commit fixes**

```bash
git add -A && git commit -m "auth surfaces: security sweep fixes"
```

(Skip the commit if the sweep is clean — say so explicitly in the report.)

---

### Task 9: Gate + PR

- [ ] **Step 1: Full pre-commit gate (CLAUDE.md order, paste results)**

```bash
npx vitest run          # full suite
npm run typecheck       # exit 0
npm run lint            # exit 0, no warnings on touched files
npm run build           # includes verify-client-bundle.mjs
```

No prisma/graphql-codegen steps needed (no schema or .graphql changes — customer tables already exist; verify no supabase migration was added by this work).

- [ ] **Step 2: /code-review on the working tree**

Run the `code-review` skill; resolve every blocker.

- [ ] **Step 3: Patch sanity**

`git diff main --stat` and `git diff main --check`; grep the diff for `console.log`, `.only(`, `TODO(`, provenance markers. Expected: clean.

- [ ] **Step 4: Push + PR**

PR body must state the two external rollout steps (neither is code):
1. Add `read_customers` to `SCOPES` in Vercel env + `shopify app deploy`; existing merchants re-approve scopes on their next OAuth.
2. Request protected-customer-data access in the Partner Dashboard; until approved the import report shows the customer stage as blocked (by design).

Include the platform-pivot progress footer (spec §Platform-pivot reporting) — this PR advances the sign-in/import surface of the MVP build order.

---

## Self-review notes

- **Spec coverage:** §1→Task 3, §2→Task 2, §3→Task 4, §4→Tasks 1+2+4, §5→Tasks 5+6+7, §6→Task 8. Testing section→each task's tests. Rollout→Task 9 PR body.
- **Type consistency:** `CustomerImportResult {imported, skipped, blocked}` is the shape passed from `drainImports` (Task 7) into `buildImportReport` (Task 7) and returned by `importCustomers` (Task 6). `LoginPageData.mode: "form"|"error"` is consumed only inside `dashboard.login.tsx` and the two test files.
- **Known judgment calls:** consent rows may duplicate on re-import (documented in Task 6, append-only by design); `latestImport` is dynamically imported in the callback to keep `shopify.server` out of the auth route's module graph.
