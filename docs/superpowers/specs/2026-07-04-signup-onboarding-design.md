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
3. **Connect Shopify to bring your data over** — optional; hands off to the
   existing Shopify-OAuth flow + #13 cutover/import machine (§7). Onboarding adds
   no port or account-linking code of its own.

Shopify-connect (Door A) users are **out of scope**: they arrive via Shopify,
already have their data ported, and have no first-party `users` row.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Signup paths in scope | Email/password + Google only |
| Placement | **Right after signup**, before the email-verify gate |
| Phone | **Required** (light validation) |
| How-heard options | Fixed set (below) + free text on "Other" |
| Shopify connect / data port | **Reuse the existing #13 cutover machine** — no invented port or linking code (see §7) |

## 3. Flow

```
Email/pw signup ─┐
Google signup  ──┼─▶ /dashboard/onboarding ──finish──▶ [unverified? verify-needed : /dashboard]
                 │                          └─connect─▶ save fields → /dashboard/login (existing Shopify OAuth)
                 │                                        → dashboard.auth.callback → startImport+kickDrainSoon (#13)
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
- `intent = "connect"` → after the same save (incl. `onboarded_at`), redirect to
  `/dashboard/login` — the existing Shopify OAuth that enters the #13 machine (§7).

**UI:** `AuthShell` + existing `cd-*` primitives (matches signup/verify pages;
no Polaris on the dashboard surface). Graphics-forward, minimal words per the
design directive: title ≤3 words, labels ≤2 words. `<input type="tel">` for
phone; native `<select>` for how-heard with a conditional free-text input when
"Other" is chosen. Primary **Continue** (`intent=finish`); secondary **Connect
Shopify — bring your data over** (`intent=connect`).

## 7. Optional Shopify connect — hand off to the existing #13 machine

**Do not invent a port or linking mechanism.** The platform-pivot #13 cutover
machine is fully built and owns "port over all existing data." Onboarding only
*enters* it; it re-implements nothing.

What already exists (reused verbatim):
- **Connect** = the existing Shopify OAuth entry `GET /dashboard/login` →
  `dashboard.auth.callback`, which stores the offline token, runs
  `completeShopInstall`, calls **`startImport(shopId)` + `kickDrainSoon()`**
  (`app/lib/import/run.server.ts`), and steers to the import/store screen.
- **Data port** = `import/run.server.ts` (`#13.promote`): `backfillShop` +
  `importCustomers` → `promoteShopFromMirror` → `relinkOrdersToBuyers` → honest
  `buildImportReport`, drained by `/cron/import`.
- **Cutover** = `app/lib/cutover/org-mode.server.ts` state machine
  (`mirror → importing → dual_run → live`, parity + payment-cleared go-live
  gates) driven by the existing `dashboard.api.cutover` route + `Cutover.tsx`
  screen. The merchant completes cutover there, at their own pace — **outside**
  onboarding.

Onboarding's contribution (all it adds):
1. The `connect` intent **validates + saves** phone/referral and sets
   `onboarded_at` first (so required data is captured even if the merchant
   abandons the OAuth round-trip).
2. Then `redirect("/dashboard/login")` — the same shop-less OAuth the "Continue
   with Shopify" button uses. No `return_to` needed; the callback's existing
   steering lands the merchant on the store/import screen where the port is
   visible. The shop enters the #13 machine at `mirror` and the import
   auto-runs.

**Consequence (accepted for v1, supersedes the earlier "repoint membership"
idea):** the callback mints a **shop-based** session (overwriting the first-party
session cookie), exactly as any "sign in with Shopify" does. So after connecting,
the merchant is authenticated as the real shop; the placeholder owned-shop from
signup is left orphaned (harmless). We do **not** add membership-repointing — that
would be inventing on top of the existing flow, which the port-mechanism decision
rules out. The `users` row (phone/referral) persists regardless.

## 8. Validation helpers — `app/lib/auth/onboarding.server.ts`

- `normalizePhone(raw): string | null` — trim, keep leading `+` and digits;
  require 7–15 digits (E.164 range); return normalized `+<digits>` or `null`
  when invalid. **Test both branches.**
- `REFERRAL_SOURCES` constant (the allowed keys) + `isReferralSource(x)` guard.
  **Test accept/reject.**
- `setOnboardingProfile(userId, { phone, referralSource, referralOther })` —
  single Supabase update setting the four columns incl. `onboarded_at`. **Test
  persistence + that `onboarded_at` is set.**

No linking/port helpers here — the `connect` intent just saves and redirects into
the existing `/dashboard/login` OAuth flow (§7).

## 9. Files

**New**
- `supabase/migrations/<timestamp>_users_onboarding_profile.sql` (timestamp
  assigned at implementation, following the `YYYYMMDDHHMMSS` convention)
- `app/routes/dashboard.onboarding.tsx`
- `app/lib/auth/onboarding.server.ts`
- tests alongside existing `__tests__` conventions

No `connected` return route and no pending-link token module — the port/cutover
is the existing #13 machine (§7).

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
- `needsOnboarding` truth table (first-party unonboarded → true; onboarded →
  false; shop-session `userId==null` → false).

Route/integration:
- `requireVerifiedSession` redirect precedence: unonboarded → `/dashboard/onboarding`
  even when also unverified.
- Onboarding action: `finish` with valid input saves + redirects
  (verify-needed vs dashboard by verified state); invalid phone/referral → 422;
  `connect` saves (sets `onboarded_at`) then redirects to `/dashboard/login`.
- Onboarding loader: already-onboarded → redirect away.
- Changed signup redirects (email + google) now land on `/dashboard/onboarding`.

## 11. Non-goals / follow-ups

- **Driving the cutover** (`mirror→importing→dual_run→live`) inside onboarding —
  the existing `dashboard.api.cutover` route + `Cutover.tsx` screen own it. Onboarding
  only kicks off connect + import.
- **Account-linking** the placeholder shop to the real Shopify shop
  (membership-repoint) — dropped per the port-mechanism decision (§7); the
  post-connect shop-session and orphaned placeholder are accepted for v1.
- Deleting/garbage-collecting the orphaned placeholder shop.
- Onboarding for Shopify-connect (Door A) users.
- Country-code dropdown / heavy phone validation (light normalize only for v1).

## 12. Verification gates (pre-commit, per CLAUDE.md)

`/code-review` clean · `npm run typecheck` · `npm run lint` (0 warnings on touched
files) · `npm run build` · `npx prisma validate` (n/a — no Prisma schema change) ·
`npx prisma migrate diff` (n/a — Supabase migration, validated via the SQL) ·
full test suite green. No `graphql-codegen` (no `.graphql` changes).
