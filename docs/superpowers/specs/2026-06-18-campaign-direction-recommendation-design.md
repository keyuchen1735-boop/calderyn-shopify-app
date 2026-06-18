# Campaign Direction Recommendation — Design Spec

**Date:** 2026-06-18
**Surfaces:** Shopify embedded admin (Polaris) **and** Calderyn dashboard (`app/routes/dashboard.*`) — both ship.
**Status:** Approved design, pending spec review → implementation plan.

## Problem

A merchant can click a campaign on either surface and see metrics, but the system gives no
single, plain-English answer to the only question they actually have: **"what do I do with
this campaign?"** Today "direction" is implied piecemeal by which alert fired
(`campaign_below_breakeven` → pause, `ad_tax_overload` → reduce, `campaign_scaling_opportunity`
→ scale up) and there is no unified recommender. The merchant must infer the call from raw
ROAS numbers.

## Goal

On the campaign detail view of **both** surfaces, show:

1. The full ad-efficiency metric set for the campaign.
2. A single **recommended direction** — one of `Scale up` / `Keep` / `Scale down` / `Pause`.
3. A **short plain-English "why"** (one sentence).
4. A **one-click action** that executes the recommended direction via the existing
   `executeAction` path.

Success = on both surfaces, opening a campaign renders the four metric tiles, a tone-colored
direction badge, a why-sentence, and (when the direction is actionable) a primary button that
performs the action. The direction is computed deterministically and is identical on both
surfaces for the same campaign.

## Non-goals (YAGNI)

- No new detectors, no Python engine changes, no changes to how grades are computed.
- No autopilot / auto-execution — every action stays merchant-initiated (one click, not zero).
- No historical "reasoning timeline" UI beyond the cache table.
- No new metrics beyond the four below plus the spend/budget context already shown.
- No resume-suggestion logic for paused campaigns in v1 (paused → "Keep paused", advisory only).

## Metric set (both detail views)

Per the "all of the above" decision, with the POAS/real-ROAS duplication resolved by
**unifying into one POAS tile**:

| Tile | Value | Source |
|---|---|---|
| **Reported ROAS** | `revenue / spend` | `roas_7d` (already shown both surfaces) |
| **Break-even ROAS** | `1 / margin` | `campaign_grade_fact.break_even_roas`; fallback `1/contributionMargin`. **New on embedded** (dashboard already has it as a sparkline ref line — add an explicit tile). |
| **Profit ROAS (POAS)** | `roas × margin` (= gross profit ÷ ad spend) | Embedded already computes this as `realRoas`; **retire the "Real return" label and rename to "Profit ROAS (POAS)"**. Add the tile to the dashboard. |
| **Contribution margin** | margin rate 0–1, shown as % | `contribution_margin` (already shown both surfaces) |

Context tiles already present (spend 7d, daily budget, revenue) stay as-is.

> **Resolved conflict (rule 7):** gross POAS ≡ margin-adjusted "real ROAS". We show it **once**,
> labeled "Profit ROAS (POAS)", rather than two tiles with an identical number.

Missing data is shown as "—" (rule 12 — never fabricate a 0/￼value).

## Architecture

Approach **C** (shared deterministic TS recommender + Claude phrasing + Postgres cache). The
dashboard is in this repo (`app/routes/dashboard.*`), so both surfaces import the same module —
shared code, not just a shared contract.

### 1. Recommender — `app/lib/actions/direction.server.ts`

Pure function, no I/O. Reuses the **exact** grade thresholds from
`engine/calderyn_engine/grade.py` (`GRADE_OK_FACTOR = 0.95`, `GRADE_WIN_FACTOR = 1.2`) so it can
never disagree with the displayed grade (rule 11).

```ts
type Direction = "scale_up" | "keep" | "scale_down" | "pause";
type ExecutableKind = "pause_campaign" | "reduce_campaign_budget" | "increase_campaign_budget";

interface DirectionInput {
  roas: number | null;
  breakEvenRoas: number | null;
  status: "active" | "paused";
  hasScalingHeadroom: boolean;   // scaling_opportunity alert OR guardrails allow an increase
  pauseAlertActive: boolean;     // campaign_below_breakeven | negative_unit_economics open
}
interface DirectionResult {
  direction: Direction;
  actionKind: ExecutableKind | null;  // null when "keep"
  dataSufficient: boolean;
}
```

Decision table (evaluated top-down):

| Condition | `direction` | `actionKind` |
|---|---|---|
| `roas == null \|\| breakEvenRoas == null \|\| breakEvenRoas <= 0` | `keep` (insufficient data) | `null` |
| `status === "paused"` | `keep` (paused) | `null` |
| `pauseAlertActive` **or** `roas < 0.7 × BE` | `pause` | `pause_campaign` |
| `0.7 × BE ≤ roas < 0.95 × BE` | `scale_down` | `reduce_campaign_budget` |
| `0.95 × BE ≤ roas < 1.2 × BE` | `keep` | `null` |
| `roas ≥ 1.2 × BE` **and** `hasScalingHeadroom` | `scale_up` | `increase_campaign_budget` |
| `roas ≥ 1.2 × BE` (no headroom) | `keep` | `null` |

The `0.7 × BE` "pause floor" is the only new tunable constant; all other boundaries mirror the
existing grade factors. Open pause-detector alerts override into `pause`, keeping the recommender
consistent with the autopilot detector→action mapping that already exists
(`app/lib/actions/autopilot.server.ts`).

### 2. Reasoning — `app/lib/actions/direction-reason.server.ts`

Generates the one-sentence "why". **The direction is already decided** — Claude is given it as a
fact to explain, never to choose (rule 5: the model does language work only).

- Calls Claude through the existing `app/lib/assistant/anthropic.server.ts` client.
- Input to the model: direction + the four metrics + grade. Output: ≤1 sentence, plain English,
  no jargon, no invented numbers.
- **Fallback:** on any error/timeout/missing-key, a deterministic template per direction
  (extends the `app/lib/scale-reason.ts` pattern to all four directions). The feature works with
  Claude entirely disabled.
- **The reason text is treated as advisory copy; the direction and action shown to the merchant
  always come from the deterministic recommender, even if the reason came from the template.**

### 3. Reasoning cache — Postgres table + migration

`supabase/migrations/20260618120000_campaign_direction_reason.sql`:

```sql
create table if not exists campaign_direction_reason (
  shop_id     uuid        not null references shop(id) on delete cascade,
  campaign_id text        not null,                 -- keyed as campaigns are keyed on each surface
  grade_day   date        not null,                 -- day_bucket of the grade used
  direction   text        not null,                 -- scale_up | scale_down | keep | pause
  reason      text        not null,
  source      text        not null,                 -- 'claude' | 'template'
  model       text,                                 -- model id when source='claude'
  created_at  timestamptz not null default now(),
  primary key (shop_id, campaign_id, grade_day, direction)
);
alter table campaign_direction_reason enable row level security;
```

- Key `(shop_id, campaign_id, grade_day, direction)` ⇒ **at most one Claude call per campaign per
  grade-day per direction**, durable across Vercel instances.
- If the direction flips intraday (e.g. a new alert fires), the key changes → fresh phrasing;
  otherwise the cached sentence is reused.
- RLS enabled to match the repo's table convention (service-role access; no client reads).

### Inputs per surface

Both surfaces already have everything the recommender needs:

- **Embedded** (`app/routes/app.campaigns.$campaignId.tsx`): `CampaignPerformance`
  (`reportedRoas`, `realRoas`, `contributionMargin`, `dailyBudgetCents`, `spend7dCents`) +
  the campaign's latest grade row for `break_even_roas` + open alerts (already loaded for the
  scale badge) + guardrails.
- **Dashboard** (`app/components/dashboard/screens/Campaigns.tsx` via `calderyn.server.ts`):
  `v_campaigns_flat` row (`roas_7d`, `spend_7d`, `contribution_margin`) joined with
  `campaign_grade_fact` (`break_even_roas`) + `app.alerts` + guardrails.

`hasScalingHeadroom` = an open `campaign_scaling_opportunity` alert **or**
`autopilot_max_budget_increase_pct > 0` in guardrails. `pauseAlertActive` = an open
`campaign_below_breakeven` / `negative_unit_economics` alert.

## UI

### Embedded admin (Polaris) — `app/routes/app.campaigns.$campaignId.tsx`

Add a **"Recommended direction"** `Card` above/beside the existing metric scorecard:

- `Badge` with tone: `scale_up` → `success`, `keep` → neutral (default), `scale_down` →
  `attention`, `pause` → `critical`.
- The why-sentence as `Text` (`bodyMd`, `subdued` for secondary clause).
- A primary `Button` whose label matches the action (e.g. "Scale budget", "Reduce budget",
  "Pause campaign"); clicking opens the **existing** `ScaleBudgetModal` / `CampaignActionModal`
  pre-filled. When `direction === "keep"` no button is shown.
- Add the **Break-even ROAS** tile and rename **Real return → Profit ROAS (POAS)** in the
  existing `InlineGrid`.

### Dashboard (`.cd-*` CSS) — `app/components/dashboard/screens/Campaigns.tsx`

Mirror with dashboard primitives (not Polaris):

- `Pill` with tone (`success` / neutral / `warn` / `critical`) for the badge.
- Why-sentence as `.cd-body` / `.cd-caption`.
- `Btn` (primary) that POSTs to the existing `dashboard.api.campaigns.$id.action` route with the
  recommended `type` + `idempotency_key` (+ `daily_budget_cents` for budget actions). Hidden when
  `keep`.
- Add **Break-even ROAS** and **POAS** tiles to the existing `.cd-stat-grid`.

## One-click action

Reuses the existing executable kinds end-to-end — **no new execution path**:

- `scale_up` → `increase_campaign_budget`
- `scale_down` → `reduce_campaign_budget`
- `pause` → `pause_campaign`
- `keep` → no action (button hidden/disabled)

Budget deltas reuse the existing convention (scale: `+autopilot_max_budget_increase_pct`;
reduce: existing reduce default). Idempotency keys reuse the existing per-modal pattern.

## Edge cases (fail visibly — rule 12)

- **Insufficient data** (null roas/break-even, margin ≤ 0): `direction = keep`, badge reads
  "Not enough data yet", no action button, metric tiles show "—". Never fabricate a direction or
  a placeholder metric value.
- **Paused campaign:** `keep` (paused), advisory only, no action.
- **Claude unavailable:** template fallback, `source='template'` recorded; direction unaffected.
- **Direction ≠ grade edge:** the thresholds are derived from the grade factors, so they agree by
  construction; a regression test pins this.

## Test plan (TDD, vertical slices)

Each slice is independently testable and lands red→green→refactor.

- **Slice 1 — recommender (`direction.server.ts`):** table-driven unit tests covering every row
  of the decision table, both boundaries of each threshold (`0.7/0.95/1.2 × BE`), null/paused/
  insufficient-data cases, and a regression test asserting direction never contradicts the grade.
- **Slice 2 — reasoning (`direction-reason.server.ts`) + cache:** mock the Anthropic client
  (precedent: `app/lib/assistant/__tests__/anthropic.test.ts`). Assert (a) Claude receives the
  decided direction + metrics, (b) Claude output **never changes** the direction/action,
  (c) error → template fallback with `source='template'`, (d) a second call for the same
  `(campaign, grade_day, direction)` hits the cache and does **not** call Claude.
- **Slice 3 — embedded detail:** loader returns the recommendation (recommender mocked); badge +
  four tiles render with correct tone; the action button POSTs the correct kind. (Precedent:
  existing route/component tests.)
- **Slice 4 — dashboard parity:** same coverage against the dashboard loader + action route
  (precedent: `dashboard-actions.live.test.ts`, `meta-call-budget.test.ts`).

A passing test must assert behavior, not just execution (rule 9): recommender tests assert the
*chosen direction*, reasoning tests assert *fallback + cache + direction-immutability*, UI tests
assert *rendered badge tone + posted action kind*.

## Implementation logistics

- Work in an isolated worktree per repo convention: `git worktree add ../calderyn-campaign-direction -b feat/campaign-direction`.
- Dashboard parity is built into the design (Slice 4), not a follow-up.
- Pre-commit gate (typecheck → lint → build → `prisma`/migration checks → `/code-review`) runs
  before any commit, per CLAUDE.md.

## Open risks

- **Budget-delta defaults** for scale-up/scale-down on the one-click button must match the
  existing modals exactly to avoid a second source of truth — verify the existing constants
  during the plan phase before coding.
- **`campaign_id` keying** differs between surfaces (dim uuid vs external id). The cache table and
  recommender must use whatever key the surface already uses for that campaign; confirm in the
  plan.
