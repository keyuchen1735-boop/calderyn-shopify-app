# Calderyn — Release Readiness

Maintained by the hourly release-readiness sweep. This is the shared brain across
runs: reconcile against it so findings are never duplicated. Status vocabulary:
`[NEW]` `[OPEN]` `[FIXED]` `[NEEDS-HUMAN]` `[WONTFIX]`.

## Summary

- **Last run:** 2026-06-11 06:43 UTC
- **Correctness gate:** GREEN — `npm ci` 0, `typecheck` 0, `lint` 0 (12 pre-existing
  warnings in untouched files), `build` 0, `npm test` 832 passed / 5 skipped (134
  files; +4 new `format.test.ts` cases this run).
- **Canonical check (pause → Recovered KPI):** PASS against live data (unchanged).
  Audit row `5af82d74…` (`pause_campaign`, succeeded, `dollar_impact_at_exec`=12861.94)
  equals `get_shop_stats.recovered_7d`=12861.94. Contract still closes on both surfaces.
- **Open bugs:** 1 code (F15 Predictor div-by-zero, latent/demo-only — guard before live);
  F12 (topAdNames embed shape, needs schema verification) + F6 (date-format, visual call)
  OPEN; F5 (meta-push idempotency gap) still OPEN.
- **Fixed this run:** 4 — F8 (screener `history.server` swallowed 6 Supabase errors →
  cold-start masking), F9 (ingest `backfill` terminal `sync_status` write unchecked →
  "completed but didn't"), F10 (ingest `mappers` NaN `source_version`), F11 (dashboard
  `format.money()` rendered `$NaN`). Gate green each; commits `89090a0`, `8bae8cf`,
  `e2989e4`, `1ce0c71`.
- **Needs human:** 4 (F1 cross-surface guardrail day-boundary, F2 demo-config check,
  F13 backfill inventory timeseries fabricated at run-time, F14 Predictor/Generator ship
  demo data labeled live with false "synced from Meta" copy — **gate before launch**).

## Coverage log

| Run (UTC) | Areas swept |
|---|---|
| 2026-06-11 03:37 | Correctness gate (full). Canonical pause→Recovered flow (live MCP + code: `recovered.ts`, `audit-impact.ts`, `actions/execute.server.ts`, `calderyn.server.ts` listAudit/undo/dailyUsed). Money path: `actions/reallocate.server.ts`, `actions/reallocation-suggest.server.ts`. UI code review: `routes/app._index.tsx` (home/stat row/focus), `lib/format.ts`. Unit-consistency audit of `dollar_impact*` across loader shaping. |
| 2026-06-11 04:38 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged). Rotation: `app/lib/actions/retry.server.ts` (drain/registry/compensator/backoff — found+fixed stale header F4) + `cron.action-retry.tsx`, `actions/autopilot.server.ts` (clean), `screener/meta-push.server.ts` (gap F5). UI code review: `routes/app.alerts.$id.tsx` + `app.alerts._index.tsx` (Polaris layout/copy/guardrail meter — clean). |
| 2026-06-11 05:45 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged) + traced dashboard read side (both surfaces use shared `recovered()`). Rotation: `attribution/*` (revenue/apply/match/parse), `meta/transform.ts`, `gdpr/sweep.server.ts`, `screener/*` (orchestrate/calibrate/image-gen-limit + E2E trace), `ingest/*` (found+fixed F7 in `transform.server.ts`; google/tiktok/quickbooks/meta-ingest scanned clean via sub-agent). UI code review: `routes/app.audit.tsx`, `app.campaigns._index.tsx`, `app.screener.tsx` (clean), `components/dashboard/*` (format/view-models/live + `Dashboard.tsx`/`Alerts.tsx` — found F6 raw `created_at` render). Unit check: `dollar_impact*` dollars→cents at `calderyn.server.ts:102,119` confirmed consistent with `fmtMoney`. |
| 2026-06-11 06:43 | Correctness gate (full, GREEN — 832 pass). Canonical pause→Recovered re-verified live (PASS, unchanged; audit `5af82d74…`=12861.94=`recovered_7d`). Rotation — **screener internals** `screener/{generate,score,score-one,meta-creative,higgsfield,history,runs,campaign-ads,pick-generator}.server.ts` (found+fixed F8 swallowed errors in `history`; F12 topAdNames embed-shape + F15 Predictor latent div-by-zero logged); **ingest/PO internals** `ingest/{backfill,dlq,enqueue,mappers,shopify-admin}.server.ts` + `po/{draft,pdf}.server.ts` (found+fixed F9 backfill terminal write + F10 mappers NaN `source_version`; F13 inventory-timeseries logged). UI code review: `components/dashboard/screens/{Analytics,Inventory,Settings,Generator,Predictor,Campaigns}.tsx` + `format.ts` (found+fixed F11 `money()` `$NaN`; F14 Predictor/Generator demo-data-as-live logged; Settings + Analytics/Inventory/Campaigns state-handling clean). |

**Not yet swept (rotate here next):** `app/lib/meta/{insights,ad-insights,oauth,oauth-state,actions,creatives,campaigns,client}.server.ts`, `app/lib/google/*` + `tiktok/*` + `quickbooks/*` adapter internals (sub-agent scanned for common bug classes 2026-06-11 05:45, clean — a deeper read still owed), `app/lib/ingest/{dlq,enqueue,shopify-admin}.server.ts` deeper read + cron.ingest routes, `cron.gdpr.tsx` + `webhooks.gdpr.tsx`, `app/lib/assistant/*` (anthropic/loop/prompt/tools/snapshot/conversations), `app/routes/oauth.*` + `mcp_oauth` (read-only review only — no auth edits), `app.skus.tsx` + `app.campaigns.$campaignId*` UI, `app.generator.tsx` route UI, `history.server.ts` topAdNames schema verification (F12). Swept this run: screener internals, ingest/po internals, dashboard screens.

## Findings

### [NEEDS-HUMAN] F1 — "Daily action budget used" disagrees across surfaces (app vs engine)
- **Where:** `app/lib/recovered.ts:47` (`dailyActionBudgetUsedCents`) + `app/lib/calderyn.server.ts:218` (`dailyUsedCents`, windows on `startOfUtcDayIso()`), vs the live engine/MCP `get_guardrails`.
- **Observed:** Live MCP `get_guardrails` → `daily_action_budget_used_cents: 0`, but a succeeded `pause_campaign` with impact $12,861.94 was executed 2026-06-11T00:03:10Z. At sweep time (03:37 UTC, same UTC day) the app's loader would include that row and report ~$12,861.94 used today — the engine reports 0.
- **Likely cause:** day-boundary mismatch. The app windows on **UTC** start-of-day; the shop's `business_hours.tz` is **America/New_York**, where 00:03Z = 2026-06-10 20:03 EDT (yesterday). If the engine enforces guardrails on the NY business-day, 0 is correct engine-side and the app's `recovered.ts` comment ("UTC, matching guardrail enforcement") is the wrong assumption.
- **Why not auto-fixed:** changes guardrail-enforcement semantics (which day a spend counts against) — a product/correctness decision, and the authoritative side lives in the separate engine/dashboard repo (out of reach). Per fix protocol: log, don't guess.
- **Ask for human:** confirm the canonical day boundary for the daily action budget (UTC vs merchant tz). Align both surfaces. Parity TODO for the dashboard/engine repo either way.

### [OPEN] F2 — Demo guardrail values look like non-prod seed config
- **Where:** live `get_guardrails`: `daily_action_budget_cents: 100000000` ($1,000,000/day), `dollar_cap_cents: 1000000000` ($10,000,000/action).
- **Note:** almost certainly the MCP tester shop's seed config, not a code path, but worth confirming the **production default guardrails** are sane before launch (a $1M/day action budget effectively disables the cap). No app code change implied; verify the seed/onboarding defaults.

### [WONTFIX] F3 — Reallocation grade window cap
- **Where:** `app/lib/actions/reallocation-suggest.server.ts:31` (`GRADE_ROWS_CAP = 1000`).
- **Note:** at very high campaign×day-bucket counts, a campaign's latest grade can fall outside the 1000-row window and drop it from reallocation candidacy. Explicitly acknowledged in-code as an accepted tradeoff (lines 27–30). Logged for visibility; revisit only if a shop's grade history scales past the cap.

### [FIXED] F4 — `retry.server.ts` header claimed the drain was INERT (it isn't)
- **Where:** `app/lib/actions/retry.server.ts:1-22` (module header).
- **Observed:** the header described a "SKELETON" with a registry that is "intentionally
  EMPTY", "replays NOTHING", and "must be INERT until executors are ported." But
  `EXECUTOR_REGISTRY` (lines 83-107) is fully populated (pause/resume/reduce/reallocate),
  the drain calls those replayers against the live per-shop adapter, and
  `cron.action-retry.tsx` runs it on a 15-min schedule. The header directly contradicted
  both the code and the cron route's own (accurate) header, and tests cover live replay.
- **Risk:** a maintainer trusting the header would believe the retry cron is a no-op when
  it actually executes live Meta/Google pause/budget actions — a dangerous misread for a
  launch-critical money path.
- **Fix:** rewrote the header to describe the real behavior (active replay; only
  executor-less kinds like `snooze_alert` are skipped untouched). Comment-only; no logic
  change. Gate: typecheck 0, lint 0 (touched file, `--max-warnings=0`), build 0, full
  suite 828 passed / 5 skipped earlier this run.

### [FIXED] F7 — ingest `transform.server.ts` swallowed Supabase `error` on 3 selects
- **Where:** `app/lib/ingest/transform.server.ts` — `applyOrder` sku_dim list (was ~132),
  `applyInventory` sku_dim + location_dim lookups (was ~75-86).
- **Observed:** these were the only three reads in the file that destructured `{ data }`
  without checking `error` (every other read/upsert throws on error). Worst case in
  `applyOrder`: a transient DB error returns `data: null` → empty variant→sku map →
  **every order line written with `sku_id = null` AND the webhook marked processed** →
  silent, unretried data corruption, indistinguishable from a genuinely absent SKU. In
  `applyInventory` an ignored error was mislabelled in the DLQ as "unresolved
  sku/location" instead of the real DB cause.
- **Fix:** check the error and `throw` (matches the file's existing `if (oErr) throw oErr`
  convention) so a real DB failure routes to the caller's DLQ/retry path. Behavior on a
  genuinely missing sku/location is unchanged. Webhook-plumbing internal (not
  user-visible) → exempt from dashboard parity per CLAUDE.md.
- **Gate:** `/code-review` [] (additive, convention-matching); typecheck 0; eslint
  `--max-warnings=0` on touched file 0; build 0; vitest ingest 24/24; full suite 828
  passed / 5 skipped. Commit `40e9af8`.

### [OPEN] F6 — dashboard renders raw ISO `created_at` in alert captions
- **Where:** `app/components/dashboard/screens/Dashboard.tsx:86` (FocusCard) and
  `app/components/dashboard/screens/Alerts.tsx:62, :166`.
- **Observed:** `AlertVM.created_at` is a raw DB timestamp (e.g.
  `2026-06-11T00:03:10.861256+00:00`, mapped verbatim at `calderyn.server.ts:104`) and is
  concatenated straight into the caption with no formatter. The prototype's `data.js`
  carried `created_at` as a pre-formatted display string, so the screens assume it is
  display-ready; wiring them to the live API broke that assumption. The dashboard's own
  `relTime()` helper takes **epoch ms**, not an ISO string, so it can't be dropped in
  as-is; demo alerts don't set `created_at` at all (would render `undefined`).
- **Why not auto-fixed:** the right replacement is a UX/visual call (relative "2h ago" vs
  absolute date) and needs a new ISO-aware formatter wired across 3 sites + a demo-safe
  fallback — beyond a clear one-line fix, and "needs a visual eye" per the Job-3 rule.
- **Ask for human:** pick the format; then add e.g. `relTimeFromIso(iso)` to
  `components/dashboard/format.ts` and use it at the 3 sites (guard empty/undefined).

### [OPEN] F5 — meta-push idempotency record is best-effort after ad creation
- **Where:** `app/lib/screener/meta-push.server.ts:131-161`.
- **Observed:** the Meta ad is created first, then the `action_audit` + `action_idempotency`
  rows are written best-effort inside a try/catch that swallows failures. If the
  idempotency insert fails (or the audit insert returns no id), a later re-push of the same
  (run, variant) finds no `priorAuditId` and creates a **duplicate paused ad** on Meta —
  contradicting the file's "never create a duplicate ad" guarantee.
- **Why not auto-fixed:** the ordering is inherent (Meta must mint the ad id before we can
  record it), so a real fix needs a design call — pre-reserve the idempotency key before the
  POST, or reconcile duplicates — not a one-line change. Low severity (ads are created
  PAUSED behind a UI confirm), so logged rather than guessed.

### [FIXED] F8 — screener `history.server.ts` swallowed Supabase `error` on 6 calibration reads
- **Where:** `app/lib/screener/history.server.ts` — `loadCalibrationInputs` reads for spend,
  engagement, grades, top-ad-names, sku lookup, order lines (was ~149-214).
- **Observed:** each read destructured only `.data` with a `?? []`/`?? null` fallback and
  never checked `.error`. supabase-js returns `{ data: null, error }` WITHOUT throwing, so a
  real DB failure was indistinguishable from a genuinely empty account: the cold-start
  fallback constants (`DEFAULT_BASELINE_CTR`, `DEFAULT_AOV_CENTS`, …) were silently
  substituted and the screener produced confident-looking ROAS/grade numbers off defaults
  while the DB error went completely unsurfaced (rule-12; same class as F7).
- **Fix:** `if (X.error) throw X.error` after each read. Preserves cold-start semantics
  exactly (empty account → `{ data: [], error: null }` still degrades); only the DB-error
  path changes from silent-degrade to fail-loud. The sole caller (`orchestrate.server.ts:57-82`)
  wraps this in try/catch and marks the run `error`, so a thrown failure degrades safely to a
  failed run. Advisory estimate path (ads created PAUSED behind UI confirm) — exempt from
  dashboard parity (internal). **Gate:** typecheck 0; eslint `--max-warnings=0` 0; build 0;
  vitest screener+ingest 140/140; full suite 832/5-skip. Commit `89090a0`.

### [FIXED] F9 — ingest `backfill.server.ts` terminal `sync_status="ready"` write unchecked
- **Where:** `app/lib/ingest/backfill.server.ts` (was ~118-127).
- **Observed:** the final `shop_integrations` update marking the backfill `ready` was the only
  write in the try block that didn't check its returned `error` (the order_fact/order_line_fact
  upserts both `if (err) throw err`). If that terminal write failed, backfill returned success
  while the shop stayed stuck `pending`/`error` — a "completed but actually didn't" bug
  breaking the file's own invariant.
- **Fix:** capture `{ error: readyErr }` and throw; a failure now routes into the existing
  catch (DLQ + status="error" + rethrow). Re-running backfill is idempotent (onConflict upserts),
  so the retry path is safe. Webhook/sync plumbing (internal) — exempt from parity. **Gate** as
  above. Commit `8bae8cf`.

### [FIXED] F10 — ingest `mappers.server.ts` NaN `source_version` on timestamp-less order webhook
- **Where:** `app/lib/ingest/mappers.server.ts` `parseOrderWebhook` (line 167).
- **Observed:** `String(p.updated_at ?? p.created_at)` yields `"undefined"` → `Date.parse` →
  `NaN` → `source_version: NaN`, corrupting last-writer-wins comparisons. The sibling
  `parseInventoryWebhook` (line 122) already guards with `?? new Date().toISOString()`.
- **Fix:** add the same `?? new Date().toISOString()` fallback. Low severity (Shopify normally
  sends both timestamps). **Gate** as above. Commit `e2989e4`.

### [FIXED] F11 — dashboard `format.money()` rendered `$NaN` for non-finite input
- **Where:** `app/components/dashboard/format.ts` `money()` / `moneyK()`.
- **Observed:** typed `number`, but live rows can carry a missing/partial amount coerced to
  null/undefined/NaN, rendering `$NaN`/`-$NaN` to the merchant (campaign with no budget, alert
  with missing impact).
- **Fix:** `if (!Number.isFinite(cents)) return "$0"` guard; `moneyK` delegates to `money` on
  NaN so one guard covers both. Real values untouched. Added `format.test.ts` (+4 cases) locking
  the guard + existing formatting. **Gate:** typecheck 0; eslint 0; build 0; full suite 832/5-skip
  (+4 new). Commit `1ce0c71`.

### [OPEN] F12 — screener `history.server.ts` `topAdNames` embed shape likely wrong (feature silently degraded)
- **Where:** `app/lib/screener/history.server.ts` (`ad_engagement_fact` → `ad_campaign_dim(name)` read).
- **Observed:** PostgREST embedded resources are frequently returned as an **array**
  (`ad_campaign_dim: [{ name }]`), not an object. The map reads `r.ad_campaign_dim?.name`,
  which is `undefined` for every row if the embed resolves as an array → `topAdNames` always
  `[]`, silently disabling the "compare against the merchant's top historical ads" signal in the
  scorer prompt. Also the rows aren't ordered/limited by an engagement metric, so even in the
  happy path these are the first-50-arbitrary ads, not the *top* ads.
- **Why not auto-fixed:** depends on the actual FK cardinality in the (out-of-reach) schema —
  needs verification, and the order/limit is a small design call. Verify embed shape against the
  Supabase schema, then normalize (`Array.isArray` unwrap) + add an engagement `order`/`limit`.

### [NEEDS-HUMAN] F13 — backfill fabricates the inventory time series at run-time
- **Where:** `app/lib/ingest/backfill.server.ts` (inventory rows: `observed_at`/`source_version`
  set from the single backfill-run timestamp, not Shopify's actual stock-change time).
- **Observed:** every inventory fact in a run lands at backfill time rather than when stock
  actually changed, so the inventory fact's time series is fabricated (all points at one
  instant). Not a crash; a data-fidelity issue feeding days-of-cover / reorder timing.
- **Why not auto-fixed:** Shopify's bulk inventory query doesn't expose per-level `updatedAt`, so
  there's no trivial fix — needs a design call (bulk-ops API, or accept the limitation explicitly).

### [NEEDS-HUMAN] F14 — Predictor & Generator dashboard screens render demo data as live (false "synced from Meta" copy)
- **Where:** `app/components/dashboard/screens/Predictor.tsx` (imports `SCORECARD` from `../demo`;
  hardcoded composite 58 / ROAS band / "Or pick a live ad" list at ~242-253 with copy "Pulled from
  Meta — creatives sync automatically"; toast hardcodes "composite 58, grade Okay" ~164) and
  `Generator.tsx` (hardcoded advertiser "Peak & Pine Outfitters" ~79; toast "best scores 74 (+16)"
  ~193; whole `run()` is a `setTimeout` simulation).
- **Observed:** both screens are flagged `// SIMULATED` / `TODO(other-agent): replace with live
  predictor API`, so the demo state is *known* — but for launch a merchant reading fabricated
  scores/ROAS with a false "synced from Meta" claim is a credibility risk.
- **Ask for human:** gate these screens behind a clear "Preview/Demo" affordance (or keep them
  hidden) until the live predictor/generator API lands. Product/visual decision, not a code fix.
  Parity TODO for the dashboard repo.

### [OPEN] F15 — Predictor.tsx ROAS-band div-by-zero (latent; demo-only today)
- **Where:** `app/components/dashboard/screens/Predictor.tsx` (band marker ~99,107:
  `(estimatedRoas - roasLow) / (roasHigh - roasLow)`; `GroupScores` avg ~59: `reduce(...) / ms.length`).
- **Observed:** when `roasLow === roasHigh` (degenerate band — a SKU with no history) the marker
  `left` becomes `Infinity%`/`NaN%`; an empty metric group renders `avg NaN`. Currently masked
  because the screen renders demo `SCORECARD` data, but it's slated to go live (see F14).
- **Why not auto-fixed:** the screen is demo-only and being replaced (F14); guarding live math is
  cheap but should land with the live-API wiring, not against throwaway demo data. Guard the
  denominator (`Math.max(ε, roasHigh - roasLow)`) and `ms.length === 0` when this goes live.

## Fixed this cycle

- **F8** — screener `history.server.ts`: 6 calibration reads now surface Supabase `error` instead
  of swallowing it into cold-start defaults. Commit `89090a0`.
- **F9** — ingest `backfill.server.ts`: terminal `sync_status="ready"` write now checks its error
  (no more "completed but didn't"). Commit `8bae8cf`.
- **F10** — ingest `mappers.server.ts`: order-webhook `source_version` falls back to now instead of
  `NaN` when both timestamps are absent. Commit `e2989e4`.
- **F11** — dashboard `format.money()`: non-finite input renders `$0`, not `$NaN`; +4 test cases.
  Commit `1ce0c71`.

_(Prior cycles: F7 — ingest `transform.server.ts` 3 swallowed selects; F4 — `retry.server.ts` stale
"INERT skeleton" header.)_

## Needs human

- **F1** — canonical day boundary for daily action budget (UTC vs merchant tz); engine/app disagree. Parity TODO for dashboard/engine repo. **← most important.**
- **F14** — Predictor/Generator dashboard screens render demo data as live with false "synced from Meta" copy; gate behind a Preview/Demo affordance before launch (credibility risk). Parity TODO for dashboard repo.
- **F13** — backfill fabricates the inventory time series (all points at run-time, not actual stock-change time); design call (bulk-ops API or accept limitation).
- **F2** — confirm production default guardrails (current MCP shop shows $1M/day budget, $10M/action cap — likely seed only).
- **F6** — choose display format for dashboard alert timestamps (raw ISO currently shown); low-risk once the format is decided. file:line in F6 above.
