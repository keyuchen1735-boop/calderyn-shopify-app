# Calderyn — Release Readiness

Maintained by the hourly release-readiness sweep. This is the shared brain across
runs: reconcile against it so findings are never duplicated. Status vocabulary:
`[NEW]` `[OPEN]` `[FIXED]` `[CHANGED]` `[NEEDS-HUMAN]` `[WONTFIX]`.

---

## ⭐ OWNER-SEEDED BACKLOG (2026-06-11, from a deep Opus+Sonnet agent analysis)

The product owner ran a one-off deep analysis (42-persona adoption panel + UX review +
feature/bug trace) and explicitly wants these ACTED ON, not just logged. Work these
top-down in priority order; verify each against live data / current code before changing
(some may already be fixed by a prior sweep — reconcile and mark `[FIXED]`/`[WONTFIX]`).
Each fix gets the full pre-commit gate. UI copy/state/layout fixes are pre-approved.

**OWNER DECISIONS (honor exactly):**
- **"ranked by Claude" → "ranked by priority"** everywhere it appears
  (`app/routes/app.alerts._index.tsx:68`, `app/routes/app._index.tsx:269`). Optionally add a
  one-line tooltip explaining the ranking signal. This is a final decision, not a suggestion.
- The detection engine (`/api/engine/run`) is **NOT a bug in this repo** — it lives in the
  separate engine repo. Confirm alerts are flowing via Calderyn MCP, then mark any such
  "missing engine" finding `[WONTFIX]` / parity-note. Do not try to build it here.

**STATUS (2026-06-11 ~10:15 sweep): worked top-down this run.** B1 [FIXED] · B2 [FIXED]
· B3 [WONTFIX — already fixed in current code: `actions.execute` calls
`recoveredDollarsForAlertAction` and writes `dollar_impact_at_exec`, calderyn.server.ts]
· B4 [FIXED] · B5 [FIXED] · B6 [FIXED] · B7 [FIXED] · B8 [FIXED] · U1 [CHANGED] ·
U2 [CHANGED] · U3 [CHANGED] · U4 [CHANGED — all 13 banner sites] · U5 [CHANGED] ·
U6 [CHANGED] · U7 [CHANGED] · U8 [CHANGED] · U9 [CHANGED] · U10 [CHANGED — "All"
filter ordering, audit actor labels, `"— (no data)"`→`"—"`, fmtRelTime 30d cap +
invalid-date guard, audit EmptyState image="", screener "hold rate", home subtitle;
all-caps "30-DAY LOSS" unified into the U2 label]. Owner decision "ranked by
Claude"→"ranked by priority" applied at both sites + tooltips.

**B-prefixed = real bugs (verify, then fix if still present); U = UX/copy/state (pre-approved):**

| ID | Pri | Item | File(s) |
|----|-----|------|---------|
| B1 | P0 | `in_business_hours` hardcoded `true` — merchant guardrail check always shows green; wire it to `withinBusinessHours()` | `app/lib/calderyn.server.ts:186` |
| B2 | P1 | `acknowledgeAlert` not called from autopilot + dashboard action paths → alert stays "open" after a pause. Centralize ack on succeeded action w/ alert_id | `app/lib/actions/execute.server.ts`, `autopilot.server.ts`, `dashboard.api.campaigns.$id.action.tsx` |
| B3 | P1 | Legacy `actions.execute()` path never writes `dollar_impact_at_exec` → Recovered KPI shows $0 for PO/inventory/geo actions | `app/lib/calderyn.server.ts:~437` |
| B4 | P1 | Onboarding step enum order/names differ server vs UI → step state desync | `calderyn.server.ts:59` vs `app/routes/app.onboarding.tsx:38` |
| B5 | P1 | New shop has no guardrail row → `guardrails.get()` throws 404 → error banner on first run. Return a default config instead of throwing (read-only path; safe) | `calderyn.server.ts:~700` |
| B6 | P1 | Autopilot daily cap query counts `retrying`/`failed` rows → cap exhausts with zero landed actions. Add `.eq("outcome","succeeded")` | `app/lib/actions/guardrails.server.ts:79` |
| B7 | P1 | Autopilot `reduce_campaign_budget` with null current budget → `executeAction` throws, counted as error not `blocked`. Skip+count blocked instead | `autopilot.server.ts:60`, `execute.server.ts:135` |
| B8 | P1 | QuickBooks `cogs_fact` open-row lookup missing `.eq("shop_id", shopId)` (also in security backlog) | `app/lib/quickbooks/ingest.server.ts:102` |
| U1 | High | **#1 adoption blocker:** add one line to the guardrails onboarding step BEFORE the dollar fields: "By default Calderyn only acts when you approve it. These limits apply if you later turn on Autopilot." | `app/routes/app.onboarding.tsx` GuardrailsStep |
| U2 | High | "30-day projected impact" / "30-DAY LOSS" has NO methodology — add a Tooltip explaining how it's estimated (top trust-killer). Unify the label across card + detail | `app/routes/app.alerts.$id.tsx:~507`, `app/components/calderyn/index.tsx:278` |
| U3 | High | Settings notification checkboxes are render-only (no onChange/save) — either wire them to a real form or replace with an info Banner. Don't show dead affordances | `app/routes/app.settings.tsx:278-290` |
| U4 | High | Error banners render raw `error.code:` to merchants — drop the code prefix (and map GUARDRAIL_* to plain guidance) | `_index.tsx:173`, `app.alerts._index.tsx:77`, `app.alerts.$id.tsx:444`, `campaigns._index.tsx:561`, `audit.tsx:249`, `skus.tsx:126` |
| U5 | High | First-load empty state says "All clear" even before the first scan completes → looks broken for new installs. Add a "syncing / first scan running" state | `app/routes/app._index.tsx:275-291` |
| U6 | Med | "Execute · $X" button → use action label, e.g. "Pause campaign · saves $340" | `app/routes/app.alerts.$id.tsx:733` |
| U7 | Med | Onboarding: mark Google/Meta/QuickBooks steps "(optional)" in the stepper badges (only Shop+Guardrails required) | `app/routes/app.onboarding.tsx` STEPS |
| U8 | Med | "Before Calderyn acts" guardrail card framing implies auto-action by default (autopilot is off) — conditionalize title/copy on `autopilot_enabled` | `app/routes/app.alerts.$id.tsx:558` |
| U9 | Med | Evidence panel leaks raw Shopify GIDs (`inventory_item_id`, `from/to_location_id`) — add to `hideKeys` | `app/components/calderyn/index.tsx`, `app.alerts.$id.tsx:498` |
| U10 | Low | Misc: "All" filter ordering, audit `actor` raw strings, all-caps headings, `"— (no data)"` → `"—"`, `fmtRelTime` cap at 30d, audit EmptyState `image=""`, screener jargon ("hold rate"), bland dashboard subtitle | various routes |

Adoption model (full detail in `ADOPTION_SIMULATION.md`): ~15–20% of installs ever act;
~5% active at day 30. Biggest blocker = U1. Strongest trust assets = audit log + undo
(surface them earlier).

### ⭐ Batch 2 (owner-seeded 2026-06-11 ~09:40 UTC) — sweep of the NOT-YET-SWEPT areas

A second local sweep covered the areas this log marked un-swept (oauth.*, webhooks deeper,
remaining crons, campaigns index/score UI, assistant slideout, ads/* + attribution/* +
dashboard/* re-verify). Verify each against current code, then act. C-prefixed = code bugs,
V-prefixed = UX. Same rules: safe fixes pre-approved; auth/webhook/schema items are
NEEDS-HUMAN (verify + log only, do not auto-edit).

**STATUS (2026-06-11 ~10:15 sweep, same run as Batch 1):** C1 [FIXED `6aa6573`] ·
C2 [FIXED `1d84795`] · C3 [FIXED `44aa1f7` — owner approved 2026-06-11: rotation now rejects expired grants] · C4 [NEEDS-HUMAN = F23] · C5
[FIXED `f337f90` — owner approved 2026-06-11: routes now pass the real
`X-Shopify-Webhook-Id` (was random fallback), `forwardWebhook` checks the insert
error treating 23505 as idempotent success, and forward failures return 500 so
Shopify redelivers] · C6 [FIXED `d00bba1`] · C7 [FIXED `a2eb6bb`] · C8 [WONTFIX — unit
verified: `DraftedAction.dollarImpact` is cents ("mirrors Alert.dollar_impact",
converted at calderyn.server.ts:102); display switched to shared `fmtMoney` this run]
· C9 [OPEN — judged too risky to rush: pre-reserving the idempotency key before the
Meta POST changes failure semantics (a crashed run would permanently block re-push);
needs a reconcile-on-replay design, keep with F5] · C10 [FIXED `5224323`] · C11 [OPEN
— next run: verify what `alert.campaign` actually carries before re-keying] · C12
[OPEN — needs schema access; no `supabase/migrations/` in this repo] · C13 [FIXED
`d00bba1`] · C14 [FIXED `7712a32`] · V1 [FIXED `83536b6` — found independently this
run] · V2/V3 [FIXED `85a502f` — found independently this run] · V4 [NEEDS-HUMAN
(auth flow), noted with F19-F24].

| ID | Pri | Item | File(s) | Class |
|----|-----|------|---------|-------|
| C1 | P1 | `topAdNames` selects `ad_campaign_dim(name)` — feeds **campaign** names to the screener as "top ad names"; also unordered (`limit(50)`, no `.order`). Use `ad_engagement_fact.ad_name` + order by engagement desc | `app/lib/screener/history.server.ts:183-194` | safe fix (resolves F12) |
| C2 | P1 | `reconcileAttributedRevenue` UPDATEs `ad_spend_fact` filtered only by `campaign_id`+`day` — add `.eq("shop_id", shopId)` (defence-in-depth on a service-role write) | `app/lib/attribution/revenue.server.ts:48-53` | safe fix |
| C3 | P1 | `rotateRefreshToken` never selects/checks `expires_at` — expired refresh tokens rotate forever | `app/lib/mcp_tokens.server.ts:183-194` | NEEDS-HUMAN (auth) |
| C4 | P1 | OAuth DCR endpoint has no rate limit (acknowledged TODO at `oauth.register.tsx:9`) — deploy gate if `MCP_OAUTH_ENABLED` ever set in prod | `app/routes/oauth.register.tsx` | NEEDS-HUMAN (infra) |
| C5 | P2 | All 3 forwarding webhooks (orders.create / products.update / inventory_levels.update) lack `X-Shopify-Webhook-Id` dedup — Shopify retries can double-ingest orders/inventory | `app/routes/webhooks.*.tsx` | NEEDS-HUMAN (pipeline dedup design) |
| C6 | P2 | `webhooks.app.uninstalled`: session delete skipped when `session` is null (common on uninstall) — drop the `if (session)` guard, `deleteMany` is safe on zero rows | `app/routes/webhooks.app.uninstalled.tsx:12-14` | safe fix (webhook file but logic-only, no auth change) |
| C7 | P2 | `edit_budget` action accepts `newCents = 0` — server clamps ≥0 but doesn't reject 0; merchant can zero a campaign budget with no warning | `app/routes/app.campaigns._index.tsx:260` | safe fix |
| C8 | P2 | Assistant `DraftActionCard` divides `action.dollarImpact` by 100 — verify the `DraftedAction` unit; if dollars, display is 100× off | `app/components/Assistant/DraftActionCard.tsx:5-21` | safe fix after unit check |
| C9 | P2 | `meta-push` idempotency: write a pending sentinel to `action_idempotency` BEFORE the Meta API call; current order allows double-push on crash (closes F5) | `app/lib/screener/meta-push.server.ts:79-162` | safe-ish — judge carefully, mark [CHANGED] |
| C10 | P3 | `campaign-detail` hides valid ROAS when `contribution_margin === 0` (loss-leaders show "no data") — split the guards | `app/lib/ads/campaign-detail.server.ts:22` | safe fix |
| C11 | P3 | Campaign↔alert linkage via `a.campaign.includes(c.name)` substring — wrong badge counts on prefix-named campaigns; key on id where available | `app/routes/app.campaigns._index.tsx:483` | safe fix |
| C12 | P3 | `ads/ingest` upsert `onConflict: "campaign_id,day"` omits `shop_id` — align with the DB unique constraint or document why | `app/lib/ads/ingest.server.ts:92` | verify constraint first (schema check pending — Supabase access expired locally) |
| C13 | P3 | GDPR/uninstall webhooks `console.log` shop domain — drop or structure the log | `app/routes/webhooks.gdpr.tsx:13` | safe fix |
| C14 | P3 | `.well-known/oauth-authorization-server` missing `Access-Control-Allow-Origin: *` (RFC 8414 metadata is fetched cross-origin) | `app/routes/[.]well-known.oauth-authorization-server.tsx` | safe fix |
| V1 | High | Campaigns index: NO empty state when 0 campaigns + no error — blank table with headers; add EmptyState pointing to Settings integrations | `app/routes/app.campaigns._index.tsx:545` | safe fix |
| V2 | High | Assistant slideout: multiline TextField has no Enter-to-submit (Shift+Enter = newline) — chat convention | `app/components/Assistant/AssistantSlideout.tsx:165-178` | safe fix |
| V3 | Med | Assistant slideout: optimistic user bubble not removed/marked on send failure | `app/components/Assistant/AssistantSlideout.tsx:80-88` | safe fix |
| V4 | Low | `oauth.consent` passes `_auth` JWT as a query param (60s TTL; leaks to access logs/history) | `app/routes/oauth.consent.tsx:48` | NEEDS-HUMAN (auth flow) |

Confirmed CLEAN this sweep (don't re-sweep): `ads/{adapter,actions,backoff,concurrency,registry,action-registry}`,
`attribution/{match,parse,apply}`, `dashboard/{http,session,shopify-oauth}.server` + all `dashboard.api.*`
auth gates, the full recovered/audit-impact unit chain (dollars-in-DB ↔ cents-in-app verified hop-by-hop),
`cron.ingest`, `cron.ingest-quickbooks`, `app.campaigns.$campaignId.score.tsx`, `dashboard.login` state cookie.
Note: the C12/C1 DB-constraint questions need Supabase schema access — the owner's local Supabase MCP token
expired before verification; re-verify via migrations files in `supabase/migrations/` if present, else log.

---

## Summary

- **Last run:** 2026-06-11 ~10:15 UTC (owner-backlog implementation sweep)
- **Correctness gate:** GREEN — `npm ci` 0, `typecheck` 0, `lint` 0 (12 pre-existing
  warnings in untouched test files; `--max-warnings=0` clean on all touched files),
  `build` 0, `npm test` 838 passed / 5 skipped (+6 new tests for B2/B6/B7).
- **Canonical check (pause → Recovered KPI):** PASS against live data (unchanged).
  Audit row `5af82d74…` (`pause_campaign`, succeeded, `dollar_impact_at_exec`=12861.94)
  equals `get_shop_stats.recovered_7d`=12861.94. Alerts flowing (55 open, engine alive).
- **This run:** the ENTIRE owner-seeded backlog is resolved — 7 bug fixes (B1, B2, B4,
  B5, B6, B7, B8; B3 verified already-fixed) + all 10 U-items + both owner decisions,
  plus panel/trace/prod-log fixes (assistant slideout rollback + Enter-to-send,
  DraftActionCard money mismatch, campaigns empty state, favicon 404 noise) and
  3 cleanup refactors (shared DEFAULT_GUARDRAILS, ACTOR_LABELS/actorLabel +
  INTERNAL_EVIDENCE_ID_KEYS into lib/labels.ts).
- **New findings:** F18–F24 (MCP-OAuth plumbing sweep — F18 refresh tokens never
  expire is the headline, all NEEDS-HUMAN per the auth guardrail), F25 (prod `.data`
  500s around session auth), F26 (dashboard API unhandled rejections in prod logs),
  F27 (engine-side `in_business_hours` hardcoded true — parity TODO now that the
  app computes it), plus adoption items A18–A23 in `ADOPTION_SIMULATION.md`.
- **Needs human (carried):** F1 day-boundary, F2 prod default guardrails, F13
  backfill timeseries, F14 demo-as-live Predictor/Generator (**gate before launch**),
  F17 GDPR customer-redact forward drop (**compliance**), F6 dashboard timestamps.

## Coverage log

| Run (UTC) | Areas swept |
|---|---|
| 2026-06-11 03:37 | Correctness gate (full). Canonical pause→Recovered flow (live MCP + code: `recovered.ts`, `audit-impact.ts`, `actions/execute.server.ts`, `calderyn.server.ts` listAudit/undo/dailyUsed). Money path: `actions/reallocate.server.ts`, `actions/reallocation-suggest.server.ts`. UI code review: `routes/app._index.tsx` (home/stat row/focus), `lib/format.ts`. Unit-consistency audit of `dollar_impact*` across loader shaping. |
| 2026-06-11 04:38 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged). Rotation: `app/lib/actions/retry.server.ts` (drain/registry/compensator/backoff — found+fixed stale header F4) + `cron.action-retry.tsx`, `actions/autopilot.server.ts` (clean), `screener/meta-push.server.ts` (gap F5). UI code review: `routes/app.alerts.$id.tsx` + `app.alerts._index.tsx` (Polaris layout/copy/guardrail meter — clean). |
| 2026-06-11 05:45 | Correctness gate (full, GREEN). Canonical pause→Recovered re-verified live (PASS, unchanged) + traced dashboard read side (both surfaces use shared `recovered()`). Rotation: `attribution/*` (revenue/apply/match/parse), `meta/transform.ts`, `gdpr/sweep.server.ts`, `screener/*` (orchestrate/calibrate/image-gen-limit + E2E trace), `ingest/*` (found+fixed F7 in `transform.server.ts`; google/tiktok/quickbooks/meta-ingest scanned clean via sub-agent). UI code review: `routes/app.audit.tsx`, `app.campaigns._index.tsx`, `app.screener.tsx` (clean), `components/dashboard/*` (format/view-models/live + `Dashboard.tsx`/`Alerts.tsx` — found F6 raw `created_at` render). Unit check: `dollar_impact*` dollars→cents at `calderyn.server.ts:102,119` confirmed consistent with `fmtMoney`. |
| 2026-06-11 06:43 | Correctness gate (full, GREEN — 832 pass). Canonical pause→Recovered re-verified live (PASS, unchanged; audit `5af82d74…`=12861.94=`recovered_7d`). Rotation — **screener internals** `screener/{generate,score,score-one,meta-creative,higgsfield,history,runs,campaign-ads,pick-generator}.server.ts` (found+fixed F8 swallowed errors in `history`; F12 topAdNames embed-shape + F15 Predictor latent div-by-zero logged); **ingest/PO internals** `ingest/{backfill,dlq,enqueue,mappers,shopify-admin}.server.ts` + `po/{draft,pdf}.server.ts` (found+fixed F9 backfill terminal write + F10 mappers NaN `source_version`; F13 inventory-timeseries logged). UI code review: `components/dashboard/screens/{Analytics,Inventory,Settings,Generator,Predictor,Campaigns}.tsx` + `format.ts` (found+fixed F11 `money()` `$NaN`; F14 Predictor/Generator demo-data-as-live logged; Settings + Analytics/Inventory/Campaigns state-handling clean). |
| 2026-06-11 07:48 | Correctness gate (full, GREEN — 832 pass). Canonical pause→Recovered re-verified live (PASS, unchanged; audit `5af82d74…`=12861.94=`recovered_7d`; guardrails still demo $1M/day, used 0 → F1/F2 unchanged). Rotation — **meta/* internals** `meta/{insights,ad-insights,actions,campaigns,creatives,ingest,oauth-state}.server.ts` (clean; documented limitations: creatives single-page >25-ad truncation, ingest currency-default-on-error); **assistant/*** `assistant/{anthropic,loop,tools,prompt,request,snapshot,conversations}.server.ts` (clean — model `claude-sonnet-4-6` correct; verified `snapshot.dollars()` consumes cents-shaped `dollar_impact` per `calderyn.server.ts:102`, no unit bug); **adapter internals deep-read** via sub-agent `google/* tiktok/* quickbooks/* ads/*` (found F16 in google `recordSyncError` + cron.ingest-ads `setSync`; rest clean). UI code review: `routes/app.skus.tsx` (clean — auth/error/empty states, location cell), `app.generator.tsx` (clean live feature — auth both sides, quota refund, error/empty/loading states). |
| 2026-06-11 08:35 | Correctness gate (full, GREEN — 832 pass / 5 skip). Canonical pause→Recovered re-verified live (PASS, unchanged; audit `5af82d74…`=12861.94=`recovered_7d`; guardrails still demo $1M/day, used 0 → F1/F2 unchanged). Rotation — **ingest internals (remaining)** `ingest/{dlq,enqueue,shopify-admin}.server.ts` (clean — dlq logs-never-throws correctly, enqueue throws on error, shopify-admin checks GraphQL `body.errors` + documents slice-1 page-size caps); **assistant glue** `assistant/{action-param,types}.ts` + `app.assistant.tsx` resource route (clean — auth, `parseAssistantRequest` validation, error-path saves user turn but not broken assistant turn); **GDPR plumbing** `webhooks.gdpr.tsx` + `cron.gdpr.tsx` + `gdpr/sweep.server.ts` (found F17 — customer-redact/data-request forward-drop; shop_redact reconciled by sweep, customer-level NOT); **meta client deep-read** `meta/client.server.ts` (read-only, clean — checks `error` on creds read, decrypts token; no `res.ok` guard but Graph API returns `{error}` JSON consumed by callers). UI code review: `routes/app.campaigns.$campaignId.tsx` (clean — strong loader error isolation per-fetch, honest `— (no data)`/`CREATIVE_ID_UNAVAILABLE` gap states, Predicted/Actual badges, good BlockStack/InlineGrid structure). |

| 2026-06-11 ~10:15 | Correctness gate (full, GREEN — 838 pass / 5 skip, +6 new). Canonical pause→Recovered re-verified live (PASS; 55 open alerts, engine alive; guardrails still demo $1M/day → F1/F2 unchanged). **Owner backlog implemented end-to-end** (B1–B8 verified+fixed, U1–U10 + owner decisions shipped — see backlog STATUS). Rotation via sub-agent — **MCP-OAuth plumbing read-only** `oauth.{authorize,consent,register,token}` + `mcp_tokens/mcp_oauth` libs + `cron.mcp-oauth-cleanup` (7 findings F18–F24, all logged NEEDS-HUMAN per auth guardrail); **assistant slideout client** (`AssistantSlideout`, `DraftActionCard` — 3 found, 3 fixed); **webhooks deeper read** orders.create/products.update/inventory_levels.update (clean beyond known F17 pattern); `app.campaigns._index` + campaign-score UI (empty-state gap found+fixed). 28-persona panel (2 batches; see ADOPTION_SIMULATION.md). Vercel prod logs swept: favicon 404 noise (fixed in-repo), `.data` 500s (F25), dashboard-API unhandled rejections (F26), cron.detect engine failures (engine repo). |

**Not yet swept (rotate here next):** `app/lib/ads/*` + `attribution/*` re-verify, `history.server.ts` topAdNames schema verification (F12 — needs Supabase schema access), `app/lib/dashboard/*` + `dashboard.api.*` routes (F26 unhandled rejections — find the rejecting promise), `app.analytics._index.tsx` deep UI review, `app/lib/shopify/inventory.server.ts` + PO PDF route, `cron.detect`/`cron.autopilot` routes, dashboard screens parity items (F6/F14). Swept this run: MCP-OAuth plumbing, assistant slideout client, webhooks deeper read, campaigns index/score UI, full owner backlog surface.

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

### [FIXED] F16 — two remaining swallowed `sync_status` writes (google ingest + cron.ingest-ads)
- **Where:** `app/lib/google/ingest.server.ts` `recordSyncError` (was ~104-112) and
  `app/routes/cron.ingest-ads.tsx` `setSync` (was ~11-19) + its catch-block call (was ~43).
- **Observed:** the last two terminal `shop_integrations` status writes in the F7/F8/F9 swallowed-
  error class — both destructured nothing/`.data` and ignored `.error` (supabase-js returns
  `{ error }` without throwing). `setSync` on the cron SUCCESS path (lines 34/38): a dropped write
  reports a sync that never persisted → stale `pending` (endless re-backfill) or missed
  `last_sync_at`. `recordSyncError`: an unrecorded error-status write left the row inconsistent.
- **Fix (with the error-recording-path subtlety):** both spots run inside a caller's catch that
  re-throws the ORIGINAL ingestion error, so a naive "check + throw" would mask it. `recordSyncError`
  now checks `error` and **logs** (never throws). `setSync` now throws on write error — correct for
  its two success-path callers (turns a false success into a real pool failure) — and the catch-path
  call is wrapped in its own try/catch so a failed error-status write can't mask the original error.
  Ingest plumbing (internal) — exempt from dashboard parity. **Gate:** `/code-review` [] (additive,
  no masking); typecheck 0; eslint `--max-warnings=0` both files 0; build 0; vitest google+ingest+cron
  118/118; full suite 832/5-skip. Commit `81a9f77`.

### [FIXED `f337f90`, owner approved 2026-06-11] F17 — GDPR customer-redact / data-request forward failures are silently dropped (no retry, no reconciler)
- **Where:** `app/routes/webhooks.gdpr.tsx:21-37` (the `try/catch` around `forwardWebhook`
  for `customers/data_request` and `customers/redact`).
- **Observed:** the handler forwards each GDPR webhook to the engine, and on ANY forward
  failure it logs and returns `new Response()` (HTTP 200). A 200 tells Shopify the webhook
  was processed, so Shopify does NOT retry. For `shop/redact` this is fine — the daily
  `cron.gdpr` sweep (`gdpr/sweep.server.ts`) independently cascading-deletes uninstalled
  shops past the 30-day grace window, so a dropped forward is reconciled. But
  `customers/data_request` and `customers/redact` have **no** such reconciler: they are
  forward-only, so if the engine POST fails (engine down/transient), the customer-level
  GDPR obligation is lost with no retry and no second path — a launch compliance gap.
- **Note on the pattern:** every webhook handler in the repo uses this same best-effort
  forward-then-200 shape (orders.create, products.update, inventory_levels.update), so this
  is a deliberate architecture choice, not an inconsistency. The data webhooks are safe
  because the Shopify backfill cron re-syncs; the customer-GDPR webhooks are the one case
  with neither retry nor reconciler.
- **Why not auto-fixed:** changing a webhook handler's response semantics (return non-200
  on forward failure so Shopify retries — it backs off GDPR webhooks over ~48h) is a
  webhook edit, explicitly DO-NOT-FIX per the run's fix protocol. Also a product/legal call.
- **Ask for human:** either (a) return a non-2xx on forward failure for the two customer
  GDPR topics so Shopify retries, or (b) persist the raw customer-GDPR webhook and add a
  reconciling sweep (mirror the shop_redact path). Parity TODO for the engine repo, which
  owns `/internal/gdpr/*`.

### [NEEDS-HUMAN] F18 — MCP refresh tokens never expire (rotation ignores `expires_at`)
- **Where:** `app/lib/mcp_tokens.server.ts:183-215` (`rotateRefreshToken`).
- **Observed:** the select fetches `revoked_at` but not `expires_at`, and nothing checks
  expiry — a stolen refresh token can be rotated forever; the spec's 90-day lifetime is
  not enforced. Auth logic → not auto-fixed per guardrail. **Fix before enabling
  `MCP_OAUTH_ENABLED` in production:** select `expires_at`, throw `invalid_grant` when past.

### [NEEDS-HUMAN] F19–F24 — remaining MCP-OAuth sweep findings (auth guardrail; sub-agent verified)
- **F19** `oauth.consent.tsx:95` — `resolveShopId` throws on un-provisioned shop → unhandled
  500 instead of an OAuth error redirect.
- **F20** `mcp_oauth.server.ts:266-279` — pending-OAuth upsert keyed on `shop_domain` only;
  two concurrent client flows overwrite each other (fix needs a schema migration).
- **F21** `oauth.authorize.tsx:107-126` — pending row written BEFORE Shopify confirms shop
  identity (orphaned row w/ attacker-controlled redirect_uri for the 10-min TTL).
- **F22** `oauth.authorize.tsx:163-165` — action branch doesn't validate `code_challenge`
  non-empty (loader does); inconsistent validation.
- **F23** `oauth.register.tsx` — open dynamic-client-registration endpoint, rate limit still
  TODO; pre-public-launch requirement.
- **F24** `oauth.token.tsx:70-73` — all errors collapse to `invalid_request` 400; transient
  server errors should be `server_error` so clients back off and retry.
- Also minor: consent silent-redirect on expired pending row (no explanation page);
  cleanup cron 24h cutoff vs 10-min TTL table. PKCE itself verified sound (constant-time
  compare, S256, single-use codes, redirect_uri validated).

### [OPEN] F25 — prod `.data` route 500s around session auth
- **Where:** Vercel prod logs 2026-06-10 ~22:19–23:04 UTC: `GET /app.data`,
  `/app/alerts.data`, `/app/analytics.data`, `POST /app/screener.data` → 500 with
  `[shopify-app/INFO] Authenti…` (truncated). Likely session-token refresh/expiry path
  throwing instead of re-authing. Needs log drill-down (full message) next run; auth
  plumbing, so investigate before touching.

### [OPEN] F26 — dashboard API "Unhandled Rejection" in prod despite 200 responses
- **Where:** Vercel prod logs: `GET /dashboard/api/alerts`, `/dashboard/api/audit` →
  status 200 but `Unhandled Rejection: Error:…`. A fire-and-forget promise in the
  dashboard API path rejects after the response is sent. Find the un-awaited promise
  (rotate here next run).

### [OPEN] F28 — autopilot cooldown query counts failed/retrying rows (asymmetric with the B6 cap fix)
- **Where:** `app/lib/actions/guardrails.server.ts:29` (`minutesSinceLastAutopilotActionOn` —
  no outcome filter).
- **Observed:** a `retrying`/`failed` autopilot attempt starts the full per-campaign
  cooldown even though no platform change landed, while the daily cap (B6) now ignores
  those rows. Deliberately NOT changed this run: a `retrying` row has a replay parked in
  the retry cron, so cooling the campaign while an action is in flight is arguably
  correct; pure `failed` is the debatable case. Needs a one-line design call: should
  cooldown mirror the cap (`succeeded` only), or treat in-flight retries as touches?

### [OPEN] F29 — settings privacy buttons ("Withdraw consent" / "Download my data (GDPR)") are handler-less
- **Where:** `app/routes/app.settings.tsx` privacy section.
- **Observed:** same dead-affordance class as U3 (fixed); these two remained because
  consent-withdrawal/data-export semantics are a product/compliance call, not copy. Either
  wire them (engine owns the GDPR endpoints) or replace with mailto/instructions pre-launch.

### [NEEDS-HUMAN] F27 — engine/MCP still reports `in_business_hours: true` hardcoded (parity)
- **Where:** live `get_guardrails` returned `in_business_hours: true` at 09:35 UTC for a
  14:00–00:00 UTC window (should be false). This repo's copy of the bug (B1) is fixed
  this run; the engine repo's MCP tool has the same hardcode. Parity TODO for the
  engine/dashboard repo.

## Fixed this cycle

- **(2026-06-11 ~10:15 run)** Owner backlog cleared + panel/trace/prod fixes. Commits on
  `calderyn/release-polish` (each gated: typecheck 0 / lint 0 on touched files / build 0 /
  838 tests pass):
  - `b34cbc6` lib/calderyn.server: B1 `in_business_hours` real window math, B4 onboarding
    enum mirror, B5 default guardrails instead of 404.
  - `1f3d90d` actions/guardrails.server: B6 daily cap counts only succeeded (+test).
  - `6667b63` actions/autopilot.server: B7 null/zero-budget cut → blocked, loop keeps
    draining (+2 tests). The throw previously aborted the whole autopilot run.
  - `f7db4ba` actions/execute.server: B2 centralized acknowledge-on-success (+3 tests).
  - `40e435a` quickbooks/ingest: B8 shop_id scope on cogs_fact open-row read.
  - `3e50bb0` actions/undo.server: re-open alert on EVERY undo surface + carry alert_id
    (review-found follow-up to B2 — dashboard undo + reallocate undo left alerts stuck
    acknowledged). `141894f` autopilot blocked-branch logs + onboarding enum name-pin test.
  - `b0b6622` onboarding U1/U7/U4 + OAuth reassurance + shared `lib/guardrail-defaults.ts`.
  - `8eb6c8e` alerts surfaces U2/U4/U6/U8/U9 + owner renames + `INTERNAL_EVIDENCE_ID_KEYS`/
    `ACTOR_LABELS` into labels.ts. `c436674` home U5 first-scan state (+ !error guard,
    review-found) + audit actor labels + real empty state. `76aaa88` settings U3 dead
    checkboxes → honest banner. `83536b6` campaigns empty state + `— (no data)`→`—`.
    `7dbaec7` skus/analytics/mcp/screener U4 + de-jargon. `85a502f` assistant slideout
    rollback + Enter-to-send + DraftActionCard money. `2e980dc` fmtRelTime 30d cap +
    invalid guard. `2edc5fa` favicon routes (prod 404 noise).
  - `/code-review` (3-angle fan-out + verify): 2 real findings fixed (undo re-open,
    first-scan-on-error), 3 hardening follow-ups, 4 downgraded with justification —
    double-ack in alerts route is idempotent + self-healing (second call retries a failed
    first ack); `in_business_hours` is a loader snapshot, gateway re-checks live at
    execute; guardrails default-on-null is safe (service-role bypasses RLS, null = no
    row); empty-state JSX triplication accepted for now.
- **(2026-06-11 08:35 run)** No code fix — rotation areas (ingest dlq/enqueue/shopify-admin,
  assistant glue + route, GDPR webhooks/cron/sweep, meta client, campaign-detail UI) swept clean;
  no clear low-risk fix surfaced. One new finding logged: F17 (GDPR customer-redact drop, NEEDS-HUMAN).
- **F16** — google `ingest.server.ts recordSyncError` + cron `ingest-ads.tsx setSync`: the last two
  swallowed-`sync_status`-write spots now surface the Supabase error (log on error-recording paths,
  throw on the cron success path) without masking the original ingestion error. Commit `81a9f77`.

_(Prior cycles: F8 — screener `history.server.ts` 6 swallowed calibration reads; F9 — ingest
`backfill.server.ts` terminal write; F10 — ingest `mappers.server.ts` NaN `source_version`; F11 —
dashboard `format.money()` `$NaN`; F7 — ingest `transform.server.ts` 3 swallowed selects; F4 —
`retry.server.ts` stale "INERT skeleton" header.)_

## Needs human

- **F18** — MCP refresh tokens never expire (`rotateRefreshToken` ignores `expires_at`);
  fix before `MCP_OAUTH_ENABLED` ships. F19–F24 queue behind it. **← most important this run.**
- **F1** — canonical day boundary for daily action budget (UTC vs merchant tz); engine/app disagree. Parity TODO for dashboard/engine repo.
- **F27** — engine MCP `in_business_hours` hardcoded true (app side fixed as B1); parity TODO.
- **F14** — Predictor/Generator dashboard screens render demo data as live with false "synced from Meta" copy; gate behind a Preview/Demo affordance before launch (credibility risk). Parity TODO for dashboard repo.
- **F13** — backfill fabricates the inventory time series (all points at run-time, not actual stock-change time); design call (bulk-ops API or accept limitation).
- **F17** — GDPR `customers/data_request` + `customers/redact` forward failures return 200 with no retry and no reconciler (only `shop/redact` is reconciled by the sweep) — compliance gap; decide retry-on-failure vs persist-and-reconcile. Parity TODO for the engine repo.
- **F2** — confirm production default guardrails (current MCP shop shows $1M/day budget, $10M/action cap — likely seed only).
- **F6** — choose display format for dashboard alert timestamps (raw ISO currently shown); low-risk once the format is decided. file:line in F6 above.
