# Calderyn — Release Readiness

Maintained by the hourly release-readiness sweep. This is the shared brain across
runs: reconcile against it so findings are never duplicated. Status vocabulary:
`[NEW]` `[OPEN]` `[FIXED]` `[NEEDS-HUMAN]` `[WONTFIX]`.

## Summary

- **Last run:** 2026-06-11 03:37 UTC
- **Correctness gate:** GREEN — `npm ci` 0, `typecheck` 0, `lint` 0 (12 pre-existing
  warnings in untouched files), `build` 0, `npm test` 828 passed / 5 skipped (134
  files).
- **Canonical check (pause → Recovered KPI):** PASS against live data. Audit row
  `5af82d74…` (`pause_campaign`, succeeded, `dollar_impact_at_exec`=12861.94) equals
  `get_shop_stats.recovered_7d`=12861.94.
- **Open bugs:** 0 code bugs found this run.
- **Fixed this run:** 0 (gate already green; no clear low-risk code fix surfaced).
- **Needs human:** 2 (1 cross-surface guardrail discrepancy, 1 demo-config check).

## Coverage log

| Run (UTC) | Areas swept |
|---|---|
| 2026-06-11 03:37 | Correctness gate (full). Canonical pause→Recovered flow (live MCP + code: `recovered.ts`, `audit-impact.ts`, `actions/execute.server.ts`, `calderyn.server.ts` listAudit/undo/dailyUsed). Money path: `actions/reallocate.server.ts`, `actions/reallocation-suggest.server.ts`. UI code review: `routes/app._index.tsx` (home/stat row/focus), `lib/format.ts`. Unit-consistency audit of `dollar_impact*` across loader shaping. |

**Not yet swept (rotate here next):** `app/routes/app.alerts.$id.tsx` + `app.alerts._index.tsx` UI, `app/lib/actions/retry.server.ts` compensator + `autopilot.server.ts`, `app/lib/meta/*`, `app/lib/screener/*` + `app.screener.tsx` / `app.generator.tsx`, `app/lib/ingest/*` + cron routes, `app/lib/gdpr/*`, `app/components/dashboard/*`, `app/lib/google/*` + `tiktok/*` + `quickbooks/*` adapters, `app/routes/oauth.*` + `mcp_oauth` (read-only review only — no auth edits).

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

## Fixed this cycle

_(none this run)_

## Needs human

- **F1** — canonical day boundary for daily action budget (UTC vs merchant tz); engine/app disagree. Parity TODO for dashboard/engine repo. **← most important.**
- **F2** — confirm production default guardrails (current MCP shop shows $1M/day budget, $10M/action cap — likely seed only).
