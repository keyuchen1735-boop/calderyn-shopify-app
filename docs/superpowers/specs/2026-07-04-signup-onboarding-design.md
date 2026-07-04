# Design — Post-signup onboarding (phone + how-heard + optional Shopify port)

**Date:** 2026-07-04
**Owner:** Eric
**Branch / worktree:** `feat/signup-onboarding` (`../calderyn-signup-onboarding`)
**Surface:** dashboard only (`app/routes/dashboard.*`). The embedded Shopify app
has no first-party signup, so **dashboard parity is N/A** — this *is* the
dashboard surface.

---

## 1. Goal

After a **new** first-party user signs up (email/password **or** Google), route
them through a one-screen onboarding that collects:

1. **Phone number** — required.
2. **How did you hear about us?** — required, single-select from a fixed set.
3. **Connect Shopify to bring your data over** — optional; reuses the existing
   Shopify-OAuth port and links the real store to the just-created account.

Shopify-connect (Door A) users are **out of scope**: they arrive via Shopify,
already have their data ported, and have no first-party `users` row.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Signup paths in scope | Email/password + Google only |
| Placement | **Right after signup**, before the email-verify gate |
| Phone | **Required** (light validation) |
| How-heard options | Fixed set (below) + free text on "Other" |
| Shopify connect linking | **Repoint membership** (correct) — no OAuth-callback changes |

## 3. Flow

```
Email/pw signup ─┐
Google signup  ──┼─▶ /dashboard/onboarding ──finish──▶ [unverified? verify-needed : /dashboard]
                 │                          └─connect─▶ save → Shopify OAuth → /dashboard/onboarding/connected → /dashboard
gate (any first-party session, onboarded_at IS NULL) ─▶ /dashboard/onboarding
```

- `dashboard.signup` action: on success, redirect **`/dashboard/onboarding`**
  (was `/dashboard/verify-needed`).
- `dashboard.auth.google_.store` action: on success, redirect
  **`/dashboard/onboarding`** (was `/dashboard`).
- The **gate** (see §5) catches anyone who abandons the screen and comes back.

## 4. Data model — one migration

New columns on `users` (raw Postgres / Supabase; follow existing migration
conventions in `supabase/migrations/`):

| Column | Type | Notes |
|---|---|---|
| `phone` | `text` | E.164-normalized, nullable until onboarded |
| `referral_source` | `text` | `CHECK (referral_source IN (...))`, nullable |
| `referral_source_other` | `text` | free text; only set when `referral_source = 'other'` |
| `onboarded_at` | `timestamptz` | NULL = not yet onboarded |

Allowed `referral_source` keys:
`google_search`, `shopify_app_store`, `twitter_x`, `linkedin`, `youtube`,
`tiktok_instagram`, `friend_colleague`, `other`.

**Backfill (same migration):** `UPDATE users SET onboarded_at = now() WHERE
onboarded_at IS NULL;` so existing users are never force-onboarded on next login.
New rows start with `onboarded_at = NULL`.

## 5. Session gate — `app/lib/dashboard/session.server.ts`

- Extend the session select (already joins `user:users(email_verified)`) to also
  read `onboarded_at`; add `onboardedAt: string | null` to `DashboardSession`.
  (`emailVerified` stays; Shopify sessions have `userId == null`.)
- Add `needsOnboarding(s) = s.userId != null && s.onboardedAt == null`.
  Shopify sessions (`userId == null`) are automatically exempt.
- **`requireVerifiedSession` (HTML guard):** check onboarding **before** verify —
  `if (needsOnboarding(session)) throw redirect("/dashboard/onboarding")`, then
  the existing unverified→`/dashboard/verify-needed` check.
- **`requireDashboardSession` (API guard):** add a 403 `onboarding_required`
  before the existing 403 `email_unverified` (parity with the verify precedent).
- The onboarding route uses `getSessionFromRequest` / allow-unverified (NOT
  `requireVerifiedSession`), so an unverified Door-B user can reach it.
- **To verify in planning:** confirm the HTML dashboard routes actually funnel
  through `requireVerifiedSession` (or a shared layout loader). If some routes
  gate a different way, place the onboarding redirect at that shared entry point
  so the gate can't be bypassed. Do not assume a single choke point exists.

## 6. Onboarding route — `app/routes/dashboard.onboarding.tsx`

**Loader:** load session (allow-unverified). No session → `/login`. Already
onboarded (`onboardedAt != null`) or `userId == null` → redirect to next step
(`/dashboard`). Otherwise render.

**Action:** same-origin + rate-limit (match sibling auth actions). Read `intent`:
- Validate `phone` (required; normalize + light check, see §8) and
  `referral_source` (required; must be an allowed key; capture
  `referral_source_other` only when `other`). Bad input → 422 (JSON) or
  re-render with error code (form).
- Persist via `setOnboardingProfile(userId, {...})` which sets the three fields
  **and** `onboarded_at = now()` in one update.
- `intent = "finish"` → redirect: unverified → `/dashboard/verify-needed`, else
  `/dashboard`.
- `intent = "connect"` → set the signed pending-link cookie (§7) and redirect to
  `/dashboard/login?return_to=/dashboard/onboarding/connected` (Shopify OAuth).

**UI:** `AuthShell` + existing `cd-*` primitives (matches signup/verify pages;
no Polaris on the dashboard surface). Graphics-forward, minimal words per the
design directive: title ≤3 words, labels ≤2 words. `<input type="tel">` for
phone; native `<select>` for how-heard with a conditional free-text input when
"Other" is chosen. Primary **Continue** (`intent=finish`); secondary **Connect
Shopify — bring your data over** (`intent=connect`).

## 7. Optional Shopify connect — repoint-membership linking

Required fields are **saved before** OAuth launches, so data is captured even if
the merchant abandons the Shopify round-trip.

**Handoff token/cookie** — new `app/lib/auth/pending-link-token.server.ts`,
modeled exactly on `google-signup-token.server.ts` (HMAC-SHA256 over a base64url
JSON payload, `DASHBOARD_SESSION_PEPPER`, 15-min expiry):
- Payload: `{ userId, placeholderShopId }`.
- Stored in a short-lived `__Host-` HttpOnly/Secure/SameSite=Lax cookie
  (`Max-Age` ~900s) set at connect-time.

**Return route** — new `app/routes/dashboard.onboarding_.connected.tsx` (un-nested
from the redirecting `/dashboard/login`, same convention as the google routes):
1. Read + verify the pending-link cookie → `{ userId, placeholderShopId }`.
   Invalid/expired → clear cookie, redirect `/dashboard`.
2. Read the now-active session (`getSessionFromRequest`); it is the **shop-based**
   session for the real shop minted by `dashboard.auth.callback`. Take
   `realShopId = session.shopId`.
3. **Safety guard (has its own test):** repoint **only if** the real shop has
   **no existing first-party membership** (`membership` rows for `realShopId`).
   If it already has one, the store belongs to another account — **abort the
   link**, clear cookie, redirect `/dashboard` (data already ported; no
   cross-tenant hijack). Log the aborted-link visibly.
4. Otherwise repoint: `UPDATE membership SET shop_id = realShopId WHERE
   user_id = userId AND shop_id = placeholderShopId`. Clear cookie. Redirect
   `/dashboard`.

Result: one account, backed by the real Shopify shop + its ported data;
email/Google login later resolves to the real shop (`resolveShopForUser` returns
`realShopId`). The active session remains shop-based (authenticated, correctly
scoped) — acceptable for v1.

**Orphaned placeholder shop** (the `provisionOwnedShop` row created at signup) is
left in place (harmless; cleanup is a possible later chore, not v1).

## 8. Validation helpers — `app/lib/auth/onboarding.server.ts`

- `normalizePhone(raw): string | null` — trim, keep leading `+` and digits;
  require 7–15 digits (E.164 range); return normalized `+<digits>` or `null`
  when invalid. **Test both branches.**
- `REFERRAL_SOURCES` constant (the allowed keys) + `isReferralSource(x)` guard.
  **Test accept/reject.**
- `setOnboardingProfile(userId, { phone, referralSource, referralOther })` —
  single Supabase update setting the four columns incl. `onboarded_at`. **Test
  persistence + that `onboarded_at` is set.**
- `repointMembershipToRealShop(userId, placeholderShopId, realShopId)` — the
  guarded update from §7 step 3–4; returns whether it linked. **Test: links when
  real shop is unowned; aborts when real shop already has a membership.**

## 9. Files

**New**
- `supabase/migrations/<timestamp>_users_onboarding_profile.sql` (timestamp
  assigned at implementation, following the `YYYYMMDDHHMMSS` convention)
- `app/routes/dashboard.onboarding.tsx`
- `app/routes/dashboard.onboarding_.connected.tsx`
- `app/lib/auth/onboarding.server.ts`
- `app/lib/auth/pending-link-token.server.ts`
- tests alongside existing `__tests__` conventions

**Changed**
- `app/lib/dashboard/session.server.ts` — `onboardedAt` on session, gate in
  `requireVerifiedSession` + `requireDashboardSession`
- `app/routes/dashboard.signup.tsx` — success redirect → `/dashboard/onboarding`
- `app/routes/dashboard.auth.google_.store.tsx` — success redirect →
  `/dashboard/onboarding`
- `app/lib/auth/users.server.ts` — extend `findUserByGoogleSub`/session read only
  if needed (likely untouched; onboarding read is on the session join)

## 10. Testing plan (TDD — red → green)

Unit:
- `normalizePhone` valid/invalid branches.
- `isReferralSource` accept known / reject unknown.
- `setOnboardingProfile` persists fields + `onboarded_at`.
- `repointMembershipToRealShop`: links unowned real shop; **aborts when real
  shop already owned** (hijack guard).
- `needsOnboarding` truth table (first-party unonboarded → true; onboarded →
  false; shop-session `userId==null` → false).

Route/integration:
- `requireVerifiedSession` redirect precedence: unonboarded → `/dashboard/onboarding`
  even when also unverified.
- Onboarding action: `finish` with valid input saves + redirects
  (verify-needed vs dashboard by verified state); invalid phone/referral → 422;
  `connect` saves, sets cookie, redirects to `/dashboard/login?return_to=...`.
- Onboarding loader: already-onboarded → redirect away.
- Connected route: valid cookie + unowned real shop → membership repointed →
  `/dashboard`; already-owned real shop → link aborted, cookie cleared; bad/expired
  cookie → `/dashboard`.
- Changed signup redirects (email + google) now land on `/dashboard/onboarding`.

## 11. Non-goals / follow-ups

- Deleting/garbage-collecting the orphaned placeholder shop.
- Swapping the post-connect shop-session back to a first-party session.
- Onboarding for Shopify-connect (Door A) users.
- Country-code dropdown / heavy phone validation (light normalize only for v1).

## 12. Verification gates (pre-commit, per CLAUDE.md)

`/code-review` clean · `npm run typecheck` · `npm run lint` (0 warnings on touched
files) · `npm run build` · `npx prisma validate` (n/a — no Prisma schema change) ·
`npx prisma migrate diff` (n/a — Supabase migration, validated via the SQL) ·
full test suite green. No `graphql-codegen` (no `.graphql` changes).
