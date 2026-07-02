# React Router 7 migration result (Option C) — feat/react-router-7

_Executes "Option C" from `docs/remix-security-upgrade-scoping.md` (on feat/security-hardening): migrate Remix 2.x → React Router 7 framework mode to durably close the turbo-stream single-fetch DoS (GHSA-rxv8-25v2-qmq8), the one advisory unfixable on any Remix 2.x. Work done in the isolated worktree `C:\Users\famou\Desktop\calderyn-rr7`, commit `23bd0b7` on `feat/react-router-7` (based on origin/main `4c0f749`). Local only — NOT pushed, NOT deployed, NOT merge-ready until the live hydration verification below._

## 1. Verdict: fully migrated, locally green

The whole app now runs on **react-router 7.18.1** (framework mode) with **@shopify/shopify-app-react-router 1.2.1** and **@vercel/react-router 1.3.1**. Every step of the repo gate passes locally with real output (section 3), and `npm audit --omit=dev` reports **0 vulnerabilities** (section 4). No types weakened, no eslint-disables added, no gate steps skipped.

What "locally green" does NOT prove: SSR hydration on Vercel. That is exactly the failure class local checks have missed before (`turbo-stream-override-broke-hydration`, `vercel-remix-version-cap`). Section 6 lists the mandatory human verification.

## 2. The shopify-app-remix question (the feared blocker) — CLEAR

- Shopify ships an **official React Router package**: [`@shopify/shopify-app-react-router`](https://www.npmjs.com/package/@shopify/shopify-app-react-router) (v1.2.1, peer `react-router ^7.6.2`), with an official template ([shopify-app-template-react-router](https://github.com/Shopify/shopify-app-template-react-router)) and an [upgrade wiki](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Shopify's docs call it the recommended path forward.
- Same core as what we ran: it depends on `@shopify/shopify-api ^13.1.0` — the exact major `@shopify/shopify-app-remix@4.2.0` used — and the existing `@shopify/shopify-app-session-storage-prisma@^9` peers cleanly (`@shopify/shopify-app-session-storage ^5`). `npm ls` shows a single deduped tree, no invalid peers.
- API deltas encountered (all handled):
  - `AppProvider` from `/react` no longer wraps Polaris React (the new template uses Polaris **web components**); its prop is `embedded` instead of `isEmbeddedApp`, and it now also injects the Polaris web-components script (`cdn.shopify.com/shopifycloud/polaris.js`). Since this app's embedded admin is built on **Polaris React v12**, a new `app/components/EmbeddedAppProvider.tsx` composes the package provider (App Bridge script + `shopify:navigate` listener) with `@shopify/polaris`'s own `AppProvider` (en i18n + a router `Link` shim) — reproducing exactly what `shopify-app-remix`'s provider did internally.
  - `future.unstable_newEmbeddedAuthStrategy` no longer exists (it is the default) — removed from `app/shopify.server.ts`; `expiringOfflineAccessTokens` still exists and stays on.
  - `boundary.headers`/`boundary.error`, `LoginErrorType`, `AppDistribution`, `ApiVersion.July25`, `authenticate.*` — unchanged API, import path swap only.
- Version constraint that matters: react-router latest is now the **8.x** line; the Shopify package peers at `^7.6.2`, so this migration pins the whole framework to **7.18.1** (latest 7.x, > 7.14 where the turbo-stream advisory is patched). RR8 is a later, separate hop gated on Shopify.

## 3. Gate evidence (all run in this worktree, in order, after the final commit's state)

| Step | Result | Evidence |
|---|---|---|
| `npm run typecheck` (`react-router typegen && tsc --noEmit`) | **exit 0** | `TYPECHECK_EXIT:0`, no output from tsc |
| `npm run lint` | **exit 0** | `LINT_EXIT:0`; `✖ 13 problems (0 errors, 13 warnings)` — byte-for-byte the same 13 pre-existing warnings as origin/main (verified by running eslint on the main worktree: also 13, same rules/files); 0 warnings in files this migration touched |
| `npm run build` | **exit 0** | `BUILD_EXIT:0`; client + Vercel-flavored server bundle (`build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/index.js`, same layout `@vercel/remix` produced); `verify:client-bundle`: "Verified 214 client files: no source maps, HMR client, or dev bridges." |
| `npx vitest run` | **exit 0** | `Test Files 515 passed \| 5 skipped (520)`, `Tests 3635 passed \| 11 skipped (3657)`, **0 failed**. (2.17.5-branch baseline was 3620 passed / 519 files; the suite has since grown on main.) |
| `npm audit --omit=dev` | **exit 0** | `found 0 vulnerabilities` |
| prisma / graphql-codegen | n/a | `prisma/schema.prisma` and all `.graphql` untouched |

## 4. npm audit / the turbo-stream advisory — CLEARED

`npm audit --omit=dev` → **`found 0 vulnerabilities`** (exit 0). On the 2.17.5 branch this still exited 1 with 7 highs, all GHSA-rxv8-25v2-qmq8 via `turbo-stream@2.4.1`. React Router 7.18.1 vendors the patched turbo-stream v3 encoder internally — `npm ls turbo-stream` now resolves to **nothing** (`(empty)`), so the advisory is gone from the tree structurally, not just suppressed. This was the entire point of Option C, and it is done.

## 5. Blast radius

Commit `23bd0b7`: **227 files changed, +1630 / −5670** (package-lock.json dominates the deletions).

- **Import renames:** 183 source files imported `@remix-run/node|react|route-config|fs-routes`; all moved to `react-router` / `@react-router/*` via the official codemod (`npx codemod remix/2/react-router/upgrade`) plus manual fixes where the codemod could not know intent.
- **Dependencies:** removed `@remix-run/node|react|serve|dev|fs-routes|route-config`, `@vercel/remix`, `@shopify/shopify-app-remix`; added `react-router@7.18.1` (+ override pin), `@react-router/node|serve@7.18.1` (deps), `@react-router/dev|fs-routes@7.18.1`, `@vercel/react-router@^1.3.1` (devDeps), `@shopify/shopify-app-react-router@^1.2.1`. Kept `@remix-run/eslint-config@2.16.7` (lint-only; RR7 has no replacement — upstream deprecation warning is cosmetic). Dropped now-dead overrides (`@remix-run/server-runtime`, `@remix-run/dev` esbuild/vanilla-extract pins).
- **Config:** `vite.config.ts` → bare `reactRouter()` plugin, all `v3_*` future flags deleted (they are RR7 defaults), `declare module "@remix-run/node"` Future block deleted; new `react-router.config.ts` with `ssr: true` + `vercelPreset()` from `@vercel/react-router/vite` (presets moved out of the vite plugin); `app/routes.ts` → `@react-router/dev/routes` + `@react-router/fs-routes`; `tsconfig.json` → types `@react-router/node`, `rootDirs`/include for `.react-router/types`; `.gitignore` + `.react-router/`; `shopify.web.toml` dev command → `npm exec react-router dev`; package scripts → `react-router build` / `react-router-serve` / `react-router typegen && tsc`; `.eslintrc.cjs` restricted-import rule retargeted `@remix-run/react` → `react-router`.
- **`json()` removal (the one real API break):** RR7 deletes the `json()` util. 62 files imported it, split by role:
  - 26 UI routes (have components; results flow through single fetch) → `data()` from react-router, so `useLoaderData<typeof loader>` typing stays fully inferred. Four files (`social.review.$id`, `storefront._index`, `storefront.collections.$handle`, `storefront.products.$handle`) alias it `dataResponse` because Supabase's `const { data } = ...` destructuring shadowed the import.
  - 36 resource routes/libs (cron, ACP, MCP OAuth, dashboard APIs, healthz — raw HTTP to external callers) → new `app/lib/response.server.ts` `json()` helper that builds the identical `Response` (JSON body + `application/json; charset=utf-8`, `status | ResponseInit` init) so the wire format is byte-compatible.
  - `app/routes/app.settings.tsx`: RR7 also removed `unstable_parseMultipartFormData`/`unstable_createMemoryUploadHandler`; the CSV invoice upload now uses native `request.formData()` with an explicit 5MB `file.size` guard returning a graceful 422 (previously an oversize part threw). Vercel's platform body cap (~4.5MB) still bounds the request itself.
  - `entry.server.tsx`: `RemixServer` → `ServerRouter` (no `abortDelay` prop in RR7; the `streamTimeout + 1000` abort timer is preserved), `createReadableStreamFromReadable` from `@react-router/node`. The custom security-header logic is untouched.
- **Tests:** RR 7.18 makes `url`/`pattern` required on loader/action args and `data()` results are not `Response`s, so `app/lib/__tests__/_route-test-helpers.ts` adds two honest helpers: `routeArgs({request, params})` (derives `url` from the request like the framework does) and `toResponse(result)` (normalizes a `data()` result to the exact Response the HTTP layer would emit — status/headers/JSON body — passthrough for real Responses). ~40 test files updated mechanically to use them; five `vi.mock("react-router", ...)` factories became partial mocks (`importOriginal` spread) because the merged package means mocking UI hooks used to leave server APIs (`data`, `createCookie`, `redirect`) intact and now would not.

## 6. Remaining work + mandatory live verification before merge (human steps)

Local gates cannot catch hydration or proxy breakage. Before any merge:

1. **Preview deploy** the branch to Vercel (do not promote). Check the Vercel project's Framework Preset: it may still say "Remix" — the build already emits the same `build/server/nodejs_…` layout via `@vercel/react-router`, but confirm the preview builds and serves; switch the preset to React Router if Vercel misdetects. Re-alias vercel.app aliases if testing tenant storefronts.
2. **Hydration check in a real browser** (console open, zero hydration warnings, interactivity works) on every surface: embedded admin `/app` inside Shopify (note: the new provider now also loads Shopify's `polaris.js` web-components script alongside Polaris React — confirm no visual/JS conflicts, NavMenu works, one action submits); dashboard `/dashboard` (sign in + one mutation); a tenant storefront browse → add-to-cart → test checkout; `/oauth/authorize` connector page.
3. **Apex-proxy CSRF probe** (inherited from the 2.17 findings — RR7 contains the same Origin/x-forwarded-host action guard the 2.17.5 backport introduced): POST `calderyncompany.com/dashboard/signin` through the proxy and confirm no 500. If it 500s, the proxy must forward the original host.
4. **Wire probes on the preview:** `curl` a `.data` single-fetch URL (RR7 turbo-stream v3 format — starts differently from v2; just confirm 200 + client renders), `/__manifest` returns 204/200 normally and 400 for an oversized URL.
5. **Server-to-server POSTs:** replay one Shopify webhook, one ACP `checkout_sessions` POST, one MCP OAuth `token` call against the preview (resource routes kept real Responses, but verify end-to-end).
6. **Settings CSV upload smoke** (the one rewritten code path): upload a small invoice CSV in `/app/settings`, confirm ingest; try a >5MB file, expect the friendly 422.
7. **PR #257 security headers** still present on the preview (`curl -sI`).
8. Merge order: land PR #257 first, then decide whether #264 (2.17.5) ships as an interim or is superseded by this branch — they touch the same dependency surface and should not both merge; rebase whichever ships second and re-run the full gate.
9. Follow-up (not blocking): `npm start`/`docker-start` uses `react-router-serve ./build/server/index.js`, but the Vercel preset writes the server bundle to `build/server/nodejs_…/index.js` — same pre-existing quirk as with `@vercel/remix`; irrelevant on Vercel, fix only if local serving is ever needed. Track Shopify's package for RR8 support as the next (unforced) hop.
