# Slice 0 Auth Follow-ups: Google sign-in, email verification gate, owned-store brand subtitle

**Date:** 2026-06-29
**Status:** Design approved. Ready for implementation plan.
**Builds on:** Slice 0 first-party auth (branch `feat/de-shopify-auth`, PR #220). This branch (`feat/auth-followups`) is stacked on it.
**Parent context:** `docs/superpowers/specs/2026-06-28-slice-0-first-party-auth-design.md` (these three were explicitly deferred there as fast-follows / polish).

## Goal

Three follow-ups to first-party auth:
1. **Google sign-in** at `GET /dashboard/auth/google` (the marketing-site front door already points its "Continue with Google" button here, per `docs/handoffs/FROM-frontdoor-login-signup.md`).
2. **Email verification gate:** a new email+password merchant can log in, but sees a hard "verify your email" gate instead of the dashboard until they confirm. Google sign-ins are pre-verified and skip it.
3. **Owned-store brand subtitle:** the dashboard brand subtitle shows the store's `display_name` instead of blank for owned (non-Shopify) shops.

## Locked decisions (from brainstorm)

| Decision | Choice |
|---|---|
| New Google user, store name | Ask once: a "name your store" step after Google auth (parity with the email signup form), before the shop is created. |
| Google email matches an existing email+password account | Link Google to that account and sign in (Google has verified the email). No duplicate accounts. |
| Verify gate strictness | Hard gate: unverified first-party users hit a `/dashboard/verify-needed` screen (resend + sign-out only) instead of the dashboard; `dashboard.api.*` also returns 403. Google sign-ins skip it. |

## Coordinated migration (all three touch `users`)

One migration, written byte-identical to BOTH `supabase/migrations/` AND `tests/engine/schema/migrations/`, idempotent, dual-run safe:

- `alter table public.users alter column password_hash drop not null;` (Google-only users have no password)
- `alter table public.users add column if not exists google_sub text;` + `create unique index if not exists users_google_sub_key on public.users(google_sub) where google_sub is not null;`
- `alter table public.users add column if not exists email_verified boolean not null default false;`
- A credential-presence guard: every user has at least one credential. Add `alter table public.users add constraint users_has_credential check (password_hash is not null or google_sub is not null) not valid;` then `validate constraint` (or add it guarded so re-runs are safe). (Existing Slice-0 users all have a password_hash, so the constraint holds.)
- Extend the reset-token purpose set: drop and re-add the `password_reset_token.purpose` CHECK to include `'verify'` (currently `in ('reset','set_password')` -> `in ('reset','set_password','verify')`), guarded so re-running is safe.

The `shops.id` UUID contract and all `*_fact`/`*_dim`/`v_*` objects stay untouched.

## Feature 1: Google sign-in

### OAuth client and validation
- A DEDICATED OAuth client, separate from the least-privilege Google **Ads** client (`GOOGLE_ADS_CLIENT_ID`, scope `adwords` only, in `app/lib/google/oauth.server.ts`). New env: `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` (added to `.env.example`; set in prod Vercel). Scope `openid email profile`; standard authorization-code grant, NO `access_type=offline`/refresh (sign-in needs no refresh token).
- New lib `app/lib/auth/google-signin.server.ts` (pure helpers with an injected fetcher, mirroring the Ads oauth's testable shape): `buildSigninAuthUrl`, `exchangeCodeForIdToken`, and a validator that confirms the `id_token` via Google's `tokeninfo` endpoint (`https://oauth2.googleapis.com/tokeninfo?id_token=...`) so NO new JWT dependency is needed. Validation requires: `aud === GOOGLE_SIGNIN_CLIENT_ID`, `iss` is a Google issuer, not expired, and returns `{ sub, email, emailVerified }`.
- CSRF: reuse `createOAuthState`/`consumeOAuthState` from `app/lib/meta/oauth-state.server.ts`.

### Routes and flow
- `GET /dashboard/auth/google` (`app/routes/dashboard.auth.google.tsx`): `requireSameOrigin` is not applicable (top-level GET navigation); mint state via `createOAuthState`, redirect to Google. Rate-limit per-IP.
- `GET /dashboard/auth/google/callback` (`app/routes/dashboard.auth.google.callback.tsx`): consume+verify state, exchange `code`, validate the id_token, get `{sub, email, emailVerified}`. Then:
  1. `emailVerified === false` from Google -> reject (do not trust unverified Google emails).
  2. Find user by `google_sub`. If found -> resolve their shop, mint session, redirect `/dashboard`.
  3. Else find user by normalized `email`. If found -> set `google_sub` on that user (LINK), resolve their shop, mint session, redirect `/dashboard`.
  4. Else NEW user -> do NOT create anything yet. Pack the verified `{sub, email, exp}` into a SIGNED STATELESS token (HMAC-SHA256 over the payload with a server secret, base64url payload + signature) and redirect to the store-name step carrying it. A DB token row is deliberately NOT used here: `password_reset_token` FKs to `users(id)` and no user exists yet at this step. The signature plus a short (~15 min) `exp` makes the token unforgeable and time-bounded without persistence.
- `GET/POST /dashboard/auth/google/store` (`app/routes/dashboard.auth.google.store.tsx`): GET renders a single "name your store" field carrying the signed token; POST validates the token, then ATOMICALLY creates the user (`google_sub` set, `password_hash` null, `email_verified = true`), provisions the owned shop (`provisionOwnedShop`), links membership, and mints the session -> redirect `/dashboard`. On any post-user failure, compensate like the email signup route (best-effort cleanup; no orphaned accounts). Same `store` validation as signup (`missing_store`).

### Notes
- Google sign-in users are `email_verified = true`, so they bypass Feature 3's gate.
- Account model stays one-store-per-user-for-v1 (consistent with Slice 0): a Google sign-in resolves to a single membership shop.
- Error codes reuse the stable set where applicable; new Google-specific failures use clear codes (e.g. `google_unverified_email`, `google_oauth_failed`) shown on a small error page.

## Feature 2: Owned-store brand subtitle

- `app/routes/dashboard._index.tsx` loader: read `shops.display_name` and `shop_domain` by `session.shopId`; return `storeLabel = display_name || shop_domain || "Your store"` plus the existing nullable `shopDomain`.
- `app/components/dashboard/DashboardApp.tsx` + `app/components/dashboard/context.ts`: add `storeLabel: string`; render `storeLabel` in `cd-brand-sub` (was `shopDomain`). Keep `shopDomain: string | null` in the context for `Alerts.tsx`'s Shopify deep links (already guarded by `app.shopDomain &&`, so owned shops correctly hide them).

## Feature 3: Email verification gate

- **Token + email:** signup (`app/routes/dashboard.signup.tsx`) mints a `purpose='verify'` token (longer TTL, ~24h) after `createUser`, and emails a verify link (`${baseUrl}/dashboard/verify?t=<raw>`) via `sendEmail`. The user is still logged in (session minted as today) but lands behind the gate.
- **Consume route:** `GET /dashboard/verify` (`app/routes/dashboard.verify.tsx`): consume the verify token (single-use, TTL, HMAC-at-rest, reusing `reset.server.ts` token helpers), set `users.email_verified = true`, redirect `/dashboard`. `Referrer-Policy: no-referrer` (the token is in the URL).
- **Gate screen:** `GET /dashboard/verify-needed` (`app/routes/dashboard.verify-needed.tsx`): the hard-gate screen with a "resend verification email" action and a sign-out link. Resend re-mints a verify token and re-sends (rate-limited per-account).
- **The single choke point:** `getSessionFromRequest` (`app/lib/dashboard/session.server.ts`) joins `users.email_verified` when `user_id` is set; `DashboardSession` gains `emailVerified: boolean` (TRUE whenever `userId` is null, i.e. Shopify-path sessions, so they always pass). A helper `requireVerifiedSession(request)` wraps `requireDashboardSession` and throws `redirect("/dashboard/verify-needed")` for an unverified first-party session. Dashboard page loaders use `requireVerifiedSession`; the verify / verify-needed / resend / sign-out routes use plain `requireDashboardSession` (no loop). The `dashboard.api.*` routes return `403 email_unverified` for an unverified first-party session so features genuinely do not function (defense beyond the UI redirect).
- **Dual-run (critical):** Shopify merchants have `userId = null` and `emailVerified = true` by construction, so they are never gated.

## Security considerations

- Only trust Google emails with `email_verified === true`; validate `aud`/`iss`/`exp` on the id_token via Google `tokeninfo` (no client-side trust).
- The new-Google-user interstitial carries only a signed, short-TTL token; the user/shop/session are created atomically on store-name submit (no half-created accounts, mirroring the signup compensating-cleanup pattern).
- Verify and Google-signup tokens are single-use, TTL-bounded, hashed at rest, and the pages send `Referrer-Policy: no-referrer`.
- Account linking is by Google-verified email only; never link on an unverified email.
- Reuse the existing per-IP and per-account rate limiting on the new routes (Google start, callback, store submit, verify, resend). Keep error responses non-enumerating.

## Out of scope (deferred)

- Door A "Connect to Calderyn" + set-password (Slice-0 Plan 2, still parked).
- Multi-store UI / store picker.
- Renaming the assistant `ConversationTurnInput.shopDomain` field (separate cleanup).
- The pre-existing flaky `linkedin-connection.test.ts` (separate fix).
- Google account de-linking / managing multiple identities per user.

## Success criteria

1. A new person clicks "Continue with Google", authorizes, names their store, and lands on the dashboard with an owned shop, no password, `email_verified=true`.
2. An existing email+password user who clicks "Continue with Google" (same email) is signed into their existing account.
3. A new email+password signup can log in but is held at `/dashboard/verify-needed`; clicking the emailed link verifies them and unlocks the dashboard; `dashboard.api.*` returns 403 until verified.
4. Existing Shopify merchants are never gated and the dashboard works exactly as before (dual-run).
5. The owned-store dashboard shows the store's name in the brand subtitle.
6. New env keys are documented in `.env.example`; full pre-commit gate green.

## Setup dependency (on the operator, not code)

A Google Cloud OAuth client for sign-in with redirect URI `https://calderyncompany.com/dashboard/auth/google/callback` (plus a localhost URI for dev); its client id/secret go into the prod Vercel `shopify-app` env and `.env.example`. Until set, the Google button errors; email+password remains fully functional.
