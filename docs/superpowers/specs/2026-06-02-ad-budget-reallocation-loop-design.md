# Design: Ad-Budget Reallocation Loop (Constant-Analysis, Slice 1 -- the ad-budget half)

**Date:** 2026-06-02
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY`

---

## 1. Context

The "constant analysis" idea is a winner/loser money loop: ad winning + stock
low -> buy more; ad losing -> cut its budget; move the freed budget to the
winner. Only `reorder_timing` exists as a built detector; the campaign detectors
and the budget-shift action are not built.

State of each piece the full loop needs:

| Piece | State today |
|---|---|
| Ad performance data (spend, ROAS per campaign) | Campaigns are live-fetched from Meta for pause/resume, but `roas_7d`/`spend`/`margin` come back `0` -- no insights are pulled. |
| Ad spend coupled to a SKU (creative->SKU map) | Does not exist (onboarding has an unbuilt `creative_mapping` step). |
| Detectors `campaign_below_breakeven`, `negative_unit_economics` | Named in `DetectorId` (`app/lib/types.ts`) but not built. |
| `reduce_campaign_budget` action | Framework only -- records an `action_audit` row, never calls Meta. |
| Increase / shift-budget action | Does not exist as an `ActionKind`. |
| `create_po_draft` action | Framework only -- no real PO. |
| Cadence | One daily-ish cron (`app/routes/cron.ingest.tsx`). |
| Guardrails (daily action budget, $ cap, cooldown, business hours) | Displayed, not enforced -- `actions.execute` just records audit; `daily_action_budget_used` and `in_business_hours` are hardcoded. |

The full idea spans four subsystems (ad-data ingestion, creative->SKU mapping,
new detectors, new/real actions) -- too large for one spec. It is decomposed:

- Slice 1 (this doc): the ad-budget half -- cut the loser and feed the winner --
  because Meta is already wired (OAuth, live campaigns, real pause/resume from
  the 2026-06-01 Meta actions slice), so it is the shortest path to a working
  "money moves automatically" loop.
- Slice 2 (later): the stock-coupled "buy more" half -- `create_po_draft` +
  creative->SKU mapping.

## 2. Goal & success criteria

After a merchant connects Meta and sets a target ROAS, on each hourly tick:

1. The loop fetches every active campaign's 7-day spend + ROAS from Meta
   insights, parsed from Meta's real `purchase_roas` shape (Section 8) -- no more
   `0` placeholders.
2. Each campaign is classified against the merchant's target ROAS:
   losing-outright, below-breakeven, winner, or hold. Campaigns under a minimum
   7-day spend are held (not cut, not alerted) so low-data campaigns are not
   misread as critical losers.
3. Budget is shifted in two phases so total spend never rises: cuts are gated and
   applied first; the feed pool is built only from cuts that actually succeeded;
   feeds are then gated and applied up to a per-tick ceiling.
4. Every move passes the guardrail gate before any Meta call. A blocked move does
   not call Meta; a blocked cut keeps its loser alert, a blocked feed is counted
   in the summary (Section 6.3).
5. Every executed move is a real Meta budget write and an undoable `action_audit`
   row carrying `dollar_impact_at_exec`; Undo restores the prior `daily_budget`
   on Meta.
6. Losers always leave a standard `alerts` row (`campaign_below_breakeven` /
   `negative_unit_economics`) so the Analytics surface (#2) shows the "why".
   Campaigns that recover resolve their old open alerts.
7. Runs are idempotent: a retry or an overlapping run does not double-apply a
   move (Section 5.3).
8. One bad campaign or shop is logged and skipped -- never aborts the rest; the
   cron returns a JSON summary.

## 3. Non-goals

- The stock/PO half (`create_po_draft`, `scaling_sku_fulfillment_risk`,
  `sku_stockout_vs_spend`, creative->SKU mapping) -- Slice 2.
- Meta ad ingestion into `v_campaigns_flat` (Slice 2 of the data pipeline).
  Campaigns + insights are live-fetched, decoupled from that work.
- QuickBooks COGS / true contribution margin -- deferred; this slice uses a
  merchant-set target ROAS as the win/lose line instead.
- Google Ads.
- Ad-set-level budget control (only campaign-level `daily_budget` is acted on).
- Event-driven triggers / sub-hourly cadence -- hourly cron is enough given
  Meta's ~15-60 min insights lag.
- A general detector/action framework -- the guardrail gate is written to be
  reusable, but no registry/engine is built ahead of need.
- A first-class winner ("scaling opportunity") alert -- winner feeds are
  audit-only this slice (Section 6.3); a winner detector id is a coordinated
  follow-up.

## 4. Decisions (confirmed in brainstorming)

| Decision | Choice |
|---|---|
| Which slice first | Ad-budget loop (cut loser and feed winner). |
| Auto vs propose | Auto-execute, guardrailed. Moves within guardrails fire on their own; blocked moves do not call Meta. |
| Cadence | Hourly cron (`cron.budget-loop.tsx`), tunable interval. |
| Win/lose signal | Merchant-set target ROAS in `guardrail_config`. |
| Budget-move policy | Small bounded steps, budget-neutral -- total ad spend never rises; money shifts loser->winner gradually. |
| Build approach | New modules mirroring existing seams (pure score fn + server runner + Meta client extension + reusable gate). |

## 5. Architecture

```
cron.budget-loop.tsx  (hourly, Authorization: Bearer CRON_SECRET)
        |
        v
  loop.server.ts -- per Meta-connected shop:
        |
   listCampaigns() + fetchCampaignInsights()      (7d spend + ROAS)
        |
   score.classify() + score.planCuts()  (pure)
        |
   PHASE A  for each cut -> guardrail gate
              execute? -> setCampaignBudget() on Meta
                          + actions.execute (audit, dollar_impact_at_exec, undoable)
                          + accumulate realizedFreedCents
              block?   -> keep loser alert, no Meta call
        |
   score.planFeeds(realizedFreedCents)  (pure)
        |
   PHASE B  for each feed -> guardrail gate
              execute? -> setCampaignBudget() on Meta + actions.execute
              block?   -> count in summary, no Meta call
        |
   upsert loser alerts; resolve recovered campaigns
```

Background Meta access reuses the existing `metaClientForShop(shop)` seam (loads
+ decrypts the stored token), so the cron calls Meta without an inbound request,
exactly like `cron.ingest` uses `unauthenticated.admin`.

### 5.1 Module layout

| New / changed | Responsibility | Testable now? |
|---|---|---|
| `app/lib/budget/score.ts` | Pure: `classify`, `planCuts`, `planFeeds`. Carries the unit-test weight. | yes |
| `app/lib/budget/loop.server.ts` | Orchestrate one shop: fetch -> classify -> phase A cuts -> phase B feeds -> alerts. | yes (fakes) |
| `app/lib/budget/guardrails.server.ts` | The enforce gate (today guardrails only display). Reusable by future auto-actions. | yes |
| `app/lib/meta/campaigns.server.ts` | add `fetchCampaignInsights()`, `setCampaignBudget()`. | yes (fake client) |
| `app/routes/cron.budget-loop.tsx` | Hourly route; same Bearer auth + JSON summary as `cron.ingest`. | via loop |
| `app/lib/types.ts` | add `"increase_campaign_budget"` to the `ActionKind` union (one line). | -- |
| `app/lib/calderyn.server.ts` | `ExecuteActionOpts` + `actions.execute` write `dollar_impact_at_exec`; `audit.undo` restores prior `daily_budget` for budget kinds. | yes (fake client) |

### 5.2 Audit dollar impact (Section 5, dependency of the gate)

`actions.execute` today inserts `action_audit` without `dollar_impact_at_exec`
(verified in `app/lib/calderyn.server.ts`), so the gate could not sum it. This
slice adds an optional `dollarImpactAtExec?: number` (dollars) to
`ExecuteActionOpts` and writes it into the insert. Budget moves pass
`dollarImpactAtExec = abs(deltaCents) / 100`. The DB stores dollars (the existing
`rowToAudit` multiplies by 100 for the UI), so the gate sums this column in
dollars and compares against `daily_action_budget` (also dollars). This change is
in `calderyn.server.ts`, not the shared `types.ts`.

### 5.3 Idempotency and overlap protection

Hourly crons can retry or overlap, and cooldown only helps once an audit row
exists -- two simultaneous runs could both pass cooldown. Two guards:

1. Deterministic idempotency key per action:
   `budget:<shopId>:<campaignId>:<tickHour>:<role>` where `tickHour` is the
   current UTC hour truncated (e.g. `2026-06-02T15`) and `role` is `cut` or
   `feed`. The existing `action_idempotency` table (unique on
   `(shop_id, idempotency_key)`) makes a second attempt return the prior audit
   instead of re-applying. At most one cut and one feed per campaign per hour,
   regardless of amounts. (The amounts are deliberately not in the key: a partial
   prior run may have already moved the budget, so a recomputed `to` value must
   still dedup.)
2. A shop-level advisory lock row (`budget_loop_lock(shop_id, locked_at)`,
   acquired conditionally, released in `finally`, with a stale-lock timeout) so
   two concurrent ticks for the same shop do not interleave phase A/B. Belt and
   suspenders on top of the per-action key.

## 6. Scoring (`budget/score.ts`, pure)

Input per campaign: `{ id, name, dailyBudgetCents, spend7dCents, roas7d }`.
Config from `guardrail_config`: `targetRoas`, `loseBand` (0.9), `winBand` (1.2),
`stepPct` (0.20), `floorCents`, `ceilingPct` (0.20), `minSpend7dCents`.

### 6.1 Eligibility

Act only on campaigns that are `ACTIVE`, expose a campaign-level `daily_budget`,
and have `spend7dCents >= minSpend7dCents`. Skipped campaigns are logged with a
reason:

- ad-set-level budget (no campaign `daily_budget`) -- Meta will not accept a
  campaign-level budget write there;
- below `minSpend7dCents` -- too little data; a missing `purchase_roas` would
  otherwise read as `roas7d = 0` and misclassify a new campaign as a critical
  loser.

### 6.2 Classify (against `targetRoas`)

| ROAS | Class | Detector / role | Severity |
|---|---|---|---|
| `< 1.0` | losing money outright | `negative_unit_economics` | critical |
| `1.0 .. targetRoas*loseBand` | under breakeven | `campaign_below_breakeven` | high |
| `> targetRoas*winBand` | winner | feed candidate | -- |
| in between | hold | -- | -- |

### 6.3 Plan moves (two-phase, budget-neutral)

`planCuts(losers, config)` -- per loser:
`cut = round(dailyBudget * stepPct)`,
`newBudget = max(floorCents, dailyBudget - cut)`,
`freed = dailyBudget - newBudget`.
Returns `BudgetMove[]` with `role: 'cut'`.

The loop gates and applies cuts first, summing `realizedFreedCents` from only the
cuts that actually wrote to Meta (a blocked or failed cut contributes nothing).

`planFeeds(winners, realizedFreedCents, config)` -- winners ranked by ROAS desc;
each may take up to `round(dailyBudget * ceilingPct)` this tick. Fill highest-ROAS
first until the pool is empty or all winners are at their ceiling. Leftover pool
(no winner capacity) stays cut, so total spend may fall but never rises
("budget-neutral" means <= neutral). Returns `BudgetMove[]` with `role: 'feed'`.

`BudgetMove = { campaignId, name, fromCents, toCents, deltaCents, role }`.

Winner feeds are audit-only this slice. A blocked feed makes no Meta call and is
counted in the cron summary; the merchant's existing manual "Edit budget" control
on the Campaigns page is the approval path. (A first-class winner alert would need
a new `DetectorId` and is a coordinated follow-up -- Section 11.)

### 6.4 Loser alerts and lifecycle

Loser `dollar_impact` (dollars, drives `claude_rank` + narrative):
`spend7dCents/100 * max(0, 1 - roas7d/targetRoas)` -- for `negative_unit_economics`
this is effectively all of 7-day spend. Losers ranked by it descending, mirroring
`reorder_timing`.

`AlertDraft` per loser (same shape family as the reorder detector):
`entity_ref = { campaign_id, name }`, `severity`, `dollar_impact`, `claude_rank`,
templated `claude_narrative`,
`evidence = { roas7d, spend7d_cents, daily_budget_cents, target_roas, decision, delta_cents, blocked_reason? }`.

Upsert on the existing dedup constraint `(shop_id, detector_id, entity_ref,
day_bucket)`, keyed on `entity_ref->>'campaign_id'` (day_bucket = UTC date).
Recovery: any open `campaign_below_breakeven` / `negative_unit_economics` alert
whose campaign is no longer breaching this tick is set `status='resolved',
resolved_at=now()` -- mirrors `reorder_timing`.

### 6.5 Worked tick (target 2.0)

```
A roas 0.7  $50 -> negative_unit_economics  -> cut to $40  (freed $10)
B roas 1.7  $30 -> campaign_below_breakeven  -> cut to $24  (freed $6)
   PHASE A applied: realized pool = $16
C roas 3.1  $80 -> winner  -> +$16 (ceiling $16) -> $96
   total spend unchanged

If B's cut is blocked: realized pool = $10, C gets +$10 -> total spend falls $6,
never rises.
```

## 7. Guardrail gate (`budget/guardrails.server.ts`)

Replaces today's display-only behavior. Each move is checked in order; the first
failure blocks (no Meta call):

1. Business hours -- the stored window is UTC. Let `h = current UTC hour`,
   `[start, end] = [business_hours_start_utc, business_hours_end_utc]`. In-window
   is `start <= h < end` when `start <= end`, or `h >= start || h < end` when the
   window wraps (e.g. `14 -> 0` means 14:00..24:00 UTC). Outside -> block.
   (Storing local hours is the saver's job at onboarding; the gate only sees UTC.)
2. Cooldown -- the campaign had a budget action within
   `cooldown_minutes_per_campaign` (most recent `action_audit.completed_at` for
   that campaign) -> skip this tick.
3. Per-action $ cap -- `abs(deltaCents) > dollar_impact_cap_without_2fa * 100` ->
   block (the over-threshold path; the merchant approves manually).
4. Daily action budget -- running `sum(dollar_impact_at_exec)` already executed
   "today" (UTC calendar day, matching `day_bucket`) for budget kinds must stay
   `<= daily_action_budget`. The gate computes used-today from `action_audit`,
   killing the hardcoded `used = 0`.

Returns `{ decision: 'execute' | 'block', reason }`. A blocked cut's reason is
written into its loser alert's `evidence.blocked_reason`.

## 8. Meta client additions (`app/lib/meta/campaigns.server.ts`)

Same injected-client + `check()`-on-error pattern as the existing `listCampaigns`
/ `setCampaignStatus`; pinned Graph version `v21.0` (see `client.server.ts`).

### 8.1 `fetchCampaignInsights(client, adAccountId)`

`GET /act_<id>/insights?level=campaign&date_preset=last_7d&fields=campaign_id,spend,purchase_roas`
-> `Record<campaignId, { spend7dCents, roas7d }>`.

Meta's real shapes (the array form is the crux of success criterion #1):

```json
{ "data": [
  { "campaign_id": "123", "spend": "50.00",
    "purchase_roas": [ { "action_type": "omni_purchase", "value": "3.12" } ] },
  { "campaign_id": "456", "spend": "12.34" }    // no purchase_roas -> roas7d = 0
] }
```

Parsing rules:
- `spend` is a decimal string in account currency -> `spend7dCents =
  round(Number(spend) * 100)`.
- `purchase_roas` is an array of `{ action_type, value }`. Pick the
  `omni_purchase` entry if present, else the first entry; `roas7d =
  Number(entry.value)`. Missing/empty array -> `roas7d = 0` (the
  `minSpend7dCents` gate then keeps low-data campaigns out of cuts/alerts).
- Insights paginate (`paging.next`); follow cursors until exhausted (bounded).
- A Graph `error` payload throws via `check()` (never swallowed).

### 8.2 `setCampaignBudget(client, campaignId, dailyBudgetCents)`

`POST /<campaign-id>` body `daily_budget=<cents>` -> `{ success: true }`; Meta
budgets are integer minor units (cents). Graph `error` -> throw.

## 9. Undo

Extends the existing `audit.undo` (which already restores prior status for
`pause_campaign`). For `reduce_campaign_budget` and `increase_campaign_budget`:
read the original audit's `pre_state.daily_budget_cents`, call
`setCampaignBudget(client, metaCampaignId, prior)`, then write the inverse audit
row. If the Meta call fails, no inverse row is written and the error surfaces --
same contract as the pause undo.

`pre_state` / `post_state` for a budget move: `{ campaign_id, daily_budget_cents }`.

## 10. Schema changes (Supabase migration -- same carve-out as prior slices)

CLAUDE.md's "schema via prisma migrate" governs only `shopify_sessions`.
`guardrail_config` is Supabase-managed, so this is applied via Supabase migration
tooling (per ingestion spec Section 10).

One additive migration -- `ALTER TABLE guardrail_config` to add loop settings,
all with sane defaults so existing shops keep working, plus the lock table:

```
target_roas              numeric  default 2.0
budget_step_pct          numeric  default 0.20
budget_floor_cents       integer  default 500     -- $5/day floor
budget_ceiling_pct       numeric  default 0.20
lose_band                numeric  default 0.90
win_band                 numeric  default 1.20
min_spend_7d_cents       integer  default 2000    -- $20/7d minimum before acting

-- overlap guard
create table budget_loop_lock (
  shop_id uuid primary key references shops(id) on delete cascade,
  locked_at timestamptz not null
);
```

No new `alerts` migration -- loser alerts reuse the existing dedup unique
constraint `(shop_id, detector_id, entity_ref, day_bucket)` from the reorder
slice, keyed on `entity_ref->>'campaign_id'`.

No `prisma/schema.prisma` change -> no Prisma migration, no codegen impact. The
exact migration filename/timestamp is posted for agreement before writing
(Section 11) so the parallel session's migrations do not collide.

## 11. Coordination with the parallel session (shared files)

- `app/lib/types.ts`: the only edit is appending `"increase_campaign_budget"` to
  the `ActionKind` union. No `DetectorId` change (both loser detectors already
  exist), no `Campaign`/`SKU`/`Alert` change. The other session should not also
  touch that union line. If we later add a winner ("scaling opportunity") alert,
  that one `DetectorId` value is agreed jointly then.
- `supabase/migrations/`: this slice claims exactly one additive migration
  (Section 10). Filename/timestamp posted for agreement before writing -- not
  numbered blindly.
- One brain: the loop does not build a recommendation engine. Loser detections
  are standard `alerts` + `alert_context` rows, so Analytics (#2) reads them
  through `v_alerts_view` with their existing `claude_rank` / `dollar_impact` /
  narrative. The loop acts; the alerts it leaves are the single advice source.
- DTOs at the boundary: the loop is server-only (cron -> Supabase). The only
  client-facing surfaces (audit log, alerts) keep going through the existing
  `rowToAlert` / `rowToAudit` mappers; no raw Supabase row reaches the client.

## 12. Error handling (rule 12)

- Per campaign failure (insights gap, budget-write rejection): log, skip that
  campaign, continue. A rejected Meta budget write does not produce a "succeeded"
  audit row.
- Per shop failure: log, continue to the next shop -- one shop's failure never
  denies others their reallocation. The shop lock is released in `finally`.
- The cron route returns JSON counts:
  `{ shopsProcessed, cutsApplied, feedsApplied, freedCents, blocked, alertsUpserted, alertsResolved, errors }`,
  logged. Non-zero `errors`/`blocked` is visible, never swallowed.

## 13. Testing (rule 9 -- behavior, not coverage theater)

- `score.ts` -- classification at each band edge (1.0, `target*0.9`,
  `target*1.2`); the `minSpend7dCents` hold; cut math + floor; `planFeeds` fill
  order by ROAS + ceiling; two-phase neutrality including the partial-pool case
  (blocked cut shrinks the pool, total never rises); `dollar_impact` +
  `claude_rank` ordering; recovery (no-longer-breaching -> resolve).
- Guardrail gate -- each block reason in isolation (out-of-hours including the
  wraparound window, cooldown, over-cap, daily-budget-exhausted) and the pass
  case; used-today summed from `action_audit`, not hardcoded.
- Meta calls -- fake client asserts request path/body for `fetchCampaignInsights`
  + `setCampaignBudget`; `purchase_roas` array parsing (omni_purchase pick,
  missing -> 0), spend->cents, pagination follow; a Graph `error` payload throws.
- Idempotency -- a second run with the same `tickHour` returns the prior audit and
  applies no second Meta write (deterministic key via `action_idempotency`).
- Undo -- fake client asserts the restore call uses `pre_state.daily_budget_cents`
  and that a Meta failure writes no inverse row.
- Audit dollar impact -- `actions.execute` persists `dollar_impact_at_exec` for a
  budget move, and the gate reads it back.

Test runner: Vitest (already present -- see `app/lib/**/__tests__`).

## 14. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm test` -> `npm run
typecheck` -> `npm run lint` -> `npm run build`, all green with evidence, before
any commit. No `prisma/schema.prisma` change -> no Prisma migration/codegen. The
`guardrail_config` migration is applied via Supabase tooling and `npx prisma
validate` is unaffected.

## 15. Open items deferred to the plan

- Whether the hourly schedule lives in `vercel.json` `crons` alongside
  `cron.ingest` or as a separate entry; interval tuning.
- Stale-lock timeout value for `budget_loop_lock` (how long before a crashed run's
  lock is considered abandoned).
- Whether `budget_floor_cents` / `min_spend_7d_cents` should be per-campaign vs
  one shop default.
- A first-class winner ("scaling opportunity") alert -- needs a coordinated
  `DetectorId` value if we decide to surface winner feeds as alerts rather than
  audit-only.
