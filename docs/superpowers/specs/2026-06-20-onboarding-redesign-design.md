# Onboarding redesign + functional wiring — design

**Date:** 2026-06-20
**Branch:** `feat/onboarding-redesign`
**Surface:** Shopify embedded app only (the Calderyn dashboard has no onboarding flow, so nothing to mirror — confirmed exempt from the parity rule).

## Goal

Implement the Claude Design "Calderyn Onboarding" handoff (5-step flow, collapsing the
old 9-step wizard) on the embedded `app/routes/app.onboarding.tsx`, and make three
behaviours real that are faked in the design mockup:

1. **Connect (OAuth) opens a NEW TAB**, not a same-tab redirect. After the merchant
   authorizes, the new tab shows a "Connected — return to your setup tab" message, and the
   still-open setup tab updates the provider row to Connected on its own.
2. **Step 1 "Connected to your store"** does a real, live Shopify Admin API check instead of
   a hardcoded badge.
3. **Step 2 "Set your limits"** persists to the real `guardrail_config` row.

Backend reality (already true, the mockup just faked it): `guardrails.update` writes to
`guardrail_config`; `integrations.list` reads pairing live from `shop_integrations`; install
already enqueues a Shopify backfill. So 2 and 3 are wiring tasks; 1 is a real behaviour change.

## Step model

Collapse `ONBOARDING_STEPS` in `app/lib/calderyn.server.ts` from 9 → 5:
`["shopify", "guardrails", "connect", "consent", "complete"]`. Step stays server-persisted in
`shops.onboarding_step` (resume-on-refresh; `postOAuthPath` still keys off `"complete"`).
Pre-launch test shops mid-onboarding reset to step 0 — acceptable (re-seedable).

| New step (index) | Screen | Wiring |
|---|---|---|
| shopify (0) | "Connected to your store" | loader runs Admin `{ shop { name myshopifyDomain } }`; real badge / reconnect state |
| guardrails (1) | "Set your limits" | budget + cap → existing `save_guardrails` intent (cooldown kept at saved/default value) |
| connect (2) | "Connect your accounts" | all 4 providers on one screen; new-tab OAuth + auto status |
| consent (3) | "See how you compare" | existing `save_consent` intent |
| complete (4) | "You're all set" | existing `finish` intent |

The old `creative_mapping` step is dropped (matches the design).

## New-tab OAuth

- `OAuthReturnContext` gains `popup?: boolean`; `packOAuthState`/`parseOAuthState` carry it in
  the existing base64url state payload (key `p`). `startOAuth(provider, host, popup?)` threads it.
- The onboarding `connect_integration` action calls `startOAuth(provider, host, true)` and the
  client does `window.open(url, "_blank")` (was `"_top"`). Settings stays same-tab (popup=false).
- The 4 callbacks (`auth.google/meta/tiktok/quickbooks.$.tsx`) branch their final success AND
  error redirects: when `popup`, redirect to a standalone `/auth/connected` page instead of the
  embedded `embeddedReturnUrl(...)` deep link (which can't render in a bare tab).
- `app/routes/auth.connected.tsx` is a **resource route** (loader returns a raw HTML `Response`,
  no React/root/App Bridge) showing "Connected ✓ — close this tab and return to Calderyn setup"
  or an error variant, with a Close button.

### Auto status update (partition-proof)

localStorage/BroadcastChannel are unreliable across an embedded iframe + a first-party new tab
(storage partitioning). So the source of truth is the server. The connect step:

- polls a lightweight `app/routes/app.onboarding.status.tsx` resource route (one
  `integrations.list` call → `{google,meta,tiktok,quickbooks}` booleans) every ~3s while any
  provider is `connecting`, and
- re-checks immediately on `window` focus / `visibilitychange`.

On a fresh check: paired → `connected`; still-`connecting` but not paired (merchant returned
without success / declined / errored) → revert to `idle` so they can retry. Errors are shown in
the new tab where they happened.

## Visual

Pixel-faithful to the mockup within Polaris: white rounded `Card`, progress dots, provider rows,
copy. Reuse `BrandGlyph` (calderyn lib) for provider/shop logos, `Icon`/`GuardrailMeter` where
they fit, inline-styled containers for layout details. Skip-confirm uses Polaris `Modal`. Keep the
env-gated `ONBOARDING_DEV_BYPASS` link.

## Files

- `app/lib/meta/oauth-state.server.ts` — popup in ctx/pack/parse
- `app/lib/calderyn.server.ts` — `startOAuth(…, popup?)`; `ONBOARDING_STEPS` → 5
- `app/routes/auth.{google,meta,tiktok,quickbooks}.$.tsx` — popup redirect branch
- `app/routes/auth.connected.tsx` — NEW standalone result page
- `app/routes/app.onboarding.status.tsx` — NEW status poll route
- `app/routes/app.onboarding.tsx` — full rewrite to 5-step design + live shop check + new-tab connect
