# Calderyn user-side security + vibecode audit — 2026-07-02

Goal: ensure a visitor inspecting the domain (DevTools, network, source, headers) cannot find a security vulnerability or spot a "vibecoded" artifact. Method: three Fable-orchestrated fan-out workflows (finders → adversarial per-finding verification → synthesis).

> **Run provenance:** the first discovery pass executed on `claude-opus-4-8` (a `general-purpose` agentType default overrode Fable); the two follow-up sweeps were pinned to `claude-fable-5`. All findings below survived independent adversarial verification against the real code and live headers.

## Verdict

The app is fundamentally solid from the user side. The Fable auth sweep called the posture "broadly excellent": no missing-auth routes, no IDOR, no open redirect, no injection/XSS/SSRF, no secret leakage into the browser, no source maps, no dev bridges, and no AI-provenance markers in the shipped bundle (213 client files verified clean). All confirmed findings were hardening / defense-in-depth, not active breaches.

**Confirmed across all passes:** 1 high, 4 medium, ~17 low, ~24 info (some overlap across passes). Everything fixable without a framework migration is **fixed on `feat/security-hardening` (commit c8e5367)**; the high + 2 mediums share one root cause (a pinned framework version) and are a tracked migration.

## Fixed and shipped (`feat/security-hardening`, gate green)

**Frame / clickjacking (the top pass-1 finding)**
- `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` for non-embedded surfaces (dashboard, storefront, oauth, pilot). Embedded `/app` + `/auth` deliberately untouched so the Shopify admin iframe still loads.

**Response headers**
- COOP (`same-origin-allow-popups`), `Origin-Agent-Cluster: ?1`, `Cross-Origin-Resource-Policy: same-site` on dashboard-API JSON, extended `Permissions-Policy` (usb, interest-cohort), `Cache-Control: no-store` on authenticated document shells, and stopped clobbering a stricter per-route `Referrer-Policy`.

**Rate limiting / cost-abuse (2 mediums + several lows)**
- Storefront checkout (per-IP + per-cart — the medium: Stripe PaymentIntent + carrier-quote abuse), assistant × 2 (the medium: unbounded LLM spend), add-to-cart, delivery-promise, bug-report × 2, oauth authorize/login, pilot unsubscribe. Per-line cart quantity cap.

**AuthZ / cookies / sessions**
- `dashboard.builder.{generate,preview}` now use `requireVerifiedSession` + `requireSameOrigin` (was unverified session + no CSRF check → credit abuse).
- Shop-hint cookie no longer written pre-auth (login-CSRF / signin-lockout vector); set only after a successful OAuth callback; signin validates the hint and honors an `?email` escape hatch.
- Logout made idempotent (always clears the cookie, even on a dead session).
- Cart cookie fails closed in production when the signing secret is absent.

**Hygiene / vibecode**
- Guarded the checkout-test action in prod; prod-gated the pilot email preview; 180-day expiry on the unsubscribe token (matches the "expired" copy); removed the onboarding dev-bypass button + loader field + retired env key; removed a stray `data-testid` from the shipped bundle.

## Documented backlog (NOT fixed — needs a decision or a migration)

| Severity | Item | Why deferred |
|---|---|---|
| **High** | `@vercel/remix` pinned at 2.16.7 blocks all Remix 2.17.x security patches | Root cause of the npm-audit advisories. The pin is deliberate (overriding Remix internals past the `@vercel/remix` cap has broken SSR hydration before). Needs a real migration (drop the adapter or move to React Router 7) + a live hydration verify, not a blind bump. |
| Medium | `__manifest` DoS (GHSA-8x6r-g9mw-2r78, `v3_lazyRouteDiscovery`) | Downstream of the Remix pin. Mitigate at the edge (WAF size-cap on `p` params) or disable lazy route discovery (perf tradeoff) until the migration. |
| Medium | turbo-stream single-fetch reflected DoS (GHSA-rxv8-25v2-qmq8, `v3_singleFetch`) | turbo-stream version is dictated by `@remix-run/react`; fixed only by the Remix upgrade. |
| Info | Apex `Access-Control-Allow-Origin: *` on marketing HTML | Lives in the sibling `Mezoh/calderyn-waitlist` repo, not this codebase. |
| Low/Info | `__Host-cd_cart` prefix rename + dedicated cart signing key; full `script-src` CSP with nonces; HSTS preload submission; a shared per-shop rate-limit helper across all `dashboard.api.*`; cart-row TTL cron sweep; ACP body schema validation (behind a disabled flag) | Larger or migration-shaped changes; safe to schedule. Each is a real hardening item, not a live risk. |

## Next steps

1. Open a PR for `feat/security-hardening` and deploy; re-probe with `curl -sI app.calderyncompany.com/dashboard/signin` to confirm the frame + CSP headers land on the origin.
2. Schedule the Remix-off-`@vercel/remix` migration as a dated item — it clears the 1 high + 2 mediums at once.
3. Fix the apex `ACAO:*` in the marketing repo.
