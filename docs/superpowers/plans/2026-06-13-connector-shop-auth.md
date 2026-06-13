# Connector shop-auth button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "type your store domain" `TextField` in the Claude MCP connector sign-in with a button-first flow — one-click for a remembered shop, a "Log in with Shopify" page otherwise — on both the embedded and dashboard surfaces.

**Architecture:** The authorize interstitial (`/oauth/authorize`) resolves a known shop from a `?shop=` hint *or* a host-scoped `__Host-cala_shop` cookie (read-only — the endpoint must never `Set-Cookie`). Known → existing one-click admin deep link. Unknown → a new `/oauth/login` page captures the shop once, writes the cookie, and hands off to the same admin deep link (which carries the signed `?t=` token through Shopify's own login). The dashboard mirror turns `/dashboard/login`'s no-shop dead-end into a shop-entry form that re-enters the existing `?shop=` loader path.

**Tech Stack:** Remix (Vite) loaders/actions, React 18 + Shopify Polaris (embedded), raw inline-HTML responses (dashboard login), `jose` HS256 pending-token (existing `mcp_oauth.server`), Vitest (node env, `renderToString` for component smoke tests).

**Spec:** `docs/superpowers/specs/2026-06-13-connector-shop-auth-button-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `app/lib/connect-deeplink.ts` (create) | Pure/isomorphic: `SHOP_RE`, `buildAppConnectUrl()` (admin deep link). Shared by authorize + login. |
| `app/lib/connect-deeplink.server.ts` (create) | Server-only: `__Host-cala_shop` cookie read/write helpers. |
| `app/lib/__tests__/connect-deeplink.test.ts` (create) | Unit tests for both helpers above. |
| `app/routes/oauth.authorize.tsx` (modify) | Loader reads the cookie; interstitial no-shop branch becomes a "Log in with Shopify" button. Deletes local `SHOP_RE`/`buildConnectUrl` (now shared). |
| `app/routes/__tests__/oauth-authorize.test.ts` (modify) | Add cookie-read loader tests + no-`Set-Cookie` regression. |
| `app/routes/__tests__/oauth-authorize-ui.test.ts` (create) | `renderToString` smoke test for the button-first interstitial. |
| `app/routes/oauth.login.tsx` (create) | The connector's "Shopify login page": shop field → cookie + admin deep link. |
| `app/routes/__tests__/oauth-login.test.ts` (create) | Loader + action tests. |
| `app/routes/dashboard.login.tsx` (modify) | No-shop branch renders a shop-entry form (`loginFormPage`) instead of the dead-end info page. |
| `app/routes/__tests__/dashboard-login-returnto.test.ts` (modify) | Add the form-render + return_to-preservation test. |

---

## Task 1: Shared deep-link + cookie helpers

**Files:**
- Create: `app/lib/connect-deeplink.ts`
- Create: `app/lib/connect-deeplink.server.ts`
- Test: `app/lib/__tests__/connect-deeplink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/connect-deeplink.test.ts`:

```ts
// app/lib/__tests__/connect-deeplink.test.ts
import { describe, it, expect } from "vitest";
import { buildAppConnectUrl, SHOP_RE } from "../connect-deeplink";
import { readShopHintCookie, shopHintCookieHeader } from "../connect-deeplink.server";

describe("SHOP_RE", () => {
  it("accepts a myshopify domain and rejects anything else", () => {
    expect(SHOP_RE.test("my-shop.myshopify.com")).toBe(true);
    expect(SHOP_RE.test("evil.com")).toBe(false);
    expect(SHOP_RE.test("a.myshopify.com.evil.com")).toBe(false);
  });
});

describe("buildAppConnectUrl", () => {
  const base = { apiKey: "apikey123", appUrl: "https://app.calderyncompany.com", token: "tok 123" };

  it("builds an admin.shopify.com deep link for a known shop, url-encoding the token", () => {
    const url = buildAppConnectUrl({ ...base, shop: "myshop.myshopify.com" });
    expect(url).toBe("https://admin.shopify.com/store/myshop/apps/apikey123/app/connect?t=tok%20123");
  });

  it("falls back to the app URL when the shop is missing", () => {
    expect(buildAppConnectUrl({ ...base, shop: null })).toBe(
      "https://app.calderyncompany.com/app/connect?t=tok%20123",
    );
  });

  it("falls back to the app URL when the shop is not a myshopify domain", () => {
    expect(buildAppConnectUrl({ ...base, shop: "evil.com" })).toBe(
      "https://app.calderyncompany.com/app/connect?t=tok%20123",
    );
  });
});

describe("__Host-cala_shop cookie helpers", () => {
  it("emits a hardened, host-scoped Set-Cookie value", () => {
    const h = shopHintCookieHeader("myshop.myshopify.com");
    expect(h).toContain("__Host-cala_shop=myshop.myshopify.com");
    expect(h).toContain("Path=/");
    expect(h).toContain("Secure");
    expect(h).toContain("HttpOnly");
    expect(h).toContain("SameSite=Lax");
  });

  it("reads a valid shop from the request cookie", () => {
    const req = new Request("https://app.calderyncompany.com/oauth/authorize", {
      headers: { Cookie: "x=1; __Host-cala_shop=Remembered.myshopify.com; y=2" },
    });
    expect(readShopHintCookie(req)).toBe("remembered.myshopify.com");
  });

  it("returns null when the cookie is absent", () => {
    expect(readShopHintCookie(new Request("https://app.calderyncompany.com/x"))).toBeNull();
  });

  it("rejects a non-myshopify cookie value (injection guard)", () => {
    const req = new Request("https://app.calderyncompany.com/x", {
      headers: { Cookie: "__Host-cala_shop=evil.com" },
    });
    expect(readShopHintCookie(req)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/connect-deeplink.test.ts`
Expected: FAIL — `Cannot find module '../connect-deeplink'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/connect-deeplink.ts`:

```ts
// app/lib/connect-deeplink.ts
//
// Shared, isomorphic helpers for the Claude.ai MCP connector sign-in. Building
// the embedded /app/connect deep link is needed by BOTH the authorize
// interstitial (oauth.authorize.tsx) and the cold-path login page
// (oauth.login.tsx), so it lives here instead of being duplicated.

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export interface BuildConnectUrlOpts {
  shop: string | null;
  apiKey: string;
  appUrl: string;
  token: string;
}

// When we know the shop, an admin.shopify.com deep link is the most reliable
// carrier: Shopify admin preserves its own URLs through login, so the ?t= token
// survives an unauthenticated landing. Otherwise fall back to the app URL and let
// the app's standard auth resolve the shop.
export function buildAppConnectUrl({ shop, apiKey, appUrl, token }: BuildConnectUrlOpts): string {
  const t = encodeURIComponent(token);
  if (shop && SHOP_RE.test(shop) && apiKey) {
    const handle = shop.replace(/\.myshopify\.com$/i, "");
    return `https://admin.shopify.com/store/${handle}/apps/${apiKey}/app/connect?t=${t}`;
  }
  return `${appUrl}/app/connect?t=${t}`;
}
```

Create `app/lib/connect-deeplink.server.ts`:

```ts
// app/lib/connect-deeplink.server.ts
//
// Server-only: the remembered-shop hint cookie for the connector authorize
// origin (app.calderyncompany.com). Host-scoped (__Host- prefix) so /oauth/authorize
// can READ it and /oauth/login can WRITE it on the same host. This is NOT
// consumable OAuth state — it is the same trust level as the ?shop= query hint
// (mirrors the dashboard's __Host-dash_shop). /oauth/authorize must never
// Set-Cookie (the no-pre-seed invariant from PR #107); only /oauth/login writes.

import { SHOP_RE } from "./connect-deeplink";

export const SHOP_HINT_COOKIE_NAME = "__Host-cala_shop";
const MAX_AGE = 90 * 86_400; // 90 days

export function readShopHintCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SHOP_HINT_COOKIE_NAME) {
      const value = rest.join("=").trim().toLowerCase();
      return SHOP_RE.test(value) ? value : null;
    }
  }
  return null;
}

export function shopHintCookieHeader(shop: string): string {
  return `${SHOP_HINT_COOKIE_NAME}=${shop}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/connect-deeplink.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/connect-deeplink.ts app/lib/connect-deeplink.server.ts app/lib/__tests__/connect-deeplink.test.ts
git commit -m "lib/connect-deeplink: shared admin deep-link + __Host-cala_shop cookie helpers"
```

---

## Task 2: `/oauth/login` cold-path page

**Files:**
- Create: `app/routes/oauth.login.tsx`
- Test: `app/routes/__tests__/oauth-login.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/oauth-login.test.ts`:

```ts
// app/routes/__tests__/oauth-login.test.ts
//
// /oauth/login is the connector cold-path "Log in with Shopify" page. It captures
// the shop, remembers it (__Host-cala_shop), and 302s to the admin deep link that
// carries the signed ?t= token into /app/connect. No Shopify OAuth happens here.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../../lib/mcp_oauth.server")>();
  return { ...actual, getClient: vi.fn() };
});

// eslint-disable-next-line import/first
import { getClient, signPendingOauth } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first
import { loader, action } from "../oauth.login";

const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;

const CTX = {
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "challenge",
  scope: "read",
  state: "abc",
};

function clientFixture() {
  return {
    client_id: "cal_client_x",
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
    token_endpoint_auth_method: "none",
  };
}

function postReq(body: Record<string, string>): { request: Request } {
  return {
    request: new Request("https://app.calderyncompany.com/oauth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  };
}

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  process.env.SHOPIFY_API_KEY = "apikey123";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  getClientMock.mockReset();
});

describe("/oauth/login loader", () => {
  it("404 when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = (await loader({
      request: new Request("https://app.calderyncompany.com/oauth/login?t=x"),
    } as never)) as Response;
    expect(r.status).toBe(404);
  });

  it("redirects to /app when the token is invalid", async () => {
    const r = (await loader({
      request: new Request("https://app.calderyncompany.com/oauth/login?t=garbage"),
    } as never)) as Response;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://app.calderyncompany.com/app");
  });

  it("renders (200) with the client name for a valid token", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const token = await signPendingOauth(CTX);
    const r = (await loader({
      request: new Request(`https://app.calderyncompany.com/oauth/login?t=${encodeURIComponent(token)}`),
    } as never)) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.token).toBe(token);
  });
});

describe("/oauth/login action", () => {
  it("302s to the admin deep link and remembers the shop on a valid submit", async () => {
    const token = await signPendingOauth(CTX);
    const r = (await action(postReq({ t: token, shop: "MyShop.myshopify.com" }) as never)) as Response;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `https://admin.shopify.com/store/myshop/apps/apikey123/app/connect?t=${encodeURIComponent(token)}`,
    );
    expect(r.headers.get("set-cookie") ?? "").toContain("__Host-cala_shop=myshop.myshopify.com");
  });

  it("422s without a cookie when the shop is invalid", async () => {
    const token = await signPendingOauth(CTX);
    const r = (await action(postReq({ t: token, shop: "evil.com" }) as never)) as Response;
    expect(r.status).toBe(422);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("location")).toBeNull();
  });

  it("400s when the token is invalid", async () => {
    const r = (await action(postReq({ t: "garbage", shop: "myshop.myshopify.com" }) as never)) as Response;
    expect(r.status).toBe(400);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/oauth-login.test.ts`
Expected: FAIL — `Cannot find module '../oauth.login'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/routes/oauth.login.tsx`:

```tsx
// app/routes/oauth.login.tsx
//
// Cold-path "Log in with Shopify" page for the Claude.ai MCP connector.
//
// Reached from the /oauth/authorize interstitial when we don't yet know the
// merchant's shop (no ?shop= hint, no __Host-cala_shop cookie). The merchant
// enters their *.myshopify.com domain once; we remember it (cookie, same host as
// /oauth/authorize) and hand off to the embedded /app/connect consent screen via
// the admin.shopify.com deep link, which carries the signed pending token (?t=)
// through Shopify's own login. NO Shopify OAuth round-trip happens here — we only
// capture the shop and build the deep link. The shop is never put in the token;
// /app/connect still issues the code against its authenticated session shop.
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  AppProvider as PolarisAppProvider,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { getClient, verifyPendingOauth } from "~/lib/mcp_oauth.server";
import { buildAppConnectUrl, SHOP_RE } from "~/lib/connect-deeplink";
import { shopHintCookieHeader } from "~/lib/connect-deeplink.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const token = new URL(request.url).searchParams.get("t") ?? "";
  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return redirect(`${appUrl}/app`);
  }
  const client = await getClient(ctx.client_id);
  if (!client) return redirect(`${appUrl}/app`);
  return json({ token, client_name: client.client_name, polarisTranslations });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";

  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const shop = String(form.get("shop") ?? "").trim().toLowerCase();

  // The token must still be a valid pending-OAuth JWT, else this isn't a real
  // connector flow.
  try {
    await verifyPendingOauth(token);
  } catch {
    return json({ error: "invalid_token" }, { status: 400 });
  }

  if (!SHOP_RE.test(shop)) {
    return json({ error: "invalid_shop", token }, { status: 422 });
  }

  return redirect(buildAppConnectUrl({ shop, apiKey, appUrl, token }), {
    headers: { "Set-Cookie": shopHintCookieHeader(shop) },
  });
};

type LoaderData = {
  token: string;
  client_name: string;
  polarisTranslations: typeof polarisTranslations;
};

export default function OauthLogin() {
  const { token, client_name, polarisTranslations: i18n } = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const [shop, setShop] = useState("");

  const error =
    actionData?.error === "invalid_shop"
      ? "Enter your store as example.myshopify.com"
      : actionData?.error === "invalid_token"
        ? "This connection request expired. Start again from Claude."
        : undefined;

  return (
    <PolarisAppProvider i18n={i18n}>
      <Page narrowWidth>
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text variant="headingLg" as="h1">
                Connect {client_name} to Calderyn
              </Text>
              <Text as="p" tone="subdued">
                Enter your Shopify store to approve this connection in your admin.
              </Text>
            </BlockStack>
            <Form method="post">
              <input type="hidden" name="t" value={token} />
              <FormLayout>
                <TextField
                  type="text"
                  name="shop"
                  label="Store domain"
                  helpText="example.myshopify.com"
                  value={shop}
                  onChange={setShop}
                  autoComplete="on"
                  error={error}
                />
                <Button
                  submit
                  variant="primary"
                  disabled={!SHOP_RE.test(shop.trim().toLowerCase())}
                >
                  Log in with Shopify
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/oauth-login.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/routes/oauth.login.tsx app/routes/__tests__/oauth-login.test.ts
git commit -m "routes/oauth.login: connector cold-path shop-entry page (remember + admin deep link)"
```

---

## Task 3: `/oauth/authorize` — cookie-read loader + button-first interstitial

**Files:**
- Modify: `app/routes/oauth.authorize.tsx` (imports; loader shop resolution; component no-shop branch; delete local `SHOP_RE` + `buildConnectUrl`)
- Modify: `app/routes/__tests__/oauth-authorize.test.ts` (add cookie tests)
- Create: `app/routes/__tests__/oauth-authorize-ui.test.ts` (render smoke)

- [ ] **Step 1: Write the failing loader tests**

In `app/routes/__tests__/oauth-authorize.test.ts`, add this helper after the existing `reqWith` function:

```ts
function reqWithCookie(params: Record<string, string>, cookie: string): { request: Request } {
  const url = new URL("http://x/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { request: new Request(url.toString(), { headers: { Cookie: cookie } }) };
}
```

Then add these tests inside the `describe("/oauth/authorize loader", ...)` block:

```ts
it("uses the __Host-cala_shop cookie as the shop when there is no ?shop= hint", async () => {
  getClientMock.mockResolvedValue(clientFixture());
  const r = await loader(reqWithCookie(VALID_PARAMS, "__Host-cala_shop=cookieshop.myshopify.com") as never);
  expect(r.status).toBe(200);
  // Invariant: authorize never writes consumable pre-seed state.
  expect(r.headers.get("set-cookie")).toBeNull();
  const j = await r.json();
  expect(j.shop).toBe("cookieshop.myshopify.com");
});

it("prefers an explicit ?shop= hint over the remembered cookie", async () => {
  getClientMock.mockResolvedValue(clientFixture());
  const r = await loader(
    reqWithCookie({ ...VALID_PARAMS, shop: "hint.myshopify.com" }, "__Host-cala_shop=cookieshop.myshopify.com") as never,
  );
  const j = await r.json();
  expect(j.shop).toBe("hint.myshopify.com");
});

it("ignores a malformed __Host-cala_shop cookie", async () => {
  getClientMock.mockResolvedValue(clientFixture());
  const r = await loader(reqWithCookie(VALID_PARAMS, "__Host-cala_shop=not-a-shop") as never);
  const j = await r.json();
  expect(j.shop).toBeNull();
});
```

- [ ] **Step 2: Run loader tests to verify they fail**

Run: `npx vitest run app/routes/__tests__/oauth-authorize.test.ts`
Expected: FAIL — the cookie tests get `j.shop === null` (loader does not read the cookie yet). The two prefer/ignore tests may pass incidentally; the "uses the cookie" test MUST fail.

- [ ] **Step 3: Edit the loader + imports in `oauth.authorize.tsx`**

Change the `react` import (drop `useState`):

```tsx
import { useMemo } from "react";
```

Change the Polaris import (drop `FormLayout`, `TextField`):

```tsx
import {
  AppProvider as PolarisAppProvider,
  BlockStack,
  Button,
  Card,
  Page,
  Text,
} from "@shopify/polaris";
```

Add these imports after the existing `import { getClient, signPendingOauth } ...` line:

```tsx
import { buildAppConnectUrl, SHOP_RE } from "~/lib/connect-deeplink";
import { readShopHintCookie } from "~/lib/connect-deeplink.server";
```

Delete the local `const SHOP_RE = /.../;` declaration (now imported) and delete the entire local `function buildConnectUrl(data, shop) { ... }`.

In the loader, replace this block:

```tsx
  const shopHint = url.searchParams.get("shop")?.toLowerCase();
  const validShop = shopHint && SHOP_RE.test(shopHint) ? shopHint : null;
```

with:

```tsx
  const shopHint = url.searchParams.get("shop")?.toLowerCase();
  const hintShop = shopHint && SHOP_RE.test(shopHint) ? shopHint : null;
  // Fall back to the remembered shop (written by /oauth/login on this same
  // origin). READ ONLY: /oauth/authorize must never Set-Cookie — that no-pre-seed
  // rule is the PR #107 invariant.
  const validShop = hintShop ?? readShopHintCookie(request);
```

- [ ] **Step 4: Run loader tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/oauth-authorize.test.ts`
Expected: PASS (all — original 13 + 3 new). The existing "renders the interstitial (200, signed token, no cookie)" still passes (no cookie sent → `j.shop` null, no `Set-Cookie`).

- [ ] **Step 5: Write the failing render-smoke test**

Create `app/routes/__tests__/oauth-authorize-ui.test.ts`:

```ts
// app/routes/__tests__/oauth-authorize-ui.test.ts
//
// The interstitial is button-first: a known shop shows the one-click admin
// deep-link button; an unknown shop shows a "Log in with Shopify" button that
// links to /oauth/login (NOT an inline shop text field).
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const fixture = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => fixture.data }));

// eslint-disable-next-line import/first
import AuthorizeInterstitial from "../oauth.authorize";

const BASE = {
  client_name: "Claude",
  token: "tok123",
  apiKey: "apikey123",
  appUrl: "https://app.calderyncompany.com",
  dashboardUrl: "https://calderyncompany.com",
};

function render(data: Record<string, unknown>): string {
  fixture.data = data;
  return renderToString(createElement(AuthorizeInterstitial));
}

describe("/oauth/authorize interstitial", () => {
  it("no shop: renders a 'Log in with Shopify' link to /oauth/login and NO shop field", () => {
    const html = render({ ...BASE, shop: null });
    expect(html).toContain("Log in with Shopify");
    expect(html).toContain("/oauth/login?t=tok123");
    expect(html).not.toContain("Enter your shop domain");
    expect(html).not.toContain('name="shop"');
  });

  it("known shop: renders the one-click admin button and no login link", () => {
    const html = render({ ...BASE, shop: "myshop.myshopify.com" });
    expect(html).toContain("Open Calderyn in your Shopify admin");
    expect(html).not.toContain("/oauth/login?t=");
  });
});
```

- [ ] **Step 6: Run the render test to verify it fails**

Run: `npx vitest run app/routes/__tests__/oauth-authorize-ui.test.ts`
Expected: FAIL — current no-shop branch renders the `TextField` (`name="shop"`), not the `/oauth/login` link.

- [ ] **Step 7: Edit the interstitial component in `oauth.authorize.tsx`**

Replace the component body (from `export default function AuthorizeInterstitial()` to its closing `}`) with:

```tsx
export default function AuthorizeInterstitial() {
  const data = useLoaderData<typeof loader>() as InterstitialData;

  const knownShop = data.shop;
  const directUrl = useMemo(
    () => buildAppConnectUrl({ shop: knownShop, apiKey: data.apiKey, appUrl: data.appUrl, token: data.token }),
    [data, knownShop],
  );
  const loginUrl = `${data.appUrl}/oauth/login?t=${encodeURIComponent(data.token)}`;
  const dashboardUrl = `${data.dashboardUrl}/dashboard/connect?t=${encodeURIComponent(data.token)}`;

  const go = (target: string) => {
    try {
      if (typeof window !== "undefined" && window.top) {
        window.top.location.href = target;
        return;
      }
    } catch {
      // top-window navigation may be blocked; fall through to same-window.
    }
    window.location.href = target;
  };

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title="Connect Claude.ai">
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              <b>{data.client_name}</b> wants to connect to your Calderyn data. Approve this from
              inside your Shopify admin, where we can confirm it&apos;s really you.
            </Text>
            {knownShop ? (
              <Button variant="primary" onClick={() => go(directUrl)}>
                Open Calderyn in your Shopify admin to approve
              </Button>
            ) : (
              <Button variant="primary" url={loginUrl}>
                Log in with Shopify
              </Button>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Prefer the web dashboard?{" "}
              <Button variant="plain" onClick={() => go(dashboardUrl)}>
                Approve in the Calderyn dashboard
              </Button>
            </Text>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
```

- [ ] **Step 8: Run both authorize test files to verify they pass**

Run: `npx vitest run app/routes/__tests__/oauth-authorize.test.ts app/routes/__tests__/oauth-authorize-ui.test.ts`
Expected: PASS (all).

- [ ] **Step 9: Typecheck the touched route (catch unused imports early)**

Run: `npx tsc --noEmit`
Expected: exit 0 (no "declared but never used" for `useState`/`FormLayout`/`TextField`).

- [ ] **Step 10: Commit**

```bash
git add app/routes/oauth.authorize.tsx app/routes/__tests__/oauth-authorize.test.ts app/routes/__tests__/oauth-authorize-ui.test.ts
git commit -m "routes/oauth.authorize: button-first interstitial + read remembered shop cookie"
```

---

## Task 4: Dashboard mirror — `/dashboard/login` shop-entry form

**Files:**
- Modify: `app/routes/dashboard.login.tsx` (add `loginFormPage`; split the no-shop / errored branch)
- Modify: `app/routes/__tests__/dashboard-login-returnto.test.ts` (add the form test)

- [ ] **Step 1: Write the failing test**

In `app/routes/__tests__/dashboard-login-returnto.test.ts`, add this test inside the
`describe("/dashboard/login carries a validated return_to into the state cookie", ...)` block:

```ts
it("renders a shop-entry form (not a dead end) when there is no shop and no cookie", async () => {
  const r = (await loader(
    req(
      "https://app.calderyncompany.com/dashboard/login?return_to=%2Fdashboard%2Fconnect%3Ft%3Dabc",
    ) as never,
  )) as Response;
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Type")).toContain("text/html");
  const body = await r.text();
  expect(body).toContain("<form");
  expect(body).toContain('name="shop"');
  expect(body).toContain('action="/dashboard/login"');
  // The connector destination survives into the form so it resumes after login.
  expect(body).toContain('name="return_to"');
  expect(body).toContain("/dashboard/connect?t=abc");
  // No longer the old dead-end copy.
  expect(body).not.toContain("Open Calderyn from your Shopify admin");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard-login-returnto.test.ts`
Expected: FAIL — the current `loginInfoPage` has no `<form` / `name="shop"`.

- [ ] **Step 3: Edit `dashboard.login.tsx`**

Add this function immediately after the existing `loginInfoPage` function:

```tsx
// Cold-path shop entry: when we have no shop and no remembered cookie, ask for it
// here (the dashboard's "Log in with Shopify" page) instead of dead-ending. The
// form GETs back into THIS loader's ?shop= branch, which validates the shop, sets
// __Host-dash_shop, and 302s to Shopify authorize carrying return_to. Inline-styled
// to match loginInfoPage (shown pre-auth, outside the dashboard shell).
function loginFormPage(returnTo: string | null): Response {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const hidden = returnTo ? `<input type="hidden" name="return_to" value="${esc(returnTo)}">` : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calderyn — Sign in</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1a1a1a}h1{font-size:1.25rem}label{display:block;font-weight:600;margin:0 0 .5rem}input[name=shop]{width:100%;padding:.6rem .75rem;font-size:1rem;border:1px solid #cbd2e0;border-radius:.5rem;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1rem;font-size:1rem;font-weight:600;color:#fff;background:#5b3df5;border:0;border-radius:.5rem;cursor:pointer}p{color:#4a4a4a}</style></head><body><h1>Calderyn dashboard</h1><p>Enter your Shopify store to sign in and approve the connection.</p><form method="get" action="/dashboard/login"><label for="shop">Store domain</label><input id="shop" name="shop" type="text" required placeholder="example.myshopify.com" pattern="[a-z0-9][a-z0-9-]*\\.myshopify\\.com" autocomplete="on">${hidden}<button type="submit">Log in with Shopify</button></form></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
```

Then, in the loader, replace this block:

```tsx
  if (!shop || errored) {
    return loginInfoPage(shop, errored);
  }
```

with:

```tsx
  if (errored) {
    return loginInfoPage(shop, true);
  }
  if (!shop) {
    return loginFormPage(safeDashboardReturnTo(url.searchParams.get("return_to")));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard-login-returnto.test.ts app/lib/dashboard/__tests__/auth-routes.test.ts`
Expected: PASS — the new form test passes, AND the existing `auth-routes.test.ts` cases still pass (the no-shop "HTML landing not raw JSON" case is satisfied by the form page; the errored case still hits `loginInfoPage`).

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.login.tsx app/routes/__tests__/dashboard-login-returnto.test.ts
git commit -m "routes/dashboard.login: shop-entry form on the cold path (connector parity)"
```

---

## Task 5: Full pre-commit gate + graph update

**Files:** none (verification only). Per CLAUDE.md the gate is mandatory before the feature is done.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: exit 0, all tests pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint (no new warnings on touched files)**

Run: `npm run lint`
Expected: exit 0, zero warnings on the touched files.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0 (Remix + Vite build completes; the new `/oauth/login` route is picked up by fs-routes).

- [ ] **Step 5: Patch sanity**

Run: `git diff --stat main...HEAD && git diff --check main...HEAD`
Expected: only the 10 files from the File Structure table; no whitespace errors, no stray `console.log`/`.only`/`TODO(me)`.

- [ ] **Step 6: `/code-review`**

Run the `/code-review` slash command on the branch diff. Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 7: Update the knowledge graph**

Run: `graphify update .`
Expected: AST graph refreshed (no API cost).

---

## Self-Review

**1. Spec coverage:**
- Remembered-shop button (warm path) → Task 3 loader reads `__Host-cala_shop`; interstitial known-shop button (unchanged) ✓
- "Log in with Shopify" button replaces the field → Task 3 component ✓
- New `/oauth/login` cold-path page writes cookie + admin deep link → Task 2 ✓
- `__Host-cala_shop` cookie helpers → Task 1 ✓
- `buildAppConnectUrl` shared (lifted from `oauth.authorize`) → Task 1 + Task 3 deletes the local copy ✓
- No `Set-Cookie` on authorize (invariant) → Task 3 Step 1 regression assertion + read-only loader ✓
- Dashboard mirror (cold-path form, reuses `?shop=` loader) → Task 4 ✓
- `/auth/login` untouched ✓ (no task touches it)

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**3. Type consistency:** `buildAppConnectUrl({ shop, apiKey, appUrl, token })` — same signature in Task 1 definition, Task 2 action, Task 3 `directUrl`. `readShopHintCookie(request)`/`shopHintCookieHeader(shop)` — consistent across Tasks 1/2/3. `SHOP_RE` imported (not redefined) in Tasks 2/3. `InterstitialData` keeps `{ client_name, token, apiKey, appUrl, dashboardUrl, shop }` (unchanged) — render fixture matches. ✓

**Edge note (no code change):** `/oauth/login` GET with an invalid/expired token redirects to `${appUrl}/app`; an unauthenticated hit there triggers managed auth — acceptable for a tampered/expired token (rare). Documented in spec non-goals.
