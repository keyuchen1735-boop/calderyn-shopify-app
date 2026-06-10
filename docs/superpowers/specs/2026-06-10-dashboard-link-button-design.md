# Open-web-dashboard button (embedded app → external dashboard)

**Date:** 2026-06-10
**Status:** Approved (user, this session)

## Goal

Give merchants a one-click path from the embedded Shopify admin app to the
external merchant dashboard at `calderyncompany.com/dashboard`, landing
signed in.

## Decisions (made with user)

1. **Auth handoff: reuse Sign-in-with-Shopify.** The button targets
   `/dashboard/login?shop=<shop>` on the public dashboard origin. That route
   runs the existing OAuth round-trip (verified end-to-end 2026-06-10); a
   merchant with a live Shopify admin session lands on `/dashboard` signed in
   without any prompt. No new token machinery, no new auth surface.
   (Rejected: one-time handoff token — seamless but adds a token store,
   two routes, and expiry/replay handling for marginal UX gain.)
2. **Placement: home page header.** A `secondaryActions` entry
   "Open web dashboard" next to "Settings" in `app/routes/app._index.tsx`.
   (Rejected: NavMenu — external targets there are unconventional and App
   Bridge may force them into the iframe; Settings page — low discoverability.)

## Design

- **Loader** (`app._index.tsx`): compose the URL server-side and add it to the
  payload — `dashboardLoginUrl =
  "${DASHBOARD_PUBLIC_URL ?? "https://calderyncompany.com"}/dashboard/login?shop=" +
  encodeURIComponent(session.shop)`. Set on both the success and error payload
  branches (payload type stays consistent). Env stays server-only.
- **UI**: `secondaryActions={[..., { content: "Open web dashboard",
  url: dashboardLoginUrl, external: true }]}` — Polaris renders a
  `target="_blank"` anchor. A new tab is required regardless of taste: the
  dashboard sends `frame-ancestors 'none'`, so it cannot load inside the
  admin iframe.
- **Error handling**: none added client-side; `/dashboard/login` already
  handles invalid shop (422), rate limiting (429), and OAuth failures.

## Testing

Extend the home-route loader coverage: assert the loader payload's
`dashboardLoginUrl` contains `/dashboard/login` and the session's shop domain,
for both the success and the error branch.

## Dashboard parity (CLAUDE.md rule)

Exempt: the dashboard is the *destination* of this feature; a
"go to dashboard" affordance has no dashboard-side equivalent.
