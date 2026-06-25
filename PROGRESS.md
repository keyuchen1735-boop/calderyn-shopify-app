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
- [ ] 2b — `cut_ads` cross-platform: loosen Meta-only gate (`enrich.server.ts` ~97) so pause/reduce
  enriches for any platform with a live adapter; keep reallocate Meta-only. _Test: Google/TikTok loser → executable cut button._
- [ ] 2c — Scale-opportunity card (`app/routes/app.campaigns.$campaignId.tsx` ~606-626): text →
  real `apply_direction` button (parity with dashboard `Campaigns.tsx`). _Test: card posts `increase_campaign_budget`._

### WS3 — New executors (Tier 3)
- [ ] 3a — `exclude_sku_from_campaign` (marquee / the screenshot). New ActionKind (`app/lib/types.ts`)
  + executor-union member (`app/lib/remediation/types.ts`) + gateway executor
  `app/lib/actions/exclude-sku-campaign.server.ts` mirroring `reallocate-sku.server.ts`
  (re-derive from trusted alert via enrich, ownership, idempotency, ONE `action_audit` row) +
  `excludeProduct()` on `ActionAdapter` (`app/lib/ads/actions.ts`) + Meta impl
  (`app/lib/meta/actions.server.ts`, see Decision locked) + flip `enrich.server.ts:94-96` shared
  branch to this executor + dispatch in `dashboard.api.alerts.$id.action.tsx` and
  `app.alerts.$id.tsx` + dashboard parity. _Test: shared-Advantage+ alert → executable button →
  adapter call → audit row; unsupported platform/creds → ActionError, no phantom._
- [ ] 3b — `exclude_geo` executor: Meta `excluded_geo_locations` (adset) + Google geo-criteria
  adapter method; route via `executeAction`; replace the phantom; both surfaces.
- [ ] 3c — `reallocate_budget` one-click: endpoint reusing `executeReallocation` + enrich-resolved
  loser/winner; both surfaces.

### WS4 — Advisory + deep-link (no-API rows)
- [ ] 4a — Add a deep-link treatment to advisory rows on both surfaces (embedded: App Bridge nav;
  dashboard: link primitive + `CDIcon`). _Test: a deep-link row renders an anchor/nav control, not bare text._
- [ ] 4b — `fix_returns` → reason + deep-link (product returns/analytics); free-ship pair → reason +
  deep-link (Shopify shipping settings); remaining ineligible branches (no winner / no variant /
  no sku) → reason + appropriate deep-link.

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

## Iteration log
(append one line per completed slice: `<slice id> — <commit sha> — <one-line behavior verified>`)
- 1a — app.alerts.$id action: unwired kinds (exclude_geo / free-ship / increase_budget) now throw 422 instead of phantom "succeeded"; snooze/reallocate_inventory/create_po_draft still record real work. Verified by alert-action-calibration test "does NOT phantom-succeed for a kind with no wired executor (rule 12)". 62 related tests green.
- 1b — e40ea6a — enrich: winner-query failure no longer discards an already-enriched cut_ads button (catch falls back to `enriched`, not `plan`).
- 1c — enrich.advisory() now patches cut_ads too + no_sku_key returns advisory; rank fix_returns carries a standing reason. Invariant verified: no move renders executor===null with empty ineligibleReason. Full suite 2555 passed / 0 failed.
- 2a — increase_campaign_budget now a real button on BOTH surfaces: embedded executableKinds + scaled-budget compute (current*(1+pct/100)); dashboard allowlist detector-gated (scaling alert recommends increase, not pause) + DashboardApp executeAction increase branch + dashboard ActionKind union. Verified embedded (alert-action-calibration) + dashboard availability (adapt-alert). Full suite 2557 / 0 failed, tsc clean. Note: DashboardApp.executeAction has no render harness; budget formula is the tested embedded one mirrored.
