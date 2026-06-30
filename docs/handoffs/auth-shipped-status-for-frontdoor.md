# Auth backend: shipped + live (status for the marketing-site front door)

**Date:** 2026-06-30
**From:** the first-party auth track (Slice 0 + follow-ups).
**For:** whoever owns the branded `/login` + `/signup` front door (calderyn-waitlist PR #29).

## TL;DR

First-party auth is MERGED to `main` (c61e6bc) and LIVE on prod. Email/password signup, signin, and reset, plus email verification and Google sign-in, all work on the backend. The one gap: **there is no "Continue with Google" button visible to users yet**, because the branded `/login` and `/signup` pages are not deployed (`calderyncompany.com/login` returns 404 as of 2026-06-30). The only live login UI is the minimal fallback form at `/dashboard/signin` (email + password, no Google button, no branding). Action: deploy the branded front door with the Google button pointing at `/dashboard/auth/google`.

## What is live on prod today

- `POST /dashboard/signup` (email, password, store): creates the user + an owned shop + a session, emails a verification link, and redirects to `/dashboard` (the user then lands on the verify gate until they confirm).
- `POST /dashboard/signin` (email, password): 401 `invalid_credentials` on bad creds, otherwise a session + redirect to `/dashboard`.
- `GET /dashboard/reset` + `POST /dashboard/reset` + `/dashboard/reset/confirm`: password reset (silent request email, single-use token).
- `GET /dashboard/verify?t=...`: consumes the verification token. `GET /dashboard/verify-needed`: the hard-gate screen (resend + sign out).
- `GET /dashboard/auth/google`: sets a CSRF state cookie and 302s to Google (OAuth client configured, redirect URI registered). `GET /dashboard/auth/google/callback`: dispatches: a known Google account signs in; an existing account whose email matches the Google-verified email is linked and signed in; a brand-new person goes to a "name your store" step at `/dashboard/auth/google/store`.
- Email-verification HARD gate: an unverified first-party user gets a 403 on every `dashboard.api.*` route and is redirected to `/dashboard/verify-needed`. Google sign-ins are pre-verified and skip the gate. Shopify merchants are never gated (dual-run intact).

## The contract your branded pages target

- Form POSTs: `POST /dashboard/signin` (email, password); `POST /dashboard/signup` (email, password, store); `GET /dashboard/reset`.
- "Continue with Google" button: a top-level navigation to `GET /dashboard/auth/google` (it sets a cookie then 302s to Google, so navigate the window, do not fetch/XHR it).
- Stable backend error codes to map to friendly text: `invalid_credentials`, `invalid_email`, `weak_password`, `email_taken`, `missing_store`, `no_shop`, `rate_limited`.
- Success is a relative redirect to `/dashboard`. Keep the page same-origin under `calderyncompany.com` (the apex) so the `__Host-` session cookie survives the proxy.
- Full contract: `docs/handoffs/FROM-frontdoor-login-signup.md` and `docs/handoffs/waitlist-frontdoor-to-slice0-auth-contract.md`.

## The gap and the action for the front door

- Right now `/dashboard/signin` and `/dashboard/signup` serve a BARE fallback form (email + password only, no Google button, no branding). They exist to make the auth logic work, not as the user-facing UI.
- The branded `/login` + `/signup` (calderyn-waitlist PR #29) are NOT deployed (404 on `calderyncompany.com/login` and `/signup` as of 2026-06-30).
- Action: deploy the branded front door, with the "Continue with Google" button navigating to `/dashboard/auth/google`. Once it deploys, Google sign-in and a polished login are surfaced to users. Until then, Google sign-in only works by hitting `/dashboard/auth/google` directly.
- If you would rather the backend fallback form also carry a Google button in the meantime, ping the auth track and we will add a styled link to `/dashboard/auth/google` on `/dashboard/signin` + `/dashboard/signup`.

## Prod config already done (no action needed from the front door)

- Google OAuth sign-in client created; `GOOGLE_SIGNIN_CLIENT_ID` / `GOOGLE_SIGNIN_CLIENT_SECRET` set in Vercel (shopify-app, Production). Registered redirect URI: `https://calderyncompany.com/dashboard/auth/google/callback`. Scopes: `openid email profile` (basic, no Google verification review needed). Consent screen is In production / External.
- Both auth migrations applied to prod Supabase (users, membership, password_reset_token, dashboard_sessions.user_id, shops owned-identity columns, google_sub, email_verified, the verify token purpose).
- `PASSWORD_PEPPER`, `DASHBOARD_SESSION_PEPPER`, and `DASHBOARD_PUBLIC_URL` are set in prod.
