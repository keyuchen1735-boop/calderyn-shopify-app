# Design: Ad-Budget Reallocation Loop (Constant-Analysis, Slice 1 — the ad-budget half)

**Date:** 2026-06-02
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY`

---

## 1. Context

The "constant analysis" idea is a winner/loser money loop: **ad winning + stock
low → buy more; ad losing → cut its budget; move the freed budget to the
winner.** Only `reorder_timing` exists as a built detector; the campaign
detectors and the budget-shift action are not built.

State of each piece the full loop needs:

| Piece | State today |
|---|---|
| Ad performance data (spend, ROAS per campaign) | Campaigns are **live-fetched** from Meta for pause/resume, but `roas_7d`/`spend`/`margin` come back `0` — no insights are pulled. |
| Ad spend coupled to a SKU (creative→SKU map) | Does not exist (onboarding has an unbuilt `creative_mapping` step). |
| Detectors `campaign_below_breakeven`, `negative_unit_economics` | Named in `DetectorId` (`app/lib/types.ts`) but not built. |
| `reduce_campaign_budget` action | Framework only — records an `action_audit` row, **never calls Meta**. |
| Increase / shift-budget action | Does not exist as an `ActionKind`. |
| `create_po_draft` action | Framework only — no real PO. |
| Cadence | One daily-ish cron (`app/routes/cron.ingest.tsx`). |
| Guardrails (daily action budget, $ cap, cooldown, business hours) | **Displayed, not enforced** — `actions.execute` just records audit; `daily_action_budget_used` and `in_business_hours` are hardcoded. |

The full idea spans four subsystems (ad-data ingestion, creative→SKU mapping,
new detectors, new/real actions) — too large for one spec. It is decomposed:

- **Slice 1 (this doc):** the **ad-budget half** — cut the loser *and* feed the
  winner — because Meta is already wired (OAuth, live campaigns, real
  pause/resume from the 2026-06-01 Meta actions slice), so it is the shortest
  path to a working "money moves automatically" loop.
- Slice 2 (later): the stock-coupled "buy more" half — `create_po_draft` +
  creative→SKU mapping.

## 2. Goal & success criteria

After a merchant connects Meta and sets a target ROAS, on each hourly tick:

1. The loop fetches every active campaign's 7-day spend + ROAS from Meta
   insights (no more `0` placeholders).
2. Each campaign is classified against the merchant's target ROAS:
   losing-outright, below-breakeven, winner, or hold.
3. Budget is shifted in small **budget-neutral** steps: losers cut by a bounded
   %, the freed dollars fed to winners up to a per-tick ceiling; total spend
   never rises.
4. Every move passes the **guardrail gate** before any Meta call. A blocked move
   makes/keeps an alert for manual approval and does **not** call Meta.
5. Every executed move is a real Meta budget write **and** an undoable
   `action_audit` row; Undo restores the prior `daily_budget` on Meta.
6. Losers always leave a standard `alerts` row (`campaign_below_breakeven` /
   `negative_unit_economics`) so the Analytics surface (#2) shows the "why".
7. One bad campaign or shop is logged and skipped — never aborts the rest; the
   cron returns a JSON summary.

## 3. Non-goals

- The stock/PO half (`create_po_draft`, `scaling_sku_fulfillment_risk`,
  `sku_stockout_vs_spend`, creative→SKU mapping) — Slice 2.
- Meta ad **ingestion** into `v_campaigns_flat` (Slice 2 of the data pipeline).
  Campaigns + insights are **live-fetched**, decoupled from that work.
- QuickBooks COGS / true contribution margin — deferred; this slice uses a
  **merchant-set target ROAS** as the win/lose line instead.
- Google Ads.
- Event-driven triggers / sub-hourly cadence — hourly cron is enough given
  Meta's ~15–60 min insights lag.
- A general detector/action framework — the guardrail gate is written to be
  reusable, but no registry/engine is built ahead of need.

## 4. Decisions (confirmed in brainstorming)

| Decision | Choice |
|---|---|
| Which slice first | Ad-budget loop (cut loser **and** feed winner). |
| Auto vs propose | **Auto-execute, guardrailed.** Moves within guardrails fire on their own; over-cap/out-of-window moves become manual-approval alerts. |
| Cadence | **Hourly cron** (`cron.budget-loop.tsx`), tunable interval. |
| Win/lose signal | **Merchant-set target ROAS** in `guardrail_config`. |
| Budget-move policy | **Small bounded steps, budget-neutral** — total ad spend never rises; money shifts loser→winner gradually. |
| Build approach | **New modules mirroring existing seams** (pure score fn + server runner + Meta client extension + reusable gate). |

## 5. Architecture

```
cron.budget-loop.tsx  (hourly, Authorization: Bearer CRON_SECRET)
        │
        ▼
  loop.server.ts ── per Meta-connected shop ──┐
        │                                      │
   listCampaigns() + fetchCampaignInsights()   ← 7d spend + ROAS
        │
   score()  (pure) → cuts + feeds + loser AlertDrafts
        │
   for each move → guardrail gate ── execute? ──► setCampaignBudget() on Meta
        │                                          + actions.execute (audit, undoable)
        └──────────────────────── block? ──────► leave/refresh alert, no Meta call
        │
   losers → upsert standard alerts + alert_context rows
```

Background Meta access reuses the existing `metaClientForShop(shop)` seam (loads
+ decrypts the stored token), so the cron calls Meta without an inbound request,
exactly like `cron.ingest` uses `unauthenticated.admin`.

### 5.1 Module layout

| New / changed | Responsibility | Testable now? |
|---|---|---|
| `app/lib/budget/score.ts` | **Pure**: classify campaigns + plan budget moves. Carries the unit-test weight. | ✅ |
| `app/lib/budget/loop.server.ts` | Orchestrate one shop: fetch → score → gate → execute → alert. | ✅ fakes |
| `app/lib/budget/guardrails.server.ts` | The **enforce gate** (today guardrails only display). Reusable by future auto-actions. | ✅ |
| `app/lib/meta/campaigns.server.ts` | `+ fetchCampaignInsights()`, `+ setCampaignBudget()`. | ✅ fake client |
| `app/routes/cron.budget-loop.tsx` | Hourly route; same Bearer auth + JSON summary as `cron.ingest`. | via loop |
| `app/lib/types.ts` | `+ "increase_campaign_budget"` in the `ActionKind` union (**one line**). | — |
| `audit.undo` (`app/lib/calderyn.server.ts`) | Restore prior `daily_budget` on Meta for budget actions. | ✅ fake client |

## 6. Scoring (`budget/score.ts`, pure)

Input per campaign: `{ id, name, dailyBudgetCents, spend7dCents, roas7d }`.
Config from `guardrail_config`: `targetRoas`, `loseBand` (0.9), `winBand`
(1.2), `stepPct` (0.20), `floorCents`, `ceilingPct` (0.20).

**Eligibility:** only `ACTIVE` campaigns that expose a **campaign-level**
`daily_budget`. Campaigns whose budget lives at the ad-set level (no campaign
`daily_budget`) are skipped with a logged reason — Meta won't accept a
campaign-level budget write there. (Ad-set-level budget control is a later
enhancement.)

**Classify** (against `targetRoas`):

| ROAS | Class | Detector / role | Severity |
|---|---|---|---|
| `< 1.0` | losing money outright | `negative_unit_economics` | critical |
| `1.0 … targetRoas·loseBand` | under breakeven | `campaign_below_breakeven` | high |
| `> targetRoas·winBand` | winner | feed candidate | — |
| in between | hold | — | — |

**Plan moves (budget-neutral, never raises total spend):**

1. Each loser: `cut = round(dailyBudget·stepPct)`,
   `new = max(floorCents, dailyBudget − cut)`, `freed = dailyBudget − new`.
2. `pool = Σ freed`.
3. Winners ranked by ROAS desc; each may take up to
   `round(dailyBudget·ceilingPct)` this tick. Fill highest-ROAS first until the
   pool is empty or all winners are at their ceiling.
4. Any leftover pool (no winner capacity) simply stays cut — total spend dips
   that tick. We never force spend onto a winner, so "budget-neutral" means
   *≤ neutral*: spend may fall, never rise.

**Loser `dollar_impact`** (drives `claude_rank` + narrative, dollars):
`spend7d · max(0, 1 − roas/targetRoas)` — for `negative_unit_economics` this is
effectively all of `spend7d`. Losers are ranked by it descending, mirroring
`reorder_timing`.

**Output:**

- `BudgetMove[] = { campaignId, name, fromCents, toCents, deltaCents, role: 'cut' | 'feed' }`
- `AlertDraft[]` for losers (same shape family as the reorder detector):
  `entity_ref = { campaign_id, name }`, `severity`, `dollar_impact`,
  `claude_rank`, templated `claude_narrative`, `evidence = { roas7d, spend7d_cents, daily_budget_cents, target_roas, decision, delta_cents }`.

**Worked tick** (target 2.0):

```
A roas 0.7  $50 → negative_unit_economics → cut to $40  (freed $10)
B roas 1.7  $30 → campaign_below_breakeven → cut to $24  (freed $6)
C roas 3.1  $80 → winner   → +$16 (pool $16, ceiling $16) → $96
   pool $16 fully placed → total spend unchanged
```

## 7. Guardrail gate (`budget/guardrails.server.ts`)

Replaces today's display-only behavior. Each move is checked **in order**; the
first failure blocks auto-execution — the move becomes (or refreshes) a
manual-approval alert and **no Meta call is made**:

1. **Business hours** — `now` (in the shop's `timezone`) outside
   `[business_hours_start_utc, business_hours_end_utc]` → block.
2. **Cooldown** — the campaign had a budget action within
   `cooldown_minutes_per_campaign` (most recent `action_audit.completed_at` for
   that campaign) → skip this tick.
3. **Per-action $ cap** — `|deltaCents| > dollar_impact_cap_without_2fa·100` →
   block → manual-approval alert (the "2FA over threshold" path).
4. **Daily action budget** — running `Σ |deltaCents|` already executed today
   must stay ≤ `daily_action_budget·100`. The gate computes *used today* from
   `action_audit` (sum of `|dollar_impact_at_exec|` for budget kinds, shop,
   today) — killing the hardcoded `used = 0`.

Returns `{ decision: 'execute' | 'block', reason }`. A blocked move's reason is
carried into the alert so the merchant sees why it wasn't auto-applied.

## 8. Meta client additions (`app/lib/meta/campaigns.server.ts`)

Same injected-client + `check()`-on-error pattern as the existing
`listCampaigns` / `setCampaignStatus`. Pinned Graph version (`v21.0`).

- `fetchCampaignInsights(client, adAccountId)` →
  `GET /act_<id>/insights?level=campaign&date_preset=last_7d&fields=campaign_id,spend,purchase_roas`
  → `Record<campaignId, { spend7dCents, roas7d }>`. Missing `purchase_roas`
  (no conversions yet) → `roas7d = 0`. A Graph `error` payload throws (never
  swallowed).
- `setCampaignBudget(client, campaignId, dailyBudgetCents)` →
  `POST /<campaign-id>` body `daily_budget=<cents>` → `{ success: true }`;
  Graph `error` → throw.

## 9. Undo

Extends the existing `audit.undo` (which already restores prior **status** for
`pause_campaign`). For `reduce_campaign_budget` and `increase_campaign_budget`:
read the original audit's `pre_state.daily_budget_cents`, call
`setCampaignBudget(client, metaCampaignId, prior)`, then write the inverse audit
row. If the Meta call fails, **no inverse row is written** and the error
surfaces — same contract as the pause undo.

`pre_state` / `post_state` for a budget move:
`{ campaign_id, daily_budget_cents }`.

## 10. Schema changes (Supabase migration — same carve-out as prior slices)

CLAUDE.md's "schema via `prisma migrate`" governs only `shopify_sessions`.
`guardrail_config` is Supabase-managed, so this is applied via Supabase
migration tooling (per ingestion spec §10).

**One additive migration** — `ALTER TABLE guardrail_config` to add the loop
settings, all with sane defaults so existing shops keep working:

```
target_roas              numeric  default 2.0
budget_step_pct          numeric  default 0.20
budget_floor_cents       integer  default 500     -- $5/day floor
budget_ceiling_pct       numeric  default 0.20
lose_band                numeric  default 0.90
win_band                 numeric  default 1.20
```

**No new `alerts` migration.** The loser alerts reuse the existing dedup unique
constraint `(shop_id, detector_id, entity_ref, day_bucket)` from the reorder
slice, keyed on `entity_ref->>'campaign_id'`.

**No `prisma/schema.prisma` change** → no Prisma migration, no codegen impact.

## 11. Coordination with the parallel session (shared files)

Two files are shared; this slice's footprint is pinned to avoid collisions:

- **`app/lib/types.ts`:** the *only* edit is appending `"increase_campaign_budget"`
  to the `ActionKind` union. No `DetectorId` change (both loser detectors
  already exist), no `Campaign`/`SKU`/`Alert` change. The other session should
  not also touch that union line.
- **`supabase/migrations/`:** this slice claims exactly **one** additive
  migration (§10, the `guardrail_config` ALTER). Its filename/timestamp is
  posted for agreement before writing — not numbered blindly.
- **One brain:** the loop does **not** build a recommendation engine. Loser
  detections are written as standard `alerts` + `alert_context` rows, so the
  Analytics surface (#2) reads them through `v_alerts_view` with their existing
  `claude_rank` / `dollar_impact` / narrative. The loop *acts*; the alerts it
  leaves are the single advice source.
- **DTOs at the boundary:** the loop is server-only (cron → Supabase). The only
  client-facing surfaces (audit log, alerts) keep going through the existing
  `rowToAlert` / `rowToAudit` mappers; no raw Supabase row reaches the client.

## 12. Error handling (rule 12)

- Per **campaign** failure (insights gap, budget-write rejection): log, skip
  that campaign, continue. A rejected Meta budget write does **not** produce a
  "succeeded" audit row.
- Per **shop** failure: log, continue to the next shop — one shop's failure
  never denies others their reallocation.
- The cron route returns JSON counts:
  `{ shopsProcessed, moved, freedCents, blocked, alertsUpserted, errors }`,
  logged. Non-zero `errors`/`blocked` is visible, never swallowed.

## 13. Testing (rule 9 — behavior, not coverage theater)

- **`score.ts`** — synthetic campaigns assert: classification at each band edge
  (1.0, target·0.9, target·1.2); cut math + floor; winner fill order by ROAS +
  ceiling; budget-neutrality (Σ feeds ≤ Σ cuts, total never rises);
  `dollar_impact` + `claude_rank` ordering.
- **Guardrail gate** — each block reason fires in isolation (out-of-hours,
  cooldown, over-cap, daily-budget-exhausted) and the pass case executes;
  *used-today* is summed from `action_audit`, not hardcoded.
- **Meta calls** — fake client asserts request path/body for
  `fetchCampaignInsights` + `setCampaignBudget`, the cents/ROAS parsing, and that
  a Graph `error` payload throws.
- **Undo** — fake client asserts the restore call uses `pre_state.daily_budget_cents`
  and that a Meta failure writes no inverse row.

Test runner: Vitest (already present — see `app/lib/**/__tests__`).

## 14. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm test` →
`npm run typecheck` → `npm run lint` → `npm run build`, all green with evidence,
before any commit. No `prisma/schema.prisma` change → no Prisma
migration/codegen. The `guardrail_config` migration is applied via Supabase
tooling and `npx prisma validate` is unaffected.

## 15. Open items deferred to the plan

- Exact Meta insights field handling when `purchase_roas` is an array vs scalar
  across campaigns with multiple action types.
- Whether the hourly schedule lives in `vercel.json` `crons` alongside
  `cron.ingest` or as a separate entry; interval tuning.
- Surfacing winner feeds in the UI (audit-only for now; a "scaling" alert/
  detector id is a possible later addition).
- Whether `budget_floor_cents` should be per-campaign vs one shop default.
