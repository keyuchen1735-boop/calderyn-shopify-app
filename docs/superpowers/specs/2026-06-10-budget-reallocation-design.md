# Budget Reallocation — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorming complete)

## Summary

Let a merchant (or autopilot, or the MCP assistant) move ad spend from one
integration to another — e.g. $5/day from a Google Ads campaign to a Meta
campaign. Ad platforms have no account-level budget, so a reallocation is
always "reduce campaign A's daily budget by N cents, increase campaign B's
by N cents", executed as ONE composite action with compensation on failure.

Decisions made during brainstorming:

- **Granularity:** hybrid — the app auto-suggests a source/destination
  campaign pair from grades; the user can override both before confirming.
- **Atomicity:** reduce source first (fails safe: under-spend, never
  over-spend). Permanent failure on the destination increase compensates by
  restoring the source budget. Compensation results are always visible.
- **UI:** Polaris modal on `app.campaigns._index`, following the existing
  `CampaignActionModal` pattern.
- **Trigger scope:** full — manual UI, MCP `propose_action`, and autopilot.
- **Architecture:** composite action kind `reallocate_budget` with one
  append-only `action_audit` row per reallocation (Approach A; the
  two-linked-rows and saga-table alternatives were rejected as more total
  complexity for no v1 benefit).

## Data model

One migration:

```sql
alter type public.action_kind add value if not exists 'reallocate_budget';
```

No new tables. (`reallocate_inventory` already exists in the enum and is an
unrelated inventory-side concept.)

Audit row shape (one row per reallocation):

- `params`: `{ source_campaign_id, source_external_id, source_platform,
  dest_campaign_id, dest_external_id, dest_platform, amount_cents,
  source_new_budget_cents, dest_new_budget_cents, step,
  external_id, platform, daily_budget_cents, compensation? }`
  - `external_id` / `platform` / `daily_budget_cents` are written as the
    DEST values when a row is parked `retrying`, so the existing
    single-adapter retry drain replays it unchanged.
  - `step`: `"increase_dest"` is the only parkable step (see Failure
    semantics).
  - `compensation`: `"succeeded" | "failed"`, present only when
    compensation ran.
- `pre_state` / `post_state`:
  `{ source: { daily_budget_cents }, dest: { daily_budget_cents } }`

## Core orchestrator

New `app/lib/actions/reallocate.server.ts` exporting
`executeReallocation(shopId, input, sb)` with
`input = { alertId, sourceCampaignId, destCampaignId, amountCents,
idempotencyKey, actor }`, mirroring `executeAction`'s sequence:

1. **Idempotency** — same lookup as `executeAction`; a prior attempt
   returns its REAL outcome (may be `retrying` or `failed`).
2. **Ownership + validation** — load both campaigns shop-scoped from
   `ad_campaign_dim`. Reject:
   - source and destination are the same campaign;
   - either `daily_budget_cents` is null (not daily-budgeted);
   - `amountCents <= 0`;
   - `amountCents >= source daily_budget_cents` (source must stay above
     zero — emptying a campaign is an explicit pause, not a reallocation).
   - Same-platform pairs are ALLOWED; suggestions merely prefer
     cross-platform.
3. **Step 1 — reduce source**: `sourceAdapter.setDailyBudget(source_external,
   current − amount)`. ANY failure here → terminal `failed` audit row
   (nothing changed on any platform; no compensation, no retry parking —
   deliberate simplification, the merchant just retries; visible in
   `last_error`).
4. **Step 2 — increase dest**: `destAdapter.setDailyBudget(dest_external,
   current + amount)`.
   - Transient failure → park `retrying`, `attempts = 1`,
     `params.step = "increase_dest"`, replay params set to dest values.
   - Permanent failure → compensate: restore source to its original
     budget. Record `params.compensation` + `last_error`; a failed
     compensation is loudly visible, never silent (rule 12).
5. **One audit row + idempotency insert** — same as today. Missing adapter
   on either side fails fast before any platform call
   (`"<platform> not connected"`).

## Retry drain (`app/lib/actions/retry.server.ts`)

- Add `reallocate_budget` to `EXECUTOR_REGISTRY`: replays ONLY the dest
  increase using the standard `ReplayParams` fields (already written as
  dest values at park time); `post_state` returns the two-sided shape.
- New compensator map, consulted ONLY on the drain's terminal-failure path
  (permanent error or `MAX_ATTEMPTS` exhausted): restores the source budget
  from `params`, records `params.compensation`, then marks `failed`.
  Compensation failure is appended to `last_error`.

## Undo (`app/lib/actions/undo.server.ts`)

New `reallocate_budget` branch: resolves BOTH adapters, restores dest
first, then source (reduce-before-increase ordering again — a mid-undo
failure leaves under-spend, never over-spend), appends the usual swapped
pre/post audit row with `undo_of`.

## Guardrails

`guardrails.ts` (pure) accepts a widened local union
`GuardedKind = ExecutableKind | "reallocate_budget"`; `ExecutableKind`
itself stays the single-campaign union `executeAction` handles.

- `dollarImpactCents` = `amount_cents` (existing dollar cap covers it).
- `maxBudgetCutPct` applies to the SOURCE cut (`amount / source_budget`).
- `minSpendCents` checks the source campaign's spend.
- Cooldown applies to BOTH campaigns: new optional fact
  `minutesSinceLastActionOnDestCampaign: number | null`; either campaign in
  cooldown blocks. `guardrails.server.ts` computes both lookups. Existing
  callers unchanged.
- Daily action cap + business hours unchanged (one reallocation = one
  action).

## Suggestion logic

New shared helper `app/lib/actions/reallocation-suggest.server.ts`, used by
BOTH the UI loader and autopilot (one implementation, no drift):

- **Source:** worst-graded (`poor` over `okay`) active campaign with a
  non-null daily budget.
- **Destination:** best `winning` active campaign with a non-null daily
  budget on a DIFFERENT platform than the source, tie-broken by 7-day
  ROAS. Returns `null` when no winning cross-platform candidate exists —
  callers fall back rather than force a bad pick.
- Grades read from the latest `campaign_grade_fact` row per campaign.

## Autopilot (`app/lib/actions/autopilot.server.ts`)

For `BUDGET_DETECTORS` (`ad_tax_overload`), where today it cuts the source
budget by `maxCutPct`:

- Suggestion helper returns a destination → execute `reallocate_budget` of
  the same cut amount (spend is redirected to a winning campaign instead of
  shrunk). Actor `"autopilot"`, idempotency key
  `autopilot:{alert_id}:reallocate_budget`.
- No destination → fall back to today's `reduce_campaign_budget` behavior,
  unchanged.
- Guardrails (including dual cooldown) gate either path; blocked actions
  count in `blocked` as today.

## MCP

- `app/lib/types.ts`: add `"reallocate_budget"` to `ActionKind`.
- `app/lib/calderyn.server.ts`: `propose_action` accepts the kind with
  validated params (`source_campaign_id`, `dest_campaign_id`,
  `amount_cents`), following the same path other kinds take today.

## UI (`app/routes/app.campaigns._index.tsx`)

- **Trigger:** "Reallocate budget" secondary action in the page header,
  enabled only when ≥ 2 daily-budgeted active campaigns exist; plus a
  per-row "Reallocate from…" action that pre-sets that campaign as source.
- **Loader:** extends the existing loader with the suggestion pair and each
  campaign's grade. DTO-shaped; no raw rows leaked.
- **Modal:** new `ReallocateBudgetModal` beside `CampaignActionModal`:
  - Source/destination `Select`s grouped by platform, options labeled
    `Platform · Name · $X/day · grade`, pre-filled from the suggestion,
    freely overridable.
  - Amount `TextField` (dollars, `$` prefix; converted to cents at the
    boundary).
  - Live summary line, e.g. "Google · Brand Search: $20 → $15/day — Meta ·
    Prospecting: $10 → $15/day".
  - Confirm disabled until valid (distinct campaigns, both budgeted,
    `0 < amount < source budget`) with inline error text. App Bridge toast
    on result; `retrying` uses the existing "parked for retry" messaging.
- **Route action:** new `intent=reallocate` branch — re-validates all
  `FormData` server-side, calls `executeReallocation`, `redirect()` after
  success per repo convention.

## Testing (vitest; mock supabase chain + mock adapters, same fixtures as existing action tests)

- **Orchestrator:** success writes one audit row with two-sided pre/post;
  idempotent replay returns prior outcome; ownership rejection; every
  validation rejection; source-step failure → terminal `failed`, nothing
  parked; dest-step transient → `retrying` with dest replay params;
  dest-step permanent → compensation restores source +
  `compensation: "succeeded"`; compensation failure →
  `compensation: "failed"` visible.
- **Retry drain:** parked reallocation replays dest only; terminal
  exhaustion triggers the compensator.
- **Undo:** both budgets restored, dest first.
- **Guardrails:** source cut %, dual cooldown (either side blocks), dollar
  cap on amount.
- **Autopilot:** reallocates when a destination exists; falls back to
  reduce when it doesn't.
- **Suggestion:** worst source / winning cross-platform dest; null when
  none.
- **Route action:** rejects malformed `FormData`; happy path returns
  outcome.

## Known accepted risks

- Crash window between the two platform calls (process dies after the
  source reduce, before the audit insert): the same exposure the existing
  single-step executor already accepts between platform call and audit
  insert. The saga-table alternative that closes it was rejected for v1.
- A transient failure on the SOURCE step is reported terminal rather than
  parked — losing auto-retry for that case in exchange for keeping the
  single-adapter retry drain shape. Manual retry covers it.
