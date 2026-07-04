# Signup Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a new first-party (email/Google) signup, route the user through a one-screen onboarding that collects a required phone number and "how did you hear about us", plus an optional "Connect Shopify" that hands off to the existing #13 import/cutover machine.

**Architecture:** A new specific route `dashboard.onboarding.tsx` (ranks above the `dashboard.$` SPA splat). Signup/Google-store actions redirect there instead of straight to the dashboard. A gate in `session.server.ts` (`needsOnboarding`) redirects any un-onboarded first-party session to onboarding, checked *before* the email-verify gate. Shopify (shop-based, `userId == null`) sessions are exempt by construction. The optional connect saves the required fields, then `redirect("/dashboard/login")` — the existing Shopify OAuth that already runs `startImport` + `kickDrainSoon`. No new port or account-linking code.

**Tech Stack:** Remix (Vite) route modules, raw Postgres/Supabase via `getSupabase()`, vitest (route-module + server-unit tests with mocked `~/lib/supabase.server`), the `AuthShell`/`cd-auth-*` design system.

**Spec:** `docs/superpowers/specs/2026-07-04-signup-onboarding-design.md`

---

## File Structure

**New**
- `supabase/migrations/20260704010000_users_onboarding_profile.sql` — 4 columns + CHECK + backfill.
- `app/lib/auth/onboarding.server.ts` — `normalizePhone`, `REFERRAL_SOURCES`/`isReferralSource`, `setOnboardingProfile`.
- `app/lib/auth/__tests__/onboarding.server.test.ts` — unit tests for the above.
- `app/routes/dashboard.onboarding.tsx` — loader + action + UI.
- `app/routes/__tests__/dashboard.onboarding.test.ts` — route tests.
- `app/lib/dashboard/__tests__/session-onboarding-gate.test.ts` — gate precedence tests.

**Changed**
- `app/lib/dashboard/session.server.ts` — `onboardedAt` on the session, `needsOnboarding`, gate in `requireVerifiedSession` + `requireDashboardSession`.
- `app/lib/auth/messages.ts` — onboarding error copy.
- `app/routes/dashboard.signup.tsx` — success redirect → `/dashboard/onboarding`.
- `app/routes/__tests__/dashboard.signup.test.ts` — update the 3 success-redirect assertions.
- `app/routes/dashboard.auth.google_.store.tsx` — success redirect → `/dashboard/onboarding`.
- `app/routes/__tests__/dashboard.auth.google.test.ts` — update the store-creation success-redirect assertion.

---

## Task 1: Migration — users onboarding columns + backfill

**Files:**
- Create: `supabase/migrations/20260704010000_users_onboarding_profile.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Post-signup onboarding profile on the first-party users table (email/Google signups).
-- Collected on the /dashboard/onboarding screen right after signup: contact phone,
-- how-the-merchant-heard-about-us (a fixed vocabulary + free-text 'other'), and the
-- onboarded_at stamp the dashboard's onboarding gate reads (NULL => not yet onboarded).
-- Shopify-connect (shop-based) sessions have no users row and are exempt by construction.
--
-- referral_source is a closed vocabulary enforced with a CHECK (repo convention: no native
-- enum type); referral_source_other holds the free text only when the source is 'other'.
-- All columns are nullable so the row is created at signup and filled at onboarding.
alter table public.users
  add column if not exists phone text,
  add column if not exists referral_source text,
  add column if not exists referral_source_other text,
  add column if not exists onboarded_at timestamptz;

alter table public.users drop constraint if exists users_referral_source_check;
alter table public.users add constraint users_referral_source_check
  check (referral_source is null or referral_source in (
    'google_search','shopify_app_store','twitter_x','linkedin','youtube',
    'tiktok_instagram','friend_colleague','other'
  ));

-- Backfill: existing users predate onboarding — mark them onboarded so the gate never
-- retro-forces them through it on next login. New rows keep onboarded_at NULL.
update public.users set onboarded_at = now() where onboarded_at is null;
```

- [ ] **Step 2: Validate the SQL**

Run: `grep -c "add column if not exists" supabase/migrations/20260704010000_users_onboarding_profile.sql`
Expected: `4` (idempotent adds present).

The migration is applied through the team's Supabase migration flow at deploy time; the unit/route tests below mock `getSupabase()` and do not require the live column. Do NOT auto-apply to the shared project from this plan.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260704010000_users_onboarding_profile.sql
git commit -m "migrations: users onboarding profile (phone, referral, onboarded_at) + backfill"
```

---

## Task 2: `onboarding.server.ts` — phone + referral helpers

**Files:**
- Create: `app/lib/auth/onboarding.server.ts`
- Test: `app/lib/auth/__tests__/onboarding.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { normalizePhone, isReferralSource, REFERRAL_SOURCES } from "../onboarding.server";

describe("normalizePhone", () => {
  it("normalizes an international number, preserving the leading +", () => {
    expect(normalizePhone("+1 415 555 0123")).toBe("+14155550123");
  });
  it("strips punctuation when no + is given", () => {
    expect(normalizePhone("(415) 555-0123")).toBe("4155550123");
  });
  it("rejects a too-short number", () => {
    expect(normalizePhone("12345")).toBeNull();
  });
  it("rejects a too-long number (>15 digits)", () => {
    expect(normalizePhone("1234567890123456")).toBeNull();
  });
  it("rejects blank input", () => {
    expect(normalizePhone("   ")).toBeNull();
  });
});

describe("isReferralSource", () => {
  it("accepts every known key", () => {
    for (const k of REFERRAL_SOURCES) expect(isReferralSource(k)).toBe(true);
  });
  it("rejects an unknown key", () => {
    expect(isReferralSource("myspace")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isReferralSource(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/onboarding.server.test.ts`
Expected: FAIL — `Cannot find module '../onboarding.server'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/auth/onboarding.server.ts
import { getSupabase } from "../supabase.server";

export const REFERRAL_SOURCES = [
  "google_search",
  "shopify_app_store",
  "twitter_x",
  "linkedin",
  "youtube",
  "tiktok_instagram",
  "friend_colleague",
  "other",
] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

export function isReferralSource(x: unknown): x is ReferralSource {
  return typeof x === "string" && (REFERRAL_SOURCES as readonly string[]).includes(x);
}

/**
 * Light E.164 normalization: keep a single leading `+` when present and the digits,
 * require 7–15 digits (the E.164 range), and return `+<digits>` (or `<digits>` when no
 * `+` was given). Returns null when the input can't be a phone number. Deliberately not
 * a full libphonenumber validation — v1 only guards obviously-bad input.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/onboarding.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/onboarding.server.ts app/lib/auth/__tests__/onboarding.server.test.ts
git commit -m "lib/auth/onboarding: phone normalize + referral-source vocabulary"
```

---

## Task 3: `onboarding.server.ts` — `setOnboardingProfile`

**Files:**
- Modify: `app/lib/auth/onboarding.server.ts`
- Modify: `app/lib/auth/__tests__/onboarding.server.test.ts`

- [ ] **Step 1: Add the failing test** (append to the test file)

```ts
import { vi, beforeEach } from "vitest";
import { setOnboardingProfile } from "../onboarding.server";

const update = vi.fn();
const eq = vi.fn();
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ update }) }),
}));

describe("setOnboardingProfile", () => {
  beforeEach(() => {
    eq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq });
  });

  it("writes the four columns incl. onboarded_at, scoped by user id", async () => {
    await setOnboardingProfile("u1", {
      phone: "+14155550123",
      referralSource: "google_search",
      referralOther: null,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+14155550123",
        referral_source: "google_search",
        referral_source_other: null,
        onboarded_at: expect.any(String),
      }),
    );
    expect(eq).toHaveBeenCalledWith("id", "u1");
  });

  it("persists free text only when the source is 'other'", async () => {
    await setOnboardingProfile("u1", {
      phone: "4155550123",
      referralSource: "other",
      referralOther: "a friend at a meetup",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ referral_source: "other", referral_source_other: "a friend at a meetup" }),
    );
  });

  it("throws when the update errors", async () => {
    eq.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(
      setOnboardingProfile("u1", { phone: "4155550123", referralSource: "youtube", referralOther: null }),
    ).rejects.toBeTruthy();
  });
});
```

Note: the `vi.mock("~/lib/supabase.server", ...)` is hoisted, so the Task-2 pure-function tests keep passing (they don't touch Supabase).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/auth/__tests__/onboarding.server.test.ts`
Expected: FAIL — `setOnboardingProfile is not a function`.

- [ ] **Step 3: Add the implementation** (append to `onboarding.server.ts`)

```ts
export interface OnboardingProfile {
  phone: string;
  referralSource: ReferralSource;
  referralOther: string | null;
}

/** Persist the onboarding profile and mark the user onboarded, in one update. */
export async function setOnboardingProfile(
  userId: string,
  profile: OnboardingProfile,
): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({
      phone: profile.phone,
      referral_source: profile.referralSource,
      referral_source_other: profile.referralSource === "other" ? profile.referralOther : null,
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/auth/__tests__/onboarding.server.test.ts`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/auth/onboarding.server.ts app/lib/auth/__tests__/onboarding.server.test.ts
git commit -m "lib/auth/onboarding: setOnboardingProfile persists profile + onboarded_at"
```

---

## Task 4: Session gate — `onboardedAt` + `needsOnboarding` + precedence

**Files:**
- Modify: `app/lib/dashboard/session.server.ts`
- Test: `app/lib/dashboard/__tests__/session-onboarding-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update: () => ({ eq: updateEq }) }),
  }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn() }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

function req() {
  return new Request("https://app.x/dashboard", {
    headers: { Cookie: "__Host-calderyn_dash=dash_live_abc" },
  });
}
function row(over: Record<string, unknown>) {
  return {
    data: {
      id: "s1",
      shop_id: "shop1",
      shop_domain: null,
      user_id: "u1",
      expires_at: new Date(Date.now() + 1e6).toISOString(),
      revoked_at: null,
      user: { email_verified: false, onboarded_at: null },
      ...over,
    },
    error: null,
  };
}
beforeEach(() => maybeSingle.mockReset());

describe("onboarding gate", () => {
  it("requireVerifiedSession redirects an un-onboarded first-party session to /dashboard/onboarding (before verify)", async () => {
    maybeSingle.mockResolvedValue(row({})); // user_id set, onboarded_at null, unverified
    const { requireVerifiedSession } = await import("../session.server");
    const err = await requireVerifiedSession(req()).catch((e) => e as Response);
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toBe("/dashboard/onboarding");
  });

  it("requireVerifiedSession sends an onboarded-but-unverified user to verify-needed", async () => {
    maybeSingle.mockResolvedValue(
      row({ user: { email_verified: false, onboarded_at: "2026-07-04T00:00:00Z" } }),
    );
    const { requireVerifiedSession } = await import("../session.server");
    const err = await requireVerifiedSession(req()).catch((e) => e as Response);
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toBe("/dashboard/verify-needed");
  });

  it("requireVerifiedSession lets a Shopify (user_id null) session through", async () => {
    maybeSingle.mockResolvedValue(row({ user_id: null, shop_domain: "a.myshopify.com", user: null }));
    const { requireVerifiedSession } = await import("../session.server");
    const s = await requireVerifiedSession(req());
    expect(s.onboardedAt).toBeNull();
    expect(s.emailVerified).toBe(true);
  });

  it("requireDashboardSession throws 403 onboarding_required for an un-onboarded first-party session", async () => {
    maybeSingle.mockResolvedValue(row({}));
    const { requireDashboardSession } = await import("../session.server");
    const err = await requireDashboardSession(req()).catch((e) => e as Response);
    expect(err.status).toBe(403);
    expect(await err.json()).toMatchObject({ error: "onboarding_required" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/session-onboarding-gate.test.ts`
Expected: FAIL — the redirect goes to verify-needed (no onboarding gate yet) and `onboardedAt` is undefined.

- [ ] **Step 3: Implement — extend the session read**

In `app/lib/dashboard/session.server.ts`, add `onboardedAt` to the `DashboardSession` type:

```ts
export type DashboardSession = {
  shopId: string;
  shopDomain: string | null;
  userId: string | null;
  sessionId: string;
  emailVerified: boolean;
  onboardedAt: string | null;
};
```

Widen the select in `getSessionFromRequest` to read `onboarded_at`:

```ts
    .select("id, shop_id, shop_domain, user_id, expires_at, revoked_at, user:users(email_verified, onboarded_at)")
```

Add `onboardedAt` to the returned object (right after `emailVerified`):

```ts
    onboardedAt:
      data.user_id == null
        ? null
        : ((data.user as { onboarded_at?: string | null } | null)?.onboarded_at ?? null),
```

- [ ] **Step 4: Implement — the gate predicate + guards**

Add the predicate next to `unverifiedFirstParty`:

```ts
function needsOnboarding(s: DashboardSession): boolean {
  return s.userId != null && s.onboardedAt == null;
}
```

In `requireVerifiedSession`, insert the onboarding check **before** the verify check:

```ts
export async function requireVerifiedSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  if (!session) throw redirect("/login");
  if (needsOnboarding(session)) throw redirect("/dashboard/onboarding");
  if (unverifiedFirstParty(session)) throw redirect("/dashboard/verify-needed");
  return session;
}
```

In `requireDashboardSession`, insert the 403 **before** the email-unverified 403:

```ts
export async function requireDashboardSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getDashboardSessionAllowUnverified(request);
  if (needsOnboarding(session)) {
    throw new Response(JSON.stringify({ error: "onboarding_required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  if (unverifiedFirstParty(session)) {
    throw new Response(JSON.stringify({ error: "email_unverified" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return session;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/lib/dashboard/__tests__/session-onboarding-gate.test.ts app/lib/dashboard/__tests__/session-verify-gate.test.ts`
Expected: PASS. (The verify-gate suite's session rows omit `onboarded_at`; `data.user.onboarded_at` reads `undefined` → `?? null` → an un-onboarded first-party session. Its assertions are on `requireDashboardSession` 403 status and the Shopify-session path — both still hold, since the un-onboarded 403 and the unverified 403 share the same 403 status.)

- [ ] **Step 6: Commit**

```bash
git add app/lib/dashboard/session.server.ts app/lib/dashboard/__tests__/session-onboarding-gate.test.ts
git commit -m "dashboard/session: onboarding gate before verify (needsOnboarding + onboardedAt)"
```

---

## Task 5: Onboarding error copy

**Files:**
- Modify: `app/lib/auth/messages.ts`

- [ ] **Step 1: Add the codes** (inside `AUTH_ERROR_MESSAGES`, after `invalid_shop`)

```ts
  invalid_phone: "Enter a valid phone number so we can reach you.",
  invalid_referral: "Pick how you heard about us.",
  save_failed: "We couldn't save that just now. Try again.",
  not_first_party: "That action isn't available on this account.",
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/auth/messages.ts
git commit -m "lib/auth/messages: onboarding error copy"
```

---

## Task 6: `dashboard.onboarding.tsx` — loader + action + UI

**Files:**
- Create: `app/routes/dashboard.onboarding.tsx`
- Test: `app/routes/__tests__/dashboard.onboarding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  checkSameOrigin: vi.fn(() => null),
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const getSessionFromRequest = vi.fn();
const getDashboardSessionAllowUnverified = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionFromRequest,
  getDashboardSessionAllowUnverified,
}));
const setOnboardingProfile = vi.fn();
vi.mock("~/lib/auth/onboarding.server", () => ({
  setOnboardingProfile,
  normalizePhone: (r: string) => (/\d{7,}/.test(r.replace(/\D/g, "")) ? r.replace(/\D/g, "") : null),
  isReferralSource: (x: unknown) => x === "google_search" || x === "other",
  REFERRAL_SOURCES: ["google_search", "other"],
}));

function firstParty(over: Record<string, unknown> = {}) {
  return { shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1", emailVerified: false, onboardedAt: null, ...over };
}
function form(fields: Record<string, string>, json = true) {
  return new Request("https://app.x/dashboard/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(json ? { Accept: "application/json" } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}
beforeEach(() => {
  getSessionFromRequest.mockReset();
  getDashboardSessionAllowUnverified.mockReset();
  setOnboardingProfile.mockReset().mockResolvedValue(undefined);
});

describe("onboarding loader", () => {
  it("redirects a signed-out visitor to /login", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });
  it("redirects an already-onboarded verified user to /dashboard", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ onboardedAt: "2026-07-04T00:00:00Z", emailVerified: true }));
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("redirects a Shopify (userId null) session away", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ userId: null, emailVerified: true }));
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("renders (returns data) for an un-onboarded first-party user", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({ request: new Request("https://app.x/dashboard/onboarding?error=invalid_phone") } as never);
    expect(data).toMatchObject({ error: "invalid_phone" });
  });
});

describe("onboarding action", () => {
  it("422s an invalid phone", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "123", referral_source: "google_search" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_phone" });
  });
  it("422s an invalid referral", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "myspace" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_referral" });
  });
  it("finish: saves and redirects an unverified user to verify-needed", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed");
    expect(setOnboardingProfile).toHaveBeenCalledWith("u1", expect.objectContaining({ phone: "4155550123", referralSource: "google_search" }));
  });
  it("finish: redirects a verified (Google) user to /dashboard", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty({ emailVerified: true }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("connect: saves then hands off to the existing Shopify OAuth", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "connect", phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
    expect(setOnboardingProfile).toHaveBeenCalled();
  });
  it("rejects a shop-based (userId null) session with 400 not_first_party", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue(firstParty({ userId: null }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }) } as never)) as Response;
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.onboarding.test.ts`
Expected: FAIL — `Cannot find module '../dashboard.onboarding'`.

- [ ] **Step 3: Write the route**

```tsx
// app/routes/dashboard.onboarding.tsx
// Post-signup onboarding for first-party (email/Google) users: a required phone
// number + "how did you hear about us", plus an optional hand-off to the existing
// Shopify OAuth + #13 import/cutover flow. Runs right after signup, before the
// email-verify gate; the onboarding gate in session.server redirects here.
import type { ActionFunctionArgs, LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData } from "@remix-run/react";
import dashboard from "~/styles/dashboard.css?url";
import {
  getSessionFromRequest,
  getDashboardSessionAllowUnverified,
} from "~/lib/dashboard/session.server";
import { rateLimit, clientIpKey, checkSameOrigin, jsonError, wantsJson } from "~/lib/dashboard/http.server";
import { normalizePhone, isReferralSource, setOnboardingProfile } from "~/lib/auth/onboarding.server";
import { AuthShell, AuthError, AuthForm, AuthSubmit } from "~/components/auth/AuthCard";

export const meta: MetaFunction = () => [{ title: "Almost there — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

// Where a first-party user goes once onboarding is done: unverified email users
// still owe the verify gate; verified (Google) users land on the dashboard.
function nextAfterOnboarding(emailVerified: boolean): string {
  return emailVerified ? "/dashboard" : "/dashboard/verify-needed";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/login");
  // Shopify (shop-based) sessions and already-onboarded users don't belong here.
  if (session.userId == null || session.onboardedAt != null) {
    return redirect(nextAfterOnboarding(session.emailVerified));
  }
  return { error: new URL(request.url).searchParams.get("error") };
}

export async function action({ request }: ActionFunctionArgs) {
  const badOrigin = checkSameOrigin(request);
  if (badOrigin) return badOrigin;
  const session = await getDashboardSessionAllowUnverified(request);

  const fail = (status: number, code: string) =>
    wantsJson(request) ? jsonError(status, code) : redirect(`/dashboard/onboarding?error=${code}`);

  // Only first-party users onboard; a shop-based session has no users row to write.
  if (session.userId == null) return fail(400, "not_first_party");
  if (!(await rateLimit(clientIpKey(request, "dash-onboarding"), 10, 60_000))) return fail(429, "rate_limited");

  const fd = await request.formData().catch(() => new FormData());
  const intent = String(fd.get("intent") ?? "finish");
  const phone = normalizePhone(String(fd.get("phone") ?? ""));
  const referral = String(fd.get("referral_source") ?? "");
  const referralOther = String(fd.get("referral_source_other") ?? "").trim() || null;

  if (!phone) return fail(422, "invalid_phone");
  if (!isReferralSource(referral)) return fail(422, "invalid_referral");

  try {
    await setOnboardingProfile(session.userId, {
      phone,
      referralSource: referral,
      referralOther: referral === "other" ? referralOther : null,
    });
  } catch (err) {
    console.error("[onboarding] save failed", err);
    return fail(500, "save_failed");
  }

  // Optional Shopify port: hand off to the existing OAuth → callback → #13 import
  // machine (it runs startImport + kickDrainSoon and steers to the store/import
  // screen). Required fields are already saved above.
  if (intent === "connect") return redirect("/dashboard/login");
  return redirect(nextAfterOnboarding(session.emailVerified));
}

export default function Onboarding() {
  const { error } = useLoaderData<typeof loader>();
  const [referral, setReferral] = useState("");
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Almost there</h1>
      <p className="cd-auth-sub">Two quick things, then your dashboard.</p>
      <AuthError code={error} />
      <AuthForm action="/dashboard/onboarding">
        <label className="cd-auth-label" htmlFor="phone">Phone</label>
        <input
          className="cd-auth-input"
          id="phone"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          placeholder="+1 415 555 0123"
          autoFocus
        />
        <label className="cd-auth-label" htmlFor="referral_source">How'd you hear about us?</label>
        <select
          className="cd-auth-input"
          id="referral_source"
          name="referral_source"
          required
          value={referral}
          onChange={(e) => setReferral(e.target.value)}
        >
          <option value="" disabled>Select one</option>
          <option value="google_search">Google / search</option>
          <option value="shopify_app_store">Shopify App Store</option>
          <option value="twitter_x">X (Twitter)</option>
          <option value="linkedin">LinkedIn</option>
          <option value="youtube">YouTube</option>
          <option value="tiktok_instagram">TikTok / Instagram</option>
          <option value="friend_colleague">Friend or colleague</option>
          <option value="other">Other</option>
        </select>
        {referral === "other" && (
          <input
            className="cd-auth-input"
            name="referral_source_other"
            type="text"
            maxLength={120}
            placeholder="Tell us more"
            aria-label="How you heard about us"
          />
        )}
        <AuthSubmit label="Continue" pendingLabel="Saving…" />
        <button className="cd-auth-linkbtn" type="submit" name="intent" value="connect" style={{ marginTop: 12 }}>
          Connect Shopify — bring your data over
        </button>
      </AuthForm>
    </AuthShell>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.onboarding.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.onboarding.tsx app/routes/__tests__/dashboard.onboarding.test.ts
git commit -m "routes/dashboard.onboarding: phone + how-heard + optional Shopify port hand-off"
```

---

## Task 7: Signup redirects to onboarding

**Files:**
- Modify: `app/routes/dashboard.signup.tsx:82-87`
- Modify: `app/routes/__tests__/dashboard.signup.test.ts`

- [ ] **Step 1: Update the existing test assertions (red)**

In `app/routes/__tests__/dashboard.signup.test.ts`:
- Line ~97: change `expect(res.headers.get("Location")).toBe("/dashboard/verify-needed");` to `toBe("/dashboard/onboarding");` and update the test title `"...redirects to the verification gate"` → `"...redirects to onboarding"`.
- The two `send_failed` tests (~109, ~120): change both expected Locations from `"/dashboard/verify-needed?error=send_failed"` and `"/dashboard/verify-needed?error=send_failed"` to `"/dashboard/onboarding"`. (Onboarding precedes the verify gate; a failed verification-email send is recovered by the resend button on verify-needed, which the user reaches after onboarding — so signup no longer forwards `send_failed`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.signup.test.ts`
Expected: FAIL on the three updated assertions (impl still returns `/dashboard/verify-needed`).

- [ ] **Step 3: Change the signup redirect** (`app/routes/dashboard.signup.tsx`)

Replace the destination block (currently lines ~81-87):

```ts
    // A brand-new email account is unverified, but onboarding (phone + how-heard,
    // optional Shopify port) comes first — right after signup, before the verify
    // gate. The verification email still goes out best-effort here; the user
    // reaches the resend button on /dashboard/verify-needed after onboarding.
    return redirect("/dashboard/onboarding", {
      headers: { "Set-Cookie": sessionCookieHeader(raw) },
    });
```

Remove the now-unused `dest`/`delivery.sent` branching for the redirect target. Keep the `sendVerificationEmail(...)` call (still fires best-effort); the `delivery` result is no longer needed for steering, so drop the `const delivery = ...` assignment and call it for effect:

```ts
    // Best-effort: a delivery failure must not fail the signup. The user will see
    // the resend control on /dashboard/verify-needed after finishing onboarding.
    await sendVerificationEmail(userId, normalizeEmail(email), baseUrl).catch(() => {});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.signup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.signup.tsx app/routes/__tests__/dashboard.signup.test.ts
git commit -m "routes/dashboard.signup: land new signups on onboarding before verify"
```

---

## Task 8: Google-store redirects to onboarding

**Files:**
- Modify: `app/routes/dashboard.auth.google_.store.tsx:56`
- Modify: `app/routes/__tests__/dashboard.auth.google.test.ts`

- [ ] **Step 1: Find and update the store-creation success assertion (red)**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.google.test.ts`
Note which `it(...)` covers the *store-creation* success (a `google_.store` action POST that creates user+shop and asserts `Location === "/dashboard"` — around line 299, the test that mocks `createGoogleUser`/`provisionOwnedShop` success). Change that single assertion to `toBe("/dashboard/onboarding")`. Do **not** touch the callback sign-in assertions (lines ~206, ~244) — those are existing-user Google callbacks, not new signups, and keep going to `/dashboard`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.google.test.ts`
Expected: FAIL on the store-creation success assertion only.

- [ ] **Step 3: Change the Google-store redirect** (`app/routes/dashboard.auth.google_.store.tsx:56`)

```ts
    // New Google users go through onboarding (phone + how-heard, optional Shopify
    // port) before the dashboard — same gate as email signups. Google emails are
    // pre-verified, so onboarding-finish lands them straight on /dashboard.
    return redirect("/dashboard/onboarding", { headers: { "Set-Cookie": sessionCookieHeader(raw) } });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.auth.google.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.auth.google_.store.tsx app/routes/__tests__/dashboard.auth.google.test.ts
git commit -m "routes/dashboard.auth.google_.store: land new Google signups on onboarding"
```

---

## Task 9: Full pre-commit gate

**Files:** none (verification only)

- [ ] **Step 1: Run `/code-review`** on the working tree/branch. Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 2: Patch sanity**

Run: `git diff --check` and `git diff --stat`
Expected: clean; no stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, or browser-visible provenance in the diff.

- [ ] **Step 3: Eval pipeline (paste each result — rule 12)**

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0
npx vitest run      # full suite green
```

Prisma steps are N/A (no `prisma/schema.prisma` change; the migration is a raw Supabase SQL file). No `graphql-codegen` (no `.graphql` changes).

- [ ] **Step 4: Push the branch and open a PR** (only when all gates are green and the user asks).

---

## Self-Review

**Spec coverage:**
- Phone (required) + how-heard (required, fixed set + free-text other) → Task 2 (helpers), Task 6 (route + UI). ✅
- Migration + backfill → Task 1. ✅
- Placement "right after signup, before verify" → Task 7 (email), Task 8 (Google). ✅
- Gate (needsOnboarding, before verify; Shopify exempt) → Task 4. ✅
- Optional Shopify connect = hand off to existing #13 machine (no invented port/linking) → Task 6 action `connect` → `/dashboard/login`. ✅
- Error visibility → Task 5 messages. ✅
- TDD unit + route tests → Tasks 2–8. ✅

**Placeholder scan:** none — every code step contains full code; the two test-update tasks (7, 8) reference exact files and assertions with the run-to-confirm-red step. ✅

**Type consistency:** `DashboardSession.onboardedAt: string | null` (Task 4) is read by the onboarding loader (Task 6). `setOnboardingProfile(userId, OnboardingProfile)` (Task 3) is called with `{ phone, referralSource, referralOther }` in Task 6. `REFERRAL_SOURCES`/`isReferralSource`/`normalizePhone` (Task 2) are imported by Task 6. Error codes `invalid_phone`/`invalid_referral`/`save_failed`/`not_first_party` (Task 6) all defined in Task 5. ✅

**One planning-time check to perform during Task 4:** confirmed the single HTML choke point is `dashboard.$.tsx`'s loader calling `requireVerifiedSession`, and all `dashboard.api.*` use `requireDashboardSession` — so gating both functions covers the whole surface. If a new dashboard HTML route is added that bypasses `requireVerifiedSession`, it must also call it.
