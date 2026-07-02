# Remix security-upgrade scoping — clearing the pinned-framework High

_Companion to `docs/security-audit-2026-07-02-user-side.md`. This is a scoping/decision doc, not an executed change._

## The problem

`@vercel/remix` is abandoned at **2.16.7** and declares **exact-version** peer deps on `@remix-run/dev|node|server-runtime@2.16.7`. Because we depend on it, we cannot take the Remix **2.17.5** security line. That single pin is the root cause of the audit's one **High** and two of its **Mediums**:

| Advisory | Enabled by | Reachable here |
|---|---|---|
| `__manifest` unbounded path expansion DoS (GHSA-8x6r-g9mw-2r78) | `v3_lazyRouteDiscovery: true` (`vite.config.ts`) | Yes — `/__manifest` is live and unauthenticated |
| turbo-stream single-fetch reflected DoS (GHSA-rxv8-25v2-qmq8) | `v3_singleFetch: true` | Yes — all loader data flows through turbo-stream 2.4.1 |
| Router XSS-via-open-redirect + action CSRF (GHSA-2w69-qvjg-hvjx, GHSA-h5cw-625j-3rxh) | cookie-auth dashboard | Mitigated in-app (`safeDashboardReturnTo`, `requireSameOrigin`, SameSite=Lax) but the framework fix is blocked |

Note: the two npm-audit **critical** advisories (file-session-storage path traversal) do **not** apply — we use Prisma session storage, not `createFileSessionStorage`. Verified in the audit.

**Constraint that makes this non-trivial:** overriding Remix internals past the adapter cap has broken SSR hydration app-wide before (see memory `vercel-remix-version-cap`, `turbo-stream-override-broke-hydration`). So this needs a real, verified migration — never a blind version bump.

## Options

### A. Override just the runtime packages to 2.17.5 (cheapest, riskiest)
Add `overrides` forcing `@remix-run/server-runtime` + `@remix-run/react` (and their shared `turbo-stream`, `@remix-run/router`) to 2.17.5 while leaving `@vercel/remix@2.16.7` in place.
- **Pro:** smallest diff; directly closes the advisories.
- **Con:** exactly the move that broke hydration before. `@vercel/remix`'s build preset expects 2.16.7 internals; a minor mismatch in the server build/manifest can silently kill hydration. High regression risk, needs the full live-verify below.
- **Effort:** 0.5–1 day if it works, open-ended if hydration breaks.

### B. Drop `@vercel/remix`; use plain Remix + Vercel build output (recommended)
Remove the adapter, move to `@remix-run/dev` 2.17.5 with the standard Vercel deployment (Remix's built-in Vercel support / the `@vercel/remix` successor path, or a small `vercel.json`-driven build). Upgrade all `@remix-run/*` to 2.17.5 together.
- **Pro:** removes the frozen dependency entirely — the structural dead-end goes away, and future patches are takeable. Keeps Remix 2.x (no route/API rewrite).
- **Con:** must reproduce whatever `@vercel/remix` did for the Vercel serverless build (regions, the `nodejs-eyJ…` server bundle layout, streaming). Some deployment-config work.
- **Effort:** 2–4 days incl. a preview deploy and the live-verify.

### C. Migrate to React Router v7 (largest, most durable)
RR7 is the continuation of Remix; 2.17.x is a stepping stone. Framework mode maps closely to Remix 2.x.
- **Pro:** lands on the actively-maintained line; all these advisories are fixed and stay fixed.
- **Con:** import renames across the app (`@remix-run/*` → `react-router`), config changes, and full re-verification of every route family (admin, dashboard, storefront, oauth, acp). Biggest surface.
- **Effort:** 1–2 weeks.

## Recommendation

**Pursue B (drop `@vercel/remix`, upgrade to 2.17.5) in an isolated worktree, with A as a 1-hour spike first.** Spike A to see whether the app even hydrates with the override; if it does and the preview deploy is clean, A may be an acceptable interim. If A breaks hydration (likely, per history), proceed with B. Treat C as the eventual destination once B buys breathing room.

Either way this is its own feature branch/worktree (`feat/remix-2.17-upgrade`), never mixed with other work, per the repo's feature-isolation rule.

## Interim mitigation (do regardless, cheap)

Until the upgrade ships, blunt the one externally-exploitable item — the `__manifest` DoS — at the edge: add a Vercel WAF/edge rule (or a lightweight middleware) that rejects `/__manifest` requests whose `p` query param count/size is abnormally large. This does not need the Remix bump and removes the only unauthenticated live exploit path; the turbo-stream/router items are lower-reachability and wait for the upgrade.

## Verification gate (mandatory for the upgrade PR — history demands it)

Typecheck/lint/build/tests are necessary but **not sufficient** — the past breakage was hydration, which those don't catch. Before merge:

1. Preview-deploy the branch to Vercel (not just a local build).
2. Load each surface in a real browser and confirm **hydration** (no console hydration errors, interactivity works): embedded admin (`/app`, inside Shopify), dashboard SPA (`/dashboard`), a tenant storefront + checkout, and an `/oauth/authorize` connector page.
3. Confirm single-fetch `.data` requests and `/__manifest` still return correctly.
4. `curl -sI` the live preview to confirm the security headers from PR #257 still land.
5. Re-run `npm audit --omit=dev` and confirm the `__manifest` / turbo-stream / router advisories are cleared.

## Next steps

1. Spike option A in a throwaway worktree (~1h): add the overrides, `npm run build`, preview-deploy, check hydration. Decision point.
2. If A fails → execute B on `feat/remix-2.17-upgrade`.
3. Ship the `__manifest` edge mitigation now, independent of the upgrade.
4. Schedule C (React Router 7) as a dated follow-up once B is live.
