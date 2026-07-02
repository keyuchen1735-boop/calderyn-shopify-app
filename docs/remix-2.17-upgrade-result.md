# Remix 2.17.5 upgrade result (Option A) — feat/remix-2.17-upgrade

_Executes the plan in `docs/remix-security-upgrade-scoping.md`. Local gate is fully green; this is NOT merge-ready until the live hydration verification below is done. Companion audit: `docs/security-audit-2026-07-02-user-side.md`._

## Outcome: Option A landed, locally viable

Runtime `@remix-run/*` packages moved to the 2.17.5 security line via direct-dep bumps plus npm `overrides`, while keeping `@vercel/remix@2.16.7` and `@remix-run/dev@2.16.7` (build toolchain) in place. Option B was not needed.

Why the risk profile is lower than the historical breakage suggests:
- `@vercel/remix` is **build-time only** in this app: the sole reference is `vercelPreset()` in `vite.config.ts`. No app code imports `@vercel/remix` at runtime (`app/entry.server.tsx` imports only `@remix-run/node` / `@remix-run/react`). The deployed runtime is pure `@remix-run/*`, now all at one deduped 2.17.5 copy.
- Client and server moved **together** (react 2.17.5 + server-runtime 2.17.5), so the single-fetch turbo-stream wire format stays paired. `npm ls` confirms exactly one copy each of `@remix-run/server-runtime@2.17.5`, `@remix-run/node@2.17.5`, `@remix-run/react@2.17.5`, `@remix-run/router@1.23.3`, `react-router@6.30.4`, `react-router-dom@6.30.4`, `turbo-stream@2.4.1` (exit 0, no invalid peers after the node override).
- The upstream 2.16.7 → 2.17.5 code diff in the runtime packages is small and security-targeted (verified by diffing installed `dist/esm` against the main repo's 2.16.7 copies): manifest URL-length guard, origin/host CSRF guard, `escapeHtml` on inline-JSON serialization, ScrollRestoration escaping. No wire-format or manifest-shape changes.

## Diff summary

2 files changed (plus this doc): `package.json`, `package-lock.json` (82 lines, only Remix-line packages moved).

`package.json`:
- dependencies: `@remix-run/node`, `@remix-run/react`, `@remix-run/serve`: `2.16.7` → `2.17.5`
- overrides: `@remix-run/server-runtime`: `2.16.7` → `2.17.5`; added `@remix-run/node: 2.17.5` (collapses the nested copy under `@remix-run/dev`), `@remix-run/router: 1.23.3`, `react-router: 6.30.4`, `react-router-dom: 6.30.4`
- unchanged: `@vercel/remix@^2.16.7`, `@remix-run/dev|eslint-config|fs-routes|route-config@2.16.7`

Lockfile: only `@remix-run/{express,node,react,router,serve,server-runtime}`, `react-router`, `react-router-dom` changed. `turbo-stream` stays 2.4.1 (that is what 2.17.5 itself pins).

## Gate evidence (all run in this worktree, in order)

| Step | Result | Evidence |
|---|---|---|
| `npm run typecheck` | exit 0 | `tsc --noEmit` completed silently, `TYPECHECK_EXIT:0` |
| `npm run lint` | exit 0 | `13 problems (0 errors, 13 warnings)`, `LINT_EXIT:0`; all warnings pre-existing in test files, none in touched files (only package.json/lock touched) |
| `npm run build` | exit 0 | Both Vercel server bundles + client built; `verify:client-bundle`: "Verified 214 client files: no source maps, HMR client, or dev bridges." `BUILD_EXIT:0` |
| `npx vitest run` | exit 0 | `Test Files 514 passed | 5 skipped (519)`, `Tests 3620 passed | 11 skipped (3642)`, 0 failures (baseline on main ~3539; suite has grown) |
| `npm audit --omit=dev` | 10 → 7 (see below) | Before: `10 vulnerabilities (7 high, 3 critical)`. After: `7 high`, all one advisory (GHSA-rxv8-25v2-qmq8) cascading through the tree |
| prisma / graphql-codegen | n/a | schema and .graphql untouched |

## Advisory status after the upgrade

| Advisory | Status | Proof |
|---|---|---|
| GHSA-8x6r-g9mw-2r78 `__manifest` unbounded path expansion DoS | **Cleared** | Installed `node_modules/@remix-run/server-runtime/dist/esm/server.js` `handleManifestRequest` now enforces `URL_LIMIT = 7680` and returns 400 for oversized `/__manifest` URLs before any path expansion; manifest handling also newly gated on `future.v3_lazyRouteDiscovery`. (This advisory is keyed to `@remix-run/server-runtime >=2.10.0 <2.17.5`, patched 2.17.5.) |
| GHSA-9583-h5hc-x8cw file-session-storage path traversal (3 criticals) | **Cleared** from audit | `@remix-run/node@2.17.5`. Was never reachable anyway (Prisma session storage). |
| GHSA-2w69-qvjg-hvjx router XSS via open redirects | **Cleared** | `@remix-run/router@1.23.3` / `react-router@6.30.4`, gone from audit output |
| GHSA-8v8x-cx79-35w7 ScrollRestoration SSR XSS, GHSA-3cgp-3xvw-98x8 XSS | **Cleared** | `@remix-run/react@2.17.5` (verified `escapeHtml(json)` in dist), gone from audit output |
| GHSA-h5cw-625j-3rxh action CSRF | **Fixed in code** (never appeared in npm audit for 2.x) | 2.17.5 adds `throwIfPotentialCSRFAttack` on non-GET document requests and single-fetch actions (see behavior note below) |
| GHSA-rxv8-25v2-qmq8 turbo-stream single-fetch reflected DoS | **NOT cleared — not clearable on any Remix 2.x** | Advisory patches only `turbo-stream 3.0.0` (React Router >=7.14). Remix 2.17.5 itself still pins turbo-stream 2.4.1, so `npm audit --omit=dev` still exits 1 with 7 highs, all this one advisory via the dep tree. Forcing turbo-stream 3.x under Remix 2.x would change the single-fetch wire format (the known hydration/data-corruption failure class) and was deliberately not attempted. Residual risk is DoS-shaped only, partially blunted by the PR #257 rate limits; real fix is the React Router 7 migration (scoping doc Option C). |

## Behavior change to verify live: the new built-in CSRF guard

2.17.5 unconditionally (no opt-out flag) rejects POST/PUT/PATCH/DELETE **document requests** and **single-fetch `.data` actions** when an `Origin` header is present and its host does not match `x-forwarded-host` (first value) or `host`.

- Server-to-server POSTs are unaffected: Shopify/Stripe webhooks, ACP `checkout_sessions`, MCP OAuth `token`/`register`, cron. They send no `Origin` header, and resource routes are not guarded at all (`handleResourceRequest` has no check).
- Same-origin browser actions (embedded `/app` inside the Shopify iframe, `app.calderyncompany.com/dashboard` direct) should pass: Origin equals forwarded host.
- **The open risk is the apex proxy**: `calderyncompany.com/dashboard/*` → `app.calderyncompany.com` (vercel.json external rewrite in Mezoh/calderyn-waitlist). The browser sends `Origin: https://calderyncompany.com`; if Vercel's proxy presents `x-forwarded-host: app.calderyncompany.com` to the app, every form action through the proxy (notably `/dashboard/signin`) throws and 500s. If it preserves the original host, it passes. This cannot be determined locally and MUST be probed on the preview deploy. Note the app's own `requireSameOrigin` is an allowlist (both origins allowed), so it passing today proves nothing about the new framework check.

## Remaining live verification before merge (human steps, mandatory)

Local typecheck/build/tests cannot catch hydration breakage (history: `turbo-stream-override-broke-hydration`, `vercel-remix-version-cap`). Before merging:

1. **Preview deploy** this branch to Vercel (do not promote): `vercel deploy` from the worktree or push the branch and use the auto-preview. Re-alias vercel.app aliases if testing tenant storefronts.
2. **Hydration check in a real browser** (DevTools console open, zero hydration warnings/errors, interactivity works) on each surface:
   - Embedded admin `/app` inside the Shopify admin iframe (navigate between pages, submit one action, e.g. settings save).
   - Dashboard `/dashboard` at the preview URL: sign in, navigate, run one mutation (this exercises single-fetch actions).
   - **Dashboard via the apex proxy** `calderyncompany.com/dashboard/signin`: submit the signin form and confirm no 500 (the CSRF-guard/x-forwarded-host question above). If it 500s, the fix is to make the proxy forward the original host, or serve dashboard auth on the app origin; report back before merge.
   - A tenant storefront: browse, add to cart, complete a test checkout.
   - `/oauth/authorize` connector page renders and the flow completes.
3. **Single fetch + manifest probes** on the preview URL:
   - `curl -s "https://<preview>/dashboard/signin.data"` returns turbo-stream data (starts with `[[` style payload), status 200.
   - `curl -s -o /dev/null -w "%{http_code}" "https://<preview>/__manifest?version=<wrong>"` → 204; a `/__manifest?version=...&p=/a&p=/b...` URL longer than 7680 chars → **400** (proves the DoS fix live).
4. `curl -sI` the preview: PR #257 security headers still present on `/dashboard/signin` (XFO/CSP frame-ancestors, HSTS, etc.).
5. Webhook smoke: trigger one Shopify webhook (or replay) and one ACP/MCP POST against the preview to confirm resource routes still accept server-to-server POSTs.
6. Then merge order: land PR #257 (feat/security-hardening) first, rebase this branch, re-run the gate, merge.

## Follow-ups

- The turbo-stream advisory (GHSA-rxv8-25v2-qmq8) stays open on any Remix 2.x. Track the React Router 7 migration (scoping doc Option C) as the closing move; until then `npm audit --omit=dev` will keep exiting 1 with that single root advisory.
- `@remix-run/dev` + `@vercel/remix` remain 2.16.7 (build-time). If a future advisory lands in the dev-server/build path, revisit Option B.
