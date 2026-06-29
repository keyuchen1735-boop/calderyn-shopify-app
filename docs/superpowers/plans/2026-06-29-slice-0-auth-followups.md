# Slice 0 Auth Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google sign-in, an email-verification hard gate, and an owned-store brand subtitle on top of Slice 0 first-party auth.

**Architecture:** One coordinated `users` migration. Brand subtitle is a loader + prop change. Email verification reuses the `password_reset_token` table (new `purpose='verify'`) and adds a single session-level gate. Google sign-in is a dedicated OAuth client validated via Google's `tokeninfo` endpoint (no new dependency), with a signed stateless token carrying the verified identity across a "name your store" step for brand-new users.

**Tech Stack:** Remix (Vite) routes, `@supabase/supabase-js` (service-role), `node:crypto` HMAC/scrypt, Resend (`sendEmail`), vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-slice-0-auth-followups-design.md`.

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative. No `any` without written justification.
- `.server.ts` files are server-only. Secrets from `process.env` server-side only; update `.env.example` when adding a key.
- Schema changes go in a migration written byte-identical to BOTH `supabase/migrations/` AND `tests/engine/schema/migrations/`. Idempotent statements only. Docker is NOT available locally; verify migrations statically (no DB apply) and re-confirm idempotency by inspection.
- Dual-run: existing Shopify-keyed rows/sessions keep working. Shopify-path sessions have `user_id = null` and are NEVER email-gated.
- `shops.id` UUID contract unchanged; do NOT alter any `*_fact`/`*_dim`/`v_*` object.
- Browser-visible source stays product-neutral: no AI/provenance/dev-tool markers in served HTML or comments.
- **No em dashes or en dashes** anywhere in source (use plain hyphens/commas/periods).
- Stable front-door error codes (do NOT rename): `invalid_credentials, invalid_email, weak_password, email_taken, missing_store, no_shop, rate_limited`.
- Per-task gate before commit: `npm run typecheck` (0) -> `npx eslint <touched files>` (0 errors/0 warnings) -> relevant `npx vitest run`. Full gate (`npm run lint` 0 errors, `npm run build` 0, `npx vitest run` green) at the final task.
- Tests that call `hashPassword`/`hashSessionToken` must set `process.env.PASSWORD_PEPPER`/`process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32)` AFTER the imports (placing statements before imports trips the `import/first` lint error).

---

### Task 1: Coordinated `users` migration

**Files:**
- Create: `supabase/migrations/20260629140000_auth_followups.sql`
- Create: `tests/engine/schema/migrations/20260629140000_auth_followups.sql` (byte-identical)

**Interfaces:**
- Produces: `users.password_hash` nullable; `users.google_sub text` (unique where not null); `users.email_verified boolean not null default false`; `password_reset_token.purpose` accepts `'verify'`.

- [ ] **Step 1: Write the migration SQL** (same content to both paths)

```sql
-- Slice 0 auth follow-ups: Google identity (password optional), email
-- verification flag, and a 'verify' purpose for the reset-token table.
-- Idempotent + dual-run safe (existing email+password users keep a password_hash
-- and email_verified defaults false; the verify gate only applies to first-party
-- sessions). The dashboard_sessions / shops contracts are untouched.

-- Google-only users have no password.
alter table public.users alter column password_hash drop not null;

-- Google account identifier (the OIDC 'sub'); unique among non-null values.
alter table public.users add column if not exists google_sub text;
create unique index if not exists users_google_sub_key
  on public.users(google_sub) where google_sub is not null;

-- Email verification flag (default false; flipped by the verify route).
alter table public.users add column if not exists email_verified boolean not null default false;

-- Every user must have at least one credential (a password or a Google identity).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_has_credential'
  ) then
    alter table public.users
      add constraint users_has_credential
      check (password_hash is not null or google_sub is not null) not valid;
    alter table public.users validate constraint users_has_credential;
  end if;
end $$;

-- Allow the verification token purpose alongside reset / set_password.
do $$
begin
  alter table public.password_reset_token drop constraint if exists password_reset_token_purpose_check;
  alter table public.password_reset_token
    add constraint password_reset_token_purpose_check
    check (purpose in ('reset','set_password','verify'));
end $$;
```

- [ ] **Step 2: Static verification** (Docker unavailable)

Run:
```bash
diff supabase/migrations/20260629140000_auth_followups.sql tests/engine/schema/migrations/20260629140000_auth_followups.sql && echo IDENTICAL
ls supabase/migrations/ | tail -3
```
Expected: `IDENTICAL`; the new file sorts last. Confirm by inspection that every statement is idempotent (`if not exists`, `drop ... if exists` then re-add, `drop not null`, and the `pg_constraint` guard) so a re-run is a no-op.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629140000_auth_followups.sql tests/engine/schema/migrations/20260629140000_auth_followups.sql
git commit -m "feat(auth): migration for google identity, email_verified, verify token purpose"
```

---

### Task 2: Owned-store brand subtitle

**Files:**
- Modify: `app/routes/dashboard._index.tsx`
- Modify: `app/components/dashboard/DashboardApp.tsx`
- Modify: `app/components/dashboard/context.ts`
- Test: `app/routes/__tests__/dashboard-index-loader.test.ts`

**Interfaces:**
- Consumes: `getSessionOrRedirect` (existing), `getSupabase`.
- Produces: the loader returns `{ shopDomain: string | null; storeLabel: string }`; `DashboardApp` prop + `DashboardCtx` gain `storeLabel: string`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";

const maybeSingle = vi.fn();
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionOrRedirect: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1", emailVerified: true }),
}));

describe("dashboard index loader", () => {
  it("uses display_name as the store label for an owned shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "Acme Goods", shop_domain: null }, error: null });
    const { loader } = await import("../dashboard._index");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ storeLabel: "Acme Goods", shopDomain: null });
  });

  it("falls back to shop_domain for a Shopify shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: null, shop_domain: "acme.myshopify.com" }, error: null });
    const { loader } = await import("../dashboard._index");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ storeLabel: "acme.myshopify.com" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard-index-loader.test.ts`
Expected: FAIL (loader still returns only `{ shopDomain }`).

- [ ] **Step 3: Update the loader** (`dashboard._index.tsx`)

Replace the loader body so it reads the shop label and returns both fields:

```tsx
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionOrRedirect(request);
  const { data } = await getSupabase()
    .from("shops")
    .select("display_name, shop_domain")
    .eq("id", session.shopId)
    .maybeSingle();
  const storeLabel =
    (data?.display_name as string | null) ||
    (data?.shop_domain as string | null) ||
    "Your store";
  return { shopDomain: session.shopDomain, storeLabel };
}
```
Add the imports `import { getSupabase } from "~/lib/supabase.server";` and ensure `LoaderFunctionArgs` is imported from `@remix-run/node`. In the component, change `const { shopDomain } = useLoaderData<typeof loader>();` to also pull `storeLabel`, and pass both to `<DashboardApp shopDomain={shopDomain} storeLabel={storeLabel} />`.

- [ ] **Step 4: Update `DashboardApp` + context**

In `app/components/dashboard/context.ts`, add `storeLabel: string;` to the `DashboardCtx` type (keep `shopDomain: string | null` — change it from `string` to `string | null` if it is not already nullable).
In `app/components/dashboard/DashboardApp.tsx`: change the prop to `{ shopDomain, storeLabel }: { shopDomain: string | null; storeLabel: string }`; put `storeLabel` into the `DashboardCtx` object (`app` at ~line 731); render `{storeLabel}` in `cd-brand-sub` (was `{shopDomain}`). Leave `shopDomain` flowing in the context for `Alerts.tsx` deep links.

- [ ] **Step 5: Typecheck the ripple + run the test**

Run: `npm run typecheck` then `npx vitest run app/routes/__tests__/dashboard-index-loader.test.ts`
Expected: typecheck exit 0 (fix any `DashboardCtx.shopDomain` consumer that assumed non-null); test PASS. Existing DashboardApp test mocks that pass `shopDomain` will need a `storeLabel` added; update them minimally.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard._index.tsx app/components/dashboard/DashboardApp.tsx app/components/dashboard/context.ts app/routes/__tests__/dashboard-index-loader.test.ts
git commit -m "feat(dashboard): show owned-store display_name in the brand subtitle"
```

---

### Task 3: Email-verification token lib

**Files:**
- Create: `app/lib/auth/verify.server.ts`
- Test: `app/lib/auth/__tests__/verify.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; `newSessionToken`/`hashSessionToken` (`~/lib/dashboard/session.server`); `sendEmail` (`~/lib/email/send.server`).
- Produces:
  - `createVerifyToken(userId: string): Promise<{ raw: string }>` (purpose `'verify'`, 24h TTL)
  - `consumeVerifyToken(raw: string): Promise<{ userId: string } | null>` (single-use, TTL + used checked, marks `used_at`, checks `purpose='verify'`)
  - `markEmailVerified(userId: string): Promise<void>`
  - `sendVerificationEmail(userId: string, email: string, baseUrl: string): Promise<void>` (mints a token + emails the link)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const single = vi.fn();
const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn(() => ({ eq: updateEq }));
const insert = vi.fn(() => ({ select: () => ({ single }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert, select: () => ({ eq: () => ({ maybeSingle }) }), update }) }),
}));
const sendEmail = vi.fn().mockResolvedValue({ sent: true, id: "e1" });
vi.mock("~/lib/email/send.server", () => ({ sendEmail }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

beforeEach(() => { single.mockReset(); maybeSingle.mockReset(); insert.mockClear(); sendEmail.mockClear(); updateEq.mockClear(); });

describe("email verification tokens", () => {
  it("sendVerificationEmail mints a token and emails a /dashboard/verify link", async () => {
    process.env.RESEND_API_KEY = "re_x"; process.env.PILOT_FROM = "Calderyn <x@y.co>";
    single.mockResolvedValue({ data: { id: "tok1" }, error: null });
    const { sendVerificationEmail } = await import("../verify.server");
    await sendVerificationEmail("u1", "a@b.co", "https://app.x");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).toContain("https://app.x/dashboard/verify?t=");
  });

  it("consumeVerifyToken returns null for an expired token", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "t", user_id: "u1", purpose: "verify", expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }, error: null });
    const { consumeVerifyToken } = await import("../verify.server");
    expect(await consumeVerifyToken("dash_live_x")).toBeNull();
  });

  it("consumeVerifyToken returns null for a used token and does not re-mark it", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "t", user_id: "u1", purpose: "verify", expires_at: new Date(Date.now() + 10000).toISOString(), used_at: new Date().toISOString() }, error: null });
    const { consumeVerifyToken } = await import("../verify.server");
    expect(await consumeVerifyToken("dash_live_x")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/verify.server.test.ts`
Expected: FAIL (cannot find module `../verify.server`).

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/verify.server.ts
import { getSupabase } from "../supabase.server";
import { newSessionToken, hashSessionToken } from "../dashboard/session.server";
import { sendEmail } from "../email/send.server";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function createVerifyToken(userId: string): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("password_reset_token")
    .insert({
      user_id: userId,
      token_hash: hashSessionToken(raw),
      purpose: "verify",
      expires_at: new Date(Date.now() + VERIFY_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export async function consumeVerifyToken(raw: string): Promise<{ userId: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("password_reset_token")
    .select("id, user_id, purpose, expires_at, used_at")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.purpose !== "verify" || data.used_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  const { error: ue } = await sb
    .from("password_reset_token")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id);
  if (ue) throw ue;
  return { userId: String(data.user_id) };
}

export async function markEmailVerified(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({ email_verified: true, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

export async function sendVerificationEmail(userId: string, email: string, baseUrl: string): Promise<void> {
  const { raw } = await createVerifyToken(userId);
  const link = `${baseUrl}/dashboard/verify?t=${encodeURIComponent(raw)}`;
  await sendEmail({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.PILOT_FROM ?? "Calderyn <onboarding@calderyncompany.com>",
    to: email,
    subject: "Verify your Calderyn email",
    text: `Confirm your email to unlock your dashboard (link valid for 24 hours):\n\n${link}\n\nIf you didn't create a Calderyn account, ignore this email.`,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/verify.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/verify.server.ts app/lib/auth/__tests__/verify.server.test.ts
git commit -m "feat(auth): email-verification token lib (single-use, 24h, reuses reset-token table)"
```

---

### Task 4: Session `emailVerified` + verification gates

**Files:**
- Modify: `app/lib/dashboard/session.server.ts`
- Test: `app/lib/dashboard/__tests__/session-verify-gate.test.ts`

**Interfaces:**
- Produces:
  - `DashboardSession` gains `emailVerified: boolean` (true whenever `userId` is null).
  - `requireDashboardSession` now throws `403 email_unverified` for an unverified first-party session (the API choke point). Behavior unchanged for Shopify sessions and verified users.
  - `getDashboardSessionAllowUnverified(request): Promise<DashboardSession>` — like `requireDashboardSession` but WITHOUT the verify check (401 only). For the verify-flow routes.
  - `requireVerifiedSession(request): Promise<DashboardSession>` — page variant: redirects to `/dashboard/login` if no session, `/dashboard/verify-needed` if unverified first-party.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update: () => ({ eq: updateEq }) }) }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn() }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

function reqWithCookie() {
  return new Request("https://app.x/dashboard/api/me", { headers: { Cookie: "__Host-calderyn_dash=dash_live_abc" } });
}
beforeEach(() => { maybeSingle.mockReset(); });

describe("verify gate", () => {
  it("requireDashboardSession throws 403 email_unverified for an unverified first-party session", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: null, user_id: "u1", expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: { email_verified: false } }, error: null });
    const { requireDashboardSession } = await import("../session.server");
    await expect(requireDashboardSession(reqWithCookie())).rejects.toMatchObject({ status: 403 });
  });

  it("requireDashboardSession allows a Shopify session (user_id null => emailVerified true)", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: "a.myshopify.com", user_id: null, expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: null }, error: null });
    const { requireDashboardSession } = await import("../session.server");
    const s = await requireDashboardSession(reqWithCookie());
    expect(s.emailVerified).toBe(true);
  });

  it("getDashboardSessionAllowUnverified returns the unverified session without throwing", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: null, user_id: "u1", expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: { email_verified: false } }, error: null });
    const { getDashboardSessionAllowUnverified } = await import("../session.server");
    const s = await getDashboardSessionAllowUnverified(reqWithCookie());
    expect(s.emailVerified).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/session-verify-gate.test.ts`
Expected: FAIL (`emailVerified` undefined / new functions missing).

- [ ] **Step 3: Implement**

In `getSessionFromRequest`, embed the user's verified flag and return it:
- Change the select to: `.select("id, shop_id, shop_domain, user_id, expires_at, revoked_at, user:users(email_verified)")`
- In the returned object add: `emailVerified: data.user_id == null ? true : Boolean((data.user as { email_verified?: boolean } | null)?.email_verified),`

Extend the type:
```typescript
export type DashboardSession = {
  shopId: string;
  shopDomain: string | null;
  userId: string | null;
  sessionId: string;
  emailVerified: boolean;
};
```

Add a shared helper used by both `requireDashboardSession` (403) and the new functions:
```typescript
function unverifiedFirstParty(s: DashboardSession): boolean {
  return s.userId != null && !s.emailVerified;
}

export async function getDashboardSessionAllowUnverified(
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

export async function requireVerifiedSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  if (!session) throw redirect("/dashboard/login");
  if (unverifiedFirstParty(session)) throw redirect("/dashboard/verify-needed");
  return session;
}
```

Change `requireDashboardSession` to enforce verification (keep the 401 path):
```typescript
export async function requireDashboardSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getDashboardSessionAllowUnverified(request);
  if (unverifiedFirstParty(session)) {
    throw new Response(JSON.stringify({ error: "email_unverified" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return session;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run app/lib/dashboard/__tests__/session-verify-gate.test.ts` then `npm run typecheck`
Expected: PASS; typecheck 0. Any existing code constructing a `DashboardSession` literal (tests, mocks) now needs `emailVerified` — add `emailVerified: true` to those Shopify-context mocks. Record the touched files in the commit body.

- [ ] **Step 5: Run the existing dashboard route + session suites to catch the enforcement ripple**

Run: `npx vitest run app/routes/__tests__app/lib/dashboard/__tests__`  (use the actual two paths: `app/routes/__tests__` and `app/lib/dashboard/__tests__`)
Expected: green. If a `dashboard.api.*` route test now 403s because its mocked session is first-party with `emailVerified` unset/false, fix the test's mock to a verified or Shopify session as appropriate (the production code is correct: unverified first-party SHOULD be 403). Do not weaken the gate to pass a test.

- [ ] **Step 6: Commit**

```bash
git add app/lib/dashboard/session.server.ts app/lib/dashboard/__tests__/session-verify-gate.test.ts
git commit -m "feat(auth): session emailVerified + verify gate (403 api, redirect pages, Shopify bypass)"
```

---

### Task 5: Wire verification into signup + verify routes + page gate

**Files:**
- Modify: `app/routes/dashboard.signup.tsx`
- Create: `app/routes/dashboard.verify.tsx`
- Create: `app/routes/dashboard.verify-needed.tsx`
- Modify: `app/routes/dashboard._index.tsx` (use `requireVerifiedSession`)
- Test: `app/routes/__tests__/dashboard.verify.test.ts`

**Interfaces:**
- Consumes: `sendVerificationEmail`, `consumeVerifyToken`, `markEmailVerified` (Task 3); `requireVerifiedSession`, `getDashboardSessionAllowUnverified`, `clearSessionCookieHeader` (existing); `rateLimit`, `clientIpKey`, `requireSameOrigin`, `jsonError` (existing).

- [ ] **Step 1: Write the failing test** (the consume route)

```typescript
import { describe, it, expect, vi } from "vitest";

const consumeVerifyToken = vi.fn();
const markEmailVerified = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/auth/verify.server", () => ({ consumeVerifyToken, markEmailVerified }));

function get(t: string) { return new Request(`https://app.x/dashboard/verify?t=${t}`); }

describe("verify consume route", () => {
  it("redirects to /dashboard on a valid token and marks verified", async () => {
    consumeVerifyToken.mockResolvedValue({ userId: "u1" });
    const { loader } = await import("../dashboard.verify");
    const res = (await loader({ request: get("good") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(markEmailVerified).toHaveBeenCalledWith("u1");
  });

  it("renders an error (no redirect) for an invalid token", async () => {
    consumeVerifyToken.mockResolvedValue(null);
    const { loader } = await import("../dashboard.verify");
    const res = await loader({ request: get("bad") } as never);
    expect((res as { ok?: boolean }) && (res as Response).status).not.toBe(302);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.verify.test.ts`
Expected: FAIL (cannot find module `../dashboard.verify`).

- [ ] **Step 3: Write `dashboard.verify.tsx`** (consume the `?t=` token, mark verified, redirect)

```tsx
import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { consumeVerifyToken, markEmailVerified } from "~/lib/auth/verify.server";

export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  const consumed = await consumeVerifyToken(t);
  if (!consumed) return { ok: false };
  await markEmailVerified(consumed.userId);
  return redirect("/dashboard", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function VerifyRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Link expired</h1>
      <p>That verification link is invalid or has expired. <a href="/dashboard/verify-needed">Request a new one</a>.</p>
    </main>
  );
}
```

- [ ] **Step 4: Write `dashboard.verify-needed.tsx`** (the hard-gate screen + resend action)

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getDashboardSessionAllowUnverified, clearSessionCookieHeader } from "~/lib/dashboard/session.server";
import { rateLimit, clientIpKey, requireSameOrigin, jsonError } from "~/lib/dashboard/http.server";
import { sendVerificationEmail } from "~/lib/auth/verify.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getDashboardSessionAllowUnverified(request);
  if (session.emailVerified || session.userId == null) {
    // Already verified (or a Shopify session): nothing to do here.
    return { email: null as string | null };
  }
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  return { email: (data?.email as string | null) ?? null };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await getDashboardSessionAllowUnverified(request);
  if (session.userId == null) return jsonError(400, "not_first_party");
  if (!(await rateLimit(`verify-resend:${session.userId}`, 3, 15 * 60_000))) return jsonError(429, "rate_limited");
  const { data } = await getSupabase().from("users").select("email").eq("id", session.userId).maybeSingle();
  const email = data?.email as string | null;
  const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  if (email) await sendVerificationEmail(session.userId, email, baseUrl);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default function VerifyNeeded() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "28rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Verify your email</h1>
      <p>We sent a verification link{email ? ` to ${email}` : ""}. Click it to unlock your dashboard.</p>
      <form method="post" action="/dashboard/verify-needed">
        <button type="submit" style={{ padding: ".6rem 1rem", fontWeight: 600 }}>Resend the email</button>
      </form>
      <p style={{ marginTop: "1rem" }}><a href="/dashboard/signout">Sign out</a></p>
    </main>
  );
}
```
Note: if a `/dashboard/signout` route does not exist, link to the existing sign-out path (grep for the current logout route; reuse it). Do NOT invent a new sign-out flow.

- [ ] **Step 5: Send the verification email on signup**

In `app/routes/dashboard.signup.tsx`, after `createSessionForUser` succeeds and before the redirect, fire the verification email (best-effort: a send failure must not block signup, the user can resend from the gate):
```typescript
const baseUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
await sendVerificationEmail(userId, normalizeEmail(email), baseUrl).catch(() => {});
```
Import `sendVerificationEmail` from `~/lib/auth/verify.server`. Keep the existing `redirect("/dashboard", ...)` relative redirect; the new session is unverified, so `requireVerifiedSession` on the dashboard home will bounce the user to `/dashboard/verify-needed`.

- [ ] **Step 6: Gate the dashboard home**

In `app/routes/dashboard._index.tsx`, change `getSessionOrRedirect(request)` to `requireVerifiedSession(request)` (import it). Everything else in the loader (Task 2) stays. This makes an unverified first-party user land on the gate screen; verified users and Shopify users load the dashboard.

- [ ] **Step 7: Run the verify test + typecheck**

Run: `npx vitest run app/routes/__tests__/dashboard.verify.test.ts` then `npm run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 8: Commit**

```bash
git add app/routes/dashboard.signup.tsx app/routes/dashboard.verify.tsx app/routes/dashboard.verify-needed.tsx app/routes/dashboard._index.tsx app/routes/__tests__/dashboard.verify.test.ts
git commit -m "feat(auth): email verification gate (signup sends link, verify + verify-needed routes, home gated)"
```

---

### Task 6: Signed stateless Google-signup token

**Files:**
- Create: `app/lib/auth/google-signup-token.server.ts`
- Test: `app/lib/auth/__tests__/google-signup-token.server.test.ts`

**Interfaces:**
- Produces:
  - `signGoogleSignup(payload: { sub: string; email: string }): string` — `base64url(JSON{sub,email,exp})` + `.` + HMAC-SHA256 signature (15 min `exp`)
  - `verifyGoogleSignup(token: string): { sub: string; email: string } | null` — constant-time signature check + expiry check; null on tamper/expiry/malformed

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { signGoogleSignup, verifyGoogleSignup } from "../google-signup-token.server";

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

describe("google signup token", () => {
  it("round-trips a valid token", () => {
    const t = signGoogleSignup({ sub: "g123", email: "a@b.co" });
    expect(verifyGoogleSignup(t)).toEqual({ sub: "g123", email: "a@b.co" });
  });
  it("rejects a tampered token", () => {
    const t = signGoogleSignup({ sub: "g123", email: "a@b.co" });
    const tampered = t.slice(0, -3) + (t.slice(-3) === "aaa" ? "bbb" : "aaa");
    expect(verifyGoogleSignup(tampered)).toBeNull();
  });
  it("returns null for malformed input", () => {
    expect(verifyGoogleSignup("")).toBeNull();
    expect(verifyGoogleSignup("not.a.token")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/google-signup-token.server.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/google-signup-token.server.ts
//
// A short-lived signed token carrying a Google-verified identity across the
// "name your store" step for brand-new users. Stateless on purpose: no users
// row exists yet, so a password_reset_token row (which FKs to users) cannot be
// used. The HMAC signature + a 15 minute expiry make it unforgeable and bounded.

import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const s = process.env.DASHBOARD_SESSION_PEPPER;
  if (!s || s.length < 32) throw new Error("DASHBOARD_SESSION_PEPPER must be set to a 32+ char secret");
  return s;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

export function signGoogleSignup(payload: { sub: string; email: string }): string {
  const body = { sub: payload.sub, email: payload.email, exp: Date.now() + TTL_MS };
  const b64 = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function verifyGoogleSignup(token: string): { sub: string; email: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  try {
    const expected = Buffer.from(sign(b64));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const body = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { sub?: string; email?: string; exp?: number };
    if (!body.sub || !body.email || typeof body.exp !== "number") return null;
    if (body.exp <= Date.now()) return null;
    return { sub: body.sub, email: body.email };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/google-signup-token.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/google-signup-token.server.ts app/lib/auth/__tests__/google-signup-token.server.test.ts
git commit -m "feat(auth): signed stateless token for the google signup interstitial"
```

---

### Task 7: Google sign-in OAuth lib

**Files:**
- Create: `app/lib/auth/google-signin.server.ts`
- Test: `app/lib/auth/__tests__/google-signin.server.test.ts`

**Interfaces:**
- Produces:
  - `buildSigninAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string` — scope `openid email profile`, `response_type=code`
  - type `IdTokenFetcher = (url, init) => Promise<{ id_token?: string; access_token?: string; error?: string; error_description?: string }>`
  - `exchangeCodeForIdToken(fetcher, opts: { clientId; clientSecret; redirectUri; code }): Promise<string>` — returns the raw `id_token`
  - type `TokenInfoFetcher = (url: string) => Promise<{ aud?: string; iss?: string; sub?: string; email?: string; email_verified?: string | boolean; exp?: string | number }>`
  - `verifyIdToken(fetcher, idToken: string, clientId: string): Promise<{ sub: string; email: string; emailVerified: boolean }>` — validates via Google `tokeninfo` (`aud === clientId`, Google `iss`, not expired); throws on any failure

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildSigninAuthUrl, exchangeCodeForIdToken, verifyIdToken } from "../google-signin.server";

describe("google sign-in oauth", () => {
  it("builds an auth url with the openid email profile scope", () => {
    const url = buildSigninAuthUrl({ clientId: "cid", redirectUri: "https://app.x/cb", state: "st" });
    expect(url).toContain("scope=openid+email+profile");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=st");
  });

  it("exchangeCodeForIdToken returns the id_token", async () => {
    const fetcher = async () => ({ id_token: "ID", access_token: "AC" });
    expect(await exchangeCodeForIdToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" })).toBe("ID");
  });

  it("verifyIdToken accepts a valid token and rejects a wrong aud / unverified email", async () => {
    const good = async () => ({ aud: "cid", iss: "https://accounts.google.com", sub: "g1", email: "a@b.co", email_verified: "true", exp: String(Math.floor(Date.now()/1000)+600) });
    expect(await verifyIdToken(good, "tok", "cid")).toEqual({ sub: "g1", email: "a@b.co", emailVerified: true });
    const wrongAud = async () => ({ aud: "other", iss: "https://accounts.google.com", sub: "g1", email: "a@b.co", email_verified: "true", exp: String(Math.floor(Date.now()/1000)+600) });
    await expect(verifyIdToken(wrongAud, "tok", "cid")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/google-signin.server.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/auth/google-signin.server.ts
//
// Google sign-in (OpenID Connect). Dedicated client, scope openid+email+profile,
// no offline/refresh (sign-in needs no refresh token). The id_token is validated
// server-side via Google's tokeninfo endpoint so no JWT-verification dependency
// is required. Pure helpers with injected fetchers for testability.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
const SCOPE = "openid email profile";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function buildSigninAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type IdTokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ id_token?: string; access_token?: string; error?: string; error_description?: string }>;

export async function exchangeCodeForIdToken(
  fetcher: IdTokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    grant_type: "authorization_code",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.id_token) {
    throw new Error(`Google sign-in token exchange failed: ${res.error_description ?? res.error ?? "no id_token"}`);
  }
  return res.id_token;
}

export type TokenInfoFetcher = (url: string) => Promise<{
  aud?: string; iss?: string; sub?: string; email?: string; email_verified?: string | boolean; exp?: string | number;
}>;

export async function verifyIdToken(
  fetcher: TokenInfoFetcher,
  idToken: string,
  clientId: string,
): Promise<{ sub: string; email: string; emailVerified: boolean }> {
  const info = await fetcher(`${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`);
  if (info.aud !== clientId) throw new Error("google id_token aud mismatch");
  if (!info.iss || !GOOGLE_ISSUERS.includes(info.iss)) throw new Error("google id_token iss invalid");
  const exp = Number(info.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error("google id_token expired");
  if (!info.sub || !info.email) throw new Error("google id_token missing sub/email");
  const emailVerified = info.email_verified === true || info.email_verified === "true";
  return { sub: String(info.sub), email: String(info.email), emailVerified };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/google-signin.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/google-signin.server.ts app/lib/auth/__tests__/google-signin.server.test.ts
git commit -m "feat(auth): google sign-in oauth helpers (tokeninfo validation, no new dep)"
```

---

### Task 8: Google identity functions in the users data layer

**Files:**
- Modify: `app/lib/auth/users.server.ts`
- Test: `app/lib/auth/__tests__/users-google.server.test.ts`

**Interfaces:**
- Produces:
  - `findUserByGoogleSub(sub: string): Promise<{ id: string; shopId: string | null } | null>` — joins membership to surface the user's shop (v1: at most one)
  - `setGoogleSub(userId: string, sub: string): Promise<void>` — links a Google identity onto an existing user
  - `createGoogleUser(email: string, sub: string): Promise<{ id: string }>` — inserts a user with `google_sub`, `email_verified=true`, no password

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const single = vi.fn();
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const updateEq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn(() => ({ eq: updateEq }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), insert, update }) }),
}));
process.env.PASSWORD_PEPPER = "x".repeat(32);

beforeEach(() => { maybeSingle.mockReset(); single.mockReset(); insert.mockClear(); update.mockClear(); updateEq.mockClear(); });

describe("google identity", () => {
  it("createGoogleUser inserts google_sub + email_verified true and returns id", async () => {
    single.mockResolvedValue({ data: { id: "u9" }, error: null });
    const { createGoogleUser } = await import("../users.server");
    expect(await createGoogleUser("A@B.co", "g9")).toEqual({ id: "u9" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co", google_sub: "g9", email_verified: true }));
  });
  it("findUserByGoogleSub returns null when absent", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { findUserByGoogleSub } = await import("../users.server");
    expect(await findUserByGoogleSub("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/users-google.server.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Add the implementation** (append to `users.server.ts`; do not change existing functions)

```typescript
export async function findUserByGoogleSub(
  sub: string,
): Promise<{ id: string; shopId: string | null } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, membership(shop_id)")
    .eq("google_sub", sub)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const m = (data.membership as { shop_id?: string }[] | { shop_id?: string } | null);
  const shopId = Array.isArray(m) ? (m[0]?.shop_id ?? null) : (m?.shop_id ?? null);
  return { id: String(data.id), shopId: shopId == null ? null : String(shopId) };
}

export async function setGoogleSub(userId: string, sub: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({ google_sub: sub, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

export async function createGoogleUser(email: string, sub: string): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from("users")
    .insert({ email: normalizeEmail(email), google_sub: sub, email_verified: true })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/users-google.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/users.server.ts app/lib/auth/__tests__/users-google.server.test.ts
git commit -m "feat(auth): google identity functions in the users data layer"
```

---

### Task 9: Google sign-in routes (start, callback, name-your-store) + env

**Files:**
- Create: `app/routes/dashboard.auth.google.tsx` (start)
- Create: `app/routes/dashboard.auth.google.callback.tsx` (dispatcher)
- Create: `app/routes/dashboard.auth.google.store.tsx` (name-your-store)
- Modify: `.env.example`
- Test: `app/routes/__tests__/dashboard.auth.google.test.ts`

**Interfaces:**
- Consumes: Tasks 6-8 plus `findUserByEmail`, `setGoogleSub`, `provisionOwnedShop`, `linkMembership`, `createSessionForUser`, `resolveShopForUser`, `sessionCookieHeader`, `createOAuthState`/`consumeOAuthState`, `rateLimit`/`clientIpKey`/`requireSameOrigin`/`jsonError`.

**Important integration note:** the OAuth `state` CSRF helpers `createOAuthState`/`consumeOAuthState` live in `app/lib/meta/oauth-state.server.ts`. Read `app/routes/auth.google.$.tsx` (the existing Google Ads connect) FIRST and mirror its EXACT usage of those helpers and of the redirect-URI construction; do not guess their signatures. The redirect URI for sign-in is `${DASHBOARD_PUBLIC_URL}/dashboard/auth/google/callback`.

- [ ] **Step 1: Write the failing test** (the new-user branch of the callback's pure decision is covered via the store route; here test the store submit creates everything)

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true), clientIpKey: () => "k", requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const verifyGoogleSignup = vi.fn();
vi.mock("~/lib/auth/google-signup-token.server", () => ({ verifyGoogleSignup }));
const createGoogleUser = vi.fn().mockResolvedValue({ id: "u1" });
vi.mock("~/lib/auth/users.server", () => ({ createGoogleUser }));
vi.mock("~/lib/auth/tenant.server", () => ({ provisionOwnedShop: vi.fn().mockResolvedValue({ shopId: "shop1", orgSlug: "x" }), linkMembership: vi.fn().mockResolvedValue(undefined) }));
vi.mock("~/lib/dashboard/session.server", () => ({ createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }), sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/" }));

function form(fields: Record<string, string>) {
  return new Request("https://app.x/dashboard/auth/google/store", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
}

describe("google store submit", () => {
  it("422 missing_store when store empty", async () => {
    verifyGoogleSignup.mockReturnValue({ sub: "g1", email: "a@b.co" });
    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: form({ t: "tok", store: "" }) } as never)) as Response;
    expect(res.status).toBe(422);
  });
  it("400 when the signup token is invalid", async () => {
    verifyGoogleSignup.mockReturnValue(null);
    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: form({ t: "bad", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(400);
  });
  it("creates user+shop+session and redirects on success", async () => {
    verifyGoogleSignup.mockReturnValue({ sub: "g1", email: "a@b.co" });
    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: form({ t: "tok", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.google.test.ts`
Expected: FAIL (cannot find module `../dashboard.auth.google.store`).

- [ ] **Step 3: Write the start route** (`dashboard.auth.google.tsx`)

GET: build the redirect URI from `DASHBOARD_PUBLIC_URL`, mint state via `createOAuthState` (mirror `auth.google.$.tsx`), redirect to `buildSigninAuthUrl({ clientId: process.env.GOOGLE_SIGNIN_CLIENT_ID, redirectUri, state })`. Per-IP rate-limit with `clientIpKey(request, "google-signin")`. If `GOOGLE_SIGNIN_CLIENT_ID` is unset, redirect to `/dashboard/signin?error=google_unavailable` (graceful when the operator has not configured the client yet).

- [ ] **Step 4: Write the callback dispatcher** (`dashboard.auth.google.callback.tsx`)

GET: read `code` + `state`; `consumeOAuthState` (reject on mismatch). Exchange + verify the id_token (use a real `fetch`-backed `IdTokenFetcher`/`TokenInfoFetcher`; the lib is injected-fetcher so the route supplies `globalThis.fetch` wrappers). If `emailVerified` is false -> redirect `/dashboard/signin?error=google_unverified_email`. Then:
- `findUserByGoogleSub(sub)` -> if found and has a shop: `createSessionForUser(user.id, user.shopId)` -> redirect `/dashboard` with the cookie.
- else `findUserByEmail(email)` -> if found: `setGoogleSub(user.id, sub)`, `resolveShopForUser(user.id)`, `createSessionForUser` -> redirect `/dashboard`.
- else new user: `redirect("/dashboard/auth/google/store?t=" + encodeURIComponent(signGoogleSignup({ sub, email })))`.
Wrap external calls so an OAuth failure redirects to `/dashboard/signin?error=google_oauth_failed` rather than 500ing. Never log the id_token.

- [ ] **Step 5: Write the name-your-store route** (`dashboard.auth.google.store.tsx`)

GET: render a single "name your store" field with a hidden `t` (the signup token from the query). POST (`action`): `requireSameOrigin`; per-IP rate-limit; `verifyGoogleSignup(t)` -> null => `jsonError(400, "invalid_or_expired")`; `store` empty => `jsonError(422, "missing_store")`; else create atomically with compensating cleanup (mirror `dashboard.signup.tsx`): `createGoogleUser(email, sub)` -> then in a try/catch `provisionOwnedShop(store)` + `linkMembership(userId, shopId, "owner")` + `createSessionForUser(userId, shopId)`; on failure best-effort `deleteUser(userId)` then rethrow; on success `redirect("/dashboard", { headers: { "Set-Cookie": sessionCookieHeader(raw) } })`. (Import `deleteUser` from `~/lib/auth/users.server`.)

- [ ] **Step 6: Add env keys**

In `.env.example`, near the other Google keys, add (with neutral comments, no dashes):
```
# Google sign-in OAuth client (merchant login). Separate from GOOGLE_ADS_* (the ads connect).
# Redirect URI to register: https://calderyncompany.com/dashboard/auth/google/callback
GOOGLE_SIGNIN_CLIENT_ID=replace-with-google-signin-client-id
GOOGLE_SIGNIN_CLIENT_SECRET=replace-with-google-signin-client-secret
```

- [ ] **Step 7: Run the test + typecheck**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.google.test.ts` then `npm run typecheck`
Expected: PASS (3 tests); typecheck 0.

- [ ] **Step 8: Commit**

```bash
git add app/routes/dashboard.auth.google.tsx app/routes/dashboard.auth.google.callback.tsx app/routes/dashboard.auth.google.store.tsx .env.example app/routes/__tests__/dashboard.auth.google.test.ts
git commit -m "feat(auth): google sign-in routes (start, callback dispatcher, name-your-store)"
```

---

### Task 10: Full gate, dual-run audit, em-dash + provenance sweep

**Files:** none new — verification + any fixes surfaced.

- [ ] **Step 1: Dual-run audit**

Confirm Shopify path untouched: `git diff --stat feat/de-shopify-auth -- app/routes/dashboard.login.tsx app/routes/dashboard.auth.callback.tsx` is empty; `createSession`/`revokeAllSessionsForShop`/`getSessionOrRedirect` still present in `session.server.ts`. Grep every new `.shopDomain`/`emailVerified` reader and confirm Shopify sessions (`userId` null, `emailVerified` true) are never gated.

- [ ] **Step 2: Em-dash + provenance sweep of ADDED files**

`for f in $(git diff --name-only --diff-filter=A feat/de-shopify-auth); do grep -Hn $'—\|–' "$f"; done` -> none. Confirm no AI/provenance/dev-tool markers in any new browser-served route.

- [ ] **Step 3: Full pre-commit gate**

Run, in order, capture output:
```bash
npm run typecheck   # exit 0
npm run lint        # 0 errors (pre-existing import() warnings in untouched files are acceptable)
npm run build       # exit 0, client-bundle verifier passes
npx vitest run      # all green, pristine
```
If anything fails, STOP and fix the root cause (never `--no-verify`, never disable a rule, never narrow a type to silence tsc).

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore(auth): dual-run audit + gate green for auth follow-ups"
```

---

## Self-Review

**Spec coverage:**
- Google sign-in (route, dedicated client, tokeninfo validation, state CSRF, account model: known-sub / email-link / new-with-store-step) -> Tasks 6, 7, 8, 9. Migration support (google_sub, password_hash nullable) -> Task 1.
- Email verification (email_verified column, verify token purpose, signup sends link, verify + verify-needed routes, hard gate at session level, api 403, Shopify bypass) -> Tasks 1, 3, 4, 5.
- Brand subtitle (display_name in cd-brand-sub, keep shopDomain for deep links) -> Task 2.
- New env documented, full gate -> Tasks 9, 10.

**Placeholder scan:** none — every step has concrete SQL/code/commands. The one external-pattern reference (Task 9 createOAuthState usage) points the implementer at the canonical existing file rather than guessing a signature; this is intentional and called out.

**Type consistency:** `DashboardSession` gains `emailVerified: boolean` (Task 4) and is used consistently by the gates and routes. `findUserByGoogleSub -> {id, shopId|null}`, `createGoogleUser -> {id}`, `verifyIdToken -> {sub,email,emailVerified}`, `signGoogleSignup/verifyGoogleSignup` payload `{sub,email}` are consistent across Tasks 6-9. `consumeVerifyToken -> {userId}|null` and `markEmailVerified(userId)` consistent across Tasks 3 and 5.

**Dual-run:** every gate keys on `userId != null`; Shopify sessions (`userId` null) get `emailVerified = true` and are never gated. The Shopify login routes are untouched (Task 10 verifies).
