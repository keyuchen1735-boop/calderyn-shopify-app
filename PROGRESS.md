# Feature: actionable-remediation

**Goal:** Every remediation/alert action row on BOTH Calderyn surfaces is either a real
executing button, a real deep-link, or honest advisory-with-reason. **Zero bare labels,
zero phantom "succeeded".**

**Surfaces (parity is mandatory — part of every slice, not a follow-up):**
- Embedded admin: `app/routes/app.*` — Polaris + `@shopify/polaris-icons` (NOT Lucide).
- Dashboard: `app/components/dashboard/*` + `app/routes/dashboard.*` — `CDIcon` registry (`app/components/dashboard/icons.tsx`).

**Root cause (from census):** actions are structured `StrategicMove`/`ActionKind`; both
surfaces already render a Button when an executor is bound, else advisory text. The bugs
are: (1) embedded `actions.execute` legacy stub reports phantom success for unwired kinds;
(2) several advisory rows are bare labels with no reason; (3) some executors exist but
aren't wired to the alert surface; (4) some kinds have no executor at all.

---

## Method (TDD vertical slices — `tdd` skill)
Per iteration: read this file + `git log --oneline -15`; do the **next unchecked slice only**:
one failing behavior test → minimal code to pass → refactor → check the box here → commit.
Test names describe behavior, use public interfaces, survive refactor (rule 9).
Mirror existing patterns in `app/lib/remediation/__tests__`, `app/routes/__tests__`.

## Hard rules
- Never write `outcome:"succeeded"`/ack for an action that did no real work (rule 12).
- New executors **fail visibly** (`ActionError`) when unsupported / creds not connected — never phantom.
- No `any` without written justification; never narrow types to silence `tsc`; no `eslint-disable`.
- Every behavior/UI change mirrored on **both** surfaces.
- Per slice: new test green **and** existing suite still green. Commit each green slice
  (`git add -A && git commit`, subject references the module). Do **not** push / open PR.

## Decision locked (3a)
Build a new `excludeProduct()` on the Meta adapter calling **Meta Graph** product-set/
catalog exclusion, reusing the existing decrypted token (`metaActionAdapterForShop`).
Use the **meta-ads MCP tool schemas** (`create_product_set` / `update_adset` /
`update_catalog_product`) via `ToolSearch` as the exact param spec — **do not call them**.
Google/TikTok adapters throw non-retriable `ActionError`. User connects creds; method
must fail visibly if a shop's campaign type doesn't support per-SKU exclusion.

---

## Backlog

### WS1 — Stop the lies (highest priority; active rule-12 violations)
- [x] 1a — Gate legacy `actions.execute` (`app/lib/calderyn.server.ts` ~810-825): unwired kinds
  (`exclude_geo`, `raise_free_ship_threshold`, `exclude_sku_free_ship`, `increase_campaign_budget`)
  must NOT write `succeeded`/ack — throw visible error / route to deep-link. Real-work kinds
  (`reallocate_inventory`, `create_po_draft`) unaffected. _Test: those kinds write no succeeded row, no ack._
- [x] 1b — `enrich.server.ts` ~158-161 catch falls back to `enriched`, not `plan` (preserve an
  already-built `cut_ads` button when the winner query throws). _Test: winner throw after cut_ads enriched → cut_ads stays executable._
- [x] 1c — `advisory()` patches BOTH moves; `fix_returns` + `no_sku_key` always carry an
  `ineligibleReason`. _Invariant test: no StrategicMove renders `executor===null && !ineligibleReason`._

### WS2 — Wire executors that already exist (both surfaces)
- [x] 2a — `increase_campaign_budget` executable on alert surface: add to `executableKinds`
  (`app/routes/app.alerts.$id.tsx` ~448) + compute `dailyBudgetCents` from evidence; dashboard
  allowlist (`app/lib/dashboard/client.ts` ~166-172) + `executeAction` branch (`DashboardApp.tsx`).
  _Test: scale alert → real `executeAction(increase_campaign_budget)`, not phantom; both surfaces._
- [x] 2b — `cut_ads` cross-platform: loosen Meta-only gate (`enrich.server.ts` ~97) so pause/reduce
  enriches for any platform with a live adapter; keep reallocate Meta-only. _Test: Google/TikTok loser → executable cut button._
- [x] 2c — Scale-opportunity card (`app/routes/app.campaigns.$campaignId.tsx` ~606-626): text →
  real `apply_direction` button (parity with dashboard `Campaigns.tsx`). _Test: card posts `increase_campaign_budget`._

### WS3 — New executors (Tier 3)
- [x] 3a — DEFERRED by decision (2026-06-25, "deep-link now, executor later"). VERIFIED data gap:
  this repo's schema has NO shared-campaign external id and NO Meta catalog/retailer mapping
  (grep across `supabase/migrations` + `engine`; `v_sku_remediation_inputs.dedicated_campaign_id`
  is null for the shared case). A one-click exclude executor cannot function until the engine
  exposes that data, so building it now would be a dead button (rule 12). **Treatment instead:**
  shared-Advantage+ → advisory + real deep-link to Meta Ads Manager, delivered in **4b**.
  Real executor scope captured under "Deferred follow-ups" below.

### WS4 — Advisory + deep-link (no-API rows) — foundation + screenshot fix; DO THESE NEXT
- [x] 4a — Add a deep-link treatment to advisory rows on both surfaces: a move/row may carry a
  `deepLink` (label + href/target); embedded uses App Bridge nav (or external `<a>` for Meta/Shopify
  admin URLs), dashboard uses its link primitive + `CDIcon`. _Test: a row with a deepLink renders an
  anchor/nav control, not bare text._
- [x] 4b — Apply remaining deep-links. SCOPED (2026-06-25):
  - DONE in 4a: shared-Advantage+ → Meta Ads Manager deep-link.
  - ALREADY satisfy the goal (honest advisory-with-reason from 1c): `fix_returns`, no-winner,
    no-variant, no-sku branches. Deep-links optional polish — NOT required; skip unless cheap.
  - REAL remaining violation = **free-ship** (`raise_free_ship_threshold` / `exclude_sku_free_ship`
    on `free_shipping_leakage`): embedded renders execute buttons that now 422 (post-1a); dashboard
    drops them (snooze-only) — rule-7 inconsistency. FIX both surfaces: render as advisory + a real
    deep-link to Shopify shipping settings. Mechanism: `useEmbeddedNavigate` only handles in-app
    paths, so use a FULL external URL `https://admin.shopify.com/store/<handle>/settings/shipping`
    (new tab), thread the shop handle (handle = session.shop minus ".myshopify.com") to both
    components. Embedded: extend `DEEP_LINK_ACTIONS` to allow external URLs + render `<Button url
    external>`; remove free-ship from the execute path. Dashboard: surface free-ship as advisory +
    deep-link (currently filtered out in `adaptAlert`). _Test: free-ship action resolves to a
    deep-link/advisory, never a 422 execute; both surfaces._

### WS3 remaining — buildable executors (after deep-links)
- [ ] 3c — `reallocate_budget` one-click: endpoint reusing `executeReallocation` + enrich-resolved
  loser/winner (data EXISTS — dedicated campaigns); both surfaces. Genuinely buildable now.
- [x] 3b — `exclude_geo`: FIRST verify data (adset external id + current geo targeting). If present,
  build the Meta `excluded_geo_locations` (update_adset) executor + both surfaces. If absent
  (same gap class as 3a), apply the deep-link treatment (4b pattern) + a deferred follow-up — do
  NOT build a dead button.

---

## Completion (only when EVERY box above is checked)
Run the full pre-commit gate **in this worktree** and paste results:
1. `npx tsc --noEmit` → exit 0
2. `npm run lint` → exit 0
3. `npm run build` → exit 0
4. `npx prisma validate` (only if `prisma/schema.prisma` changed)

Then, and only if all green, output exactly:
`<promise>REMEDIATION ACTIONS ALL EXECUTABLE OR HONEST</promise>`

If any gate fails: fix the root cause. Do NOT `--no-verify`, do NOT emit the promise.

## Deferred follow-ups (NOT in this PR — documented, not silently skipped per rule 12)
- **exclude_sku_from_campaign executor (real 3a).** Build once the engine/view exposes the
  shared campaign external id + the SKU→Meta-catalog `retailer_id` mapping. Then: add ActionKind +
  executor-union member, `excludeProduct()` on `ActionAdapter` + Meta Graph impl (product-set /
  catalog exclusion, fail-visible via `ActionError`), gateway `exclude-sku-campaign.server.ts`
  mirroring `reallocate-sku.server.ts`, flip the `enrich.server.ts` shared branch from deep-link
  to the executor, dispatch on both surfaces. Interim treatment (deep-link) ships in 4b.

## Iteration log
(append one line per completed slice: `<slice id> — <commit sha> — <one-line behavior verified>`)
- 1a — app.alerts.$id action: unwired kinds (exclude_geo / free-ship / increase_budget) now throw 422 instead of phantom "succeeded"; snooze/reallocate_inventory/create_po_draft still record real work. Verified by alert-action-calibration test "does NOT phantom-succeed for a kind with no wired executor (rule 12)". 62 related tests green.
- 1b — e40ea6a — enrich: winner-query failure no longer discards an already-enriched cut_ads button (catch falls back to `enriched`, not `plan`).
- 1c — enrich.advisory() now patches cut_ads too + no_sku_key returns advisory; rank fix_returns carries a standing reason. Invariant verified: no move renders executor===null with empty ineligibleReason. Full suite 2555 passed / 0 failed.
- 2a — increase_campaign_budget now a real button on BOTH surfaces: embedded executableKinds + scaled-budget compute (current*(1+pct/100)); dashboard allowlist detector-gated (scaling alert recommends increase, not pause) + DashboardApp executeAction increase branch + dashboard ActionKind union. Verified embedded (alert-action-calibration) + dashboard availability (adapt-alert). Full suite 2557 / 0 failed, tsc clean. Note: DashboardApp.executeAction has no render harness; budget formula is the tested embedded one mirrored.
- 2b — e18b6a6 — enrich: non-Meta dedicated loser keeps an executable cut_ads (pause/reduce, platform-blind via executeAction); only reallocate stays Meta-gated.
- 2c — campaigns scale-opportunity card: plain-text "scale from the list" → real apply_direction Form button posting increase_campaign_budget + scale.newBudgetCents (own fetcher + banner), parity with dashboard Campaigns scale button. apply_direction+increase contract already covered by campaign-direction-action.test.ts (no brittle JSX render test, rule 9). tsc clean, full suite 2558/0.
- 4a — deep-link infra: StrategicMove.deepLink field (server-set, like ineligibleReason) rendered as a link on BOTH surfaces (embedded Polaris Button url/external; dashboard <a> + CDIcon arrowUpRight). Shared-Advantage+ branch (the screenshot) now carries a real Meta Ads Manager deep-link → advisory rows are actionable, not dead text. Behavior-tested in enrich.test.ts (deepLink.href matches adsmanager.facebook.com). tsc clean, full suite 2559/0. NOTE: this already delivers 4b's shared-Advantage+ item.
- 4b — free-ship advisory→deep-link on BOTH surfaces. New shared pure helper app/lib/action-deeplinks.ts (shopifyAdminUrl + actionDeepLink + hasActionDeepLink), tested. Embedded: free-ship kinds render an external Shopify "Open Shipping settings" link (Button url/external) instead of the 422 execute path (shop via useRouteLoaderData). Dashboard: AlertVM.deepLinkKinds (pure, from adaptAlert) + DashboardCtx.shopDomain + AlertDetail renders deep-link anchors (was hidden→snooze-only). fix_returns + no-winner/variant/sku already satisfy goal as advisory-with-reason (1c) — left as-is. tsc clean; full suite 2565/0 (2 consecutive green runs; one earlier transient flake did not reproduce).
- 3b — exclude_geo → deep-link (both surfaces), reusing 4b infra. VERIFIED same data-gap class as 3a (no adset dim / per-region exclusion data in schema), so per the "deep-link now, executor later" decision it deep-links to Ads Manager rather than a dead button. One actionDeepLink case auto-flows to embedded (dedupedAllowedActions) + dashboard (deepLinkKinds). Fixes the post-1a 422 on the embedded exclude_geo button. tsc clean; full suite 2567/0.
- **exclude_geo real executor (3b).** Build once an adset dim + current-geo-targeting data exist: Meta excluded_geo_locations (update_adset) adapter method + executor, Google geo criteria, both surfaces. Interim = Ads Manager deep-link (shipped).
