# Calderyn — Release Readiness

Maintained by the hourly release-readiness sweep. This is the shared brain across
runs: reconcile against it so findings are never duplicated. Status vocabulary:
`[NEW]` `[OPEN]` `[FIXED]` `[NEEDS-HUMAN]` `[WONTFIX]`.

## Summary

- **Last run:** 2026-06-11 05:45 UTC
- **Correctness gate:** GREEN — `npm ci` 0, `typecheck` 0, `lint` 0 (12 pre-existing
  warnings in untouched files), `build` 0, `npm test` 828 passed / 5 skipped (134
  files).
- **Canonical check (pause → Recovered KPI):** PASS against live data (unchanged).
  Audit row `5af82d74…` (`pause_campaign`, succeeded, `dollar_impact_at_exec`=12861.94)
  equals `get_shop_stats.recovered_7d`=12861.94. Both dashboard surfaces
  (`Dashboard.tsx:270`, `Audit.tsx:97`) confirmed to use the shared `recovered()` —
  contract closes on both sides.
- **Open bugs:** 0 code bugs (F6 dashboard date-format logged OPEN, needs visual call).
  1 low-severity gap logged (F5, meta-push idempotency).
- **Fixed this run:** 1 — F7, ingest `transform.server.ts` swallowed Supabase
  `error` on 3 select queries (silent null-sku order-line corruption + masked DLQ
  cause). Gate green, commit `40e9af8`.
- **Needs human:** 3 (cross-surface guardrail discrepancy F1, demo-config check F2,
  dashboard raw-`created_at` format F6).

## Coverage log

| Run (UTC) | Areas swept |
|---|---|
| 2026-06-11 03:37 | Correctness gate (full). Canonical pause→Recovered flow (live MCP + code: `recovered.ts`, `audit-impact.ts`, `actions/execute.server.ts`, `calderyn.server.ts` listAudit/undo/dailyUsed). Money path: `actions/reallocate.server.ts`, `actions/reallocation-suggest.server.ts`. UI code review: `routes/app._index.tsx` (home/stat row/focus), `lib/format.ts`. Unit-consistency audit of `dollar_impact*` across loader shaping. |
| 2026-06-11 04:38 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged). Rotation: `app/lib/actions/retry.server.ts` (drain/registry/compensator/backoff — found+fixed stale header F4) + `cron.action-retry.tsx`, `actions/autopilot.server.ts` (clean), `screener/meta-push.server.ts` (gap F5). UI code review: `routes/app.alerts.$id.tsx` + `app.alerts._index.tsx` (Polaris layout/copy/guardrail meter — clean). |
| 2026-06-11 05:45 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged) + traced dashboard read side (both surfaces use shared `recovered()`). Rotation: `attribution/*` (revenue/apply/match/parse), `meta/transform.ts`, `gdpr/sweep.server.ts`, `screener/*` (orchestrate/calibrate/image-gen-limit + E2E trace), `ingest/*` (found+fixed F7 in `transform.server.ts`; google/tiktok/quickbooks/meta-ingest scanned clean via sub-agent). UI code review: `routes/app.audit.tsx`, `app.campaigns._index.tsx`, `app.screener.tsx` (clean), `components/dashboard/*` (format/view-models/live + `Dashboard.tsx`/`Alerts.tsx` — found F6 raw `created_at` render). Unit check: `dollar_impact*` dollars→cents at `calderyn.server.ts:102,119` confirmed consistent with `fmtMoney`. |

**Not yet swept (rotate here next):** `app/lib/screener/{generate,score,score-one,meta-creative,higgsfield,history,runs,campaign-ads,pick-generator}.server.ts` + `app.generator.tsx` UI, `app/lib/meta/{insights,ad-insights,oauth,oauth-state,actions,creatives,campaigns,client}.server.ts`, `app/lib/google/*` + `tiktok/*` + `quickbooks/*` adapter internals (sub-agent scanned for the common bug classes 2026-06-11 05:45 and found them clean — a deeper read still owed), `app/lib/ingest/{backfill,dlq,enqueue,mappers,shopify-admin}.server.ts` + cron.ingest routes, `cron.gdpr.tsx` + `webhooks.gdpr.tsx`, `app/components/dashboard/screens/{Analytics,Inventory,Settings,Generator,Predictor,Campaigns}.tsx` UI, `app/lib/po/*`, `app/lib/assistant/*`, `app/routes/oauth.*` + `mcp_oauth` (read-only review only — no auth edits), `app.skus.tsx` + `app.campaigns.$campaignId*` UI.

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

## Fixed this cycle

- **F7** — ingest `transform.server.ts`: 3 selects now surface Supabase `error` instead
  of swallowing it (prevents silent null-sku order-line corruption + masked DLQ cause).
  Gate green; commit `40e9af8`.

_(Prior cycle: F4 — `retry.server.ts` stale "INERT skeleton" header corrected.)_

## Needs human

- **F1** — canonical day boundary for daily action budget (UTC vs merchant tz); engine/app disagree. Parity TODO for dashboard/engine repo. **← most important.**
- **F2** — confirm production default guardrails (current MCP shop shows $1M/day budget, $10M/action cap — likely seed only).
- **F6** — choose display format for dashboard alert timestamps (raw ISO currently shown); low-risk once the format is decided. file:line in F6 above.
