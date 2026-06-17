# Custom-settable guardrails (dashboard + embedded admin)

- **Date:** 2026-06-17
- **Branch / worktree:** `feat/custom-guardrails` (`../calderyn-custom-guardrails`)
- **Status:** Approved design — ready for implementation plan

## Problem

A merchant's guardrails are the safety limits that bound every automated action
(daily dollar impact, per-action cap, cooldown, and the autopilot bounds). Today
the **web app dashboard** (`app/routes/dashboard.*`, rendered by
`app/components/dashboard/screens/Settings.tsx`) only lets a merchant pick from
**three fixed presets per guardrail** (daily budget = $250 / $500 / $1,000,
cooldown = 15m / 30m / 1h, etc.). A merchant who wants $750/day or a 45-minute
cooldown cannot set it.

The constraint is purely in the dashboard UI:

- The backend PUT (`app/routes/dashboard.api.guardrails.tsx`) and the server
  client (`calderynClient(...).guardrails.update`) already accept arbitrary
  values.
- The **embedded Shopify admin** settings page (`app/routes/app.settings.tsx`)
  already uses free-form number fields for the same guardrails.

So the dashboard is the surface that's behind. This change makes every dashboard
guardrail custom-settable, fixes a related business-hours gap, and exposes two
autopilot guardrails that exist but no UI currently surfaces.

## Goals

1. On the dashboard, every numeric guardrail is settable to any valid value, via
   **preset quick-picks + a "Custom" reveal** (the chosen control style — keeps
   the familiar one-tap presets, adds a custom field only when wanted).
2. The **business-hours window** (start / end) becomes editable on **both**
   surfaces (dashboard + embedded admin), satisfying the parity rule.
3. The two autopilot scale-up guardrails — **max budget-increase %** and the
   **absolute daily-budget ceiling** — become custom-settable (they exist in the
   DB and are enforced, but no UI sets them today).
4. All guardrail writes pass through **one shared validator** with sane bounds,
   used by both the dashboard route and the embedded-admin action.

## Non-goals / guiding constraint

- **Do not make the merchant's screen busier.** The default view should look
  essentially like today's screen plus a "Custom" option and one toggle.
  Advanced controls stay hidden until the merchant asks for them (see
  "Merchant-facing UX" below). This constraint overrides any pull toward
  exposing more.
- No DB migration — every column already exists in `guardrail_config`.
- No change to the autopilot **enforcement** path (`actions/guardrails.server.ts`,
  `actions/guardrails.ts`, `withinBusinessHours`). We only change what's
  read/written/validated and how it's displayed.
- No timezone *picker* in the merchant UI (see Decision D2).

## Decisions

### D1 — Control style: presets + custom reveal
Each numeric guardrail keeps its preset chips; a "Custom" chip reveals a single
number input. Tapping a preset is one click and remains the common path. A
reusable component renders this so all six numeric fields share one tested
implementation.

### D2 — Business hours: editable, but no timezone dropdown
The merchant edits **Start** and **End** in their store's already-configured
timezone (`guardrail_config.timezone`). They never see a timezone dropdown and
never see UTC. The local↔UTC conversion is hidden, server-side.

A single toggle — **"Only act during business hours"** — maps to the existing
`guardrail_config.business_hours_only` column. Off (the default) means no window
is enforced and the Start/End fields are hidden; on reveals them.

### D3 — Scale-up caps live under autopilot
`autopilot_max_budget_increase_pct` and `autopilot_max_daily_budget_cents` are
shown only inside the autopilot block, which is collapsed/off by default. A
merchant who never turns on autopilot never sees them.

### D4 — Business-hours storage & DST caveat
`guardrail_config.business_hours_start_utc` / `business_hours_end_utc` are
**integer UTC hours**. We interpret the merchant's Start/End as wall-clock hours
in `timezone` and convert to/from a UTC hour using that zone's **current** UTC
offset.

- This **fixes a latent display bug**: today `rowToGuardrails` returns the raw
  UTC hour (e.g. `"14:00"`) but labels it with the shop's timezone, so the
  dashboard shows a wrong local time.
- **Accepted caveat:** a single integer UTC hour cannot track DST, so an
  enforced window can drift by ±1 hour for ~half the year. This matches the
  existing schema limitation and is acceptable for a soft, whole-hour action
  gate. Removing the drift would require changing the enforcement path (out of
  scope).

## Data contract (`GuardrailConfig` in `app/lib/types.ts`)

| Field | Today | Change |
|---|---|---|
| `business_hours_only: boolean` | in DB only, absent from the contract | **Add** to `GuardrailConfig` + `GuardrailVM`; read in `rowToGuardrails`, write in `guardrails.update` |
| `business_hours.{start,end}` | read-only (`guardrails.update` drops them; only `tz` is written) | **Persist** start/end as UTC hours (per D4) |
| `business_hours.{start,end}` (read) | returns raw UTC hour mislabeled with tz | **Convert** stored UTC hour → local time in `rowToGuardrails` (per D4) |
| `autopilot_max_budget_increase_pct` | in contract + server update, **absent from `PATCHABLE_KEYS`** | **Add** to `PATCHABLE_KEYS` |
| `autopilot_max_daily_budget_cents` | in contract + server update, **absent from `PATCHABLE_KEYS`** | **Add** to `PATCHABLE_KEYS` (`null` = no ceiling; preserve the `!== undefined` write semantics) |

`PATCHABLE_KEYS` in `dashboard.api.guardrails.tsx` gains `business_hours_only`,
`autopilot_max_budget_increase_pct`, and `autopilot_max_daily_budget_cents`.
(`business_hours`, `daily_action_budget_cents`, `dollar_cap_cents`, `cooldown_minutes`,
and the other autopilot keys are already listed.)

## Validation (single source of truth)

Move **all** field validation into `app/lib/dashboard/guardrails-validation.ts`
(`validateGuardrailPatch`), including the budget/cap/cooldown checks currently
inlined in the route. Call it from **both** the dashboard route **and** the
embedded-admin `update_guardrails` action (which today does no autopilot-bound
validation — a real gap). On failure return `422` with the **specific** field
error code (today the dashboard collapses all to `invalid_guardrails`).

| Field | Rule |
|---|---|
| `daily_action_budget_cents` | finite int, `> 0`, `<= 100_000_000` ($1,000,000) |
| `dollar_cap_cents` | finite int, `> 0`, `<= 100_000_000` |
| `cooldown_minutes` | finite int, `0 … 10_080` (≤ 1 week) |
| `autopilot_daily_action_cap` | finite int, `0 … 100` *(existing)* |
| `autopilot_min_spend_cents` | finite int, `>= 0`, `<= 100_000_000` |
| `autopilot_max_budget_cut_pct` | `0 … 100` *(existing)* |
| `autopilot_max_budget_increase_pct` | `0 … 1000` (allows up to 10×) |
| `autopilot_max_daily_budget_cents` | `null` **or** finite int `> 0` and `<= 100_000_000` |
| `business_hours.start` / `.end` | string matching `^([01]\d\|2[0-3]):00$` (whole hour) |
| `business_hours.tz` | valid IANA zone (`Intl.DateTimeFormat` with `timeZone` does not throw) |
| `business_hours_only` | boolean |

## Business-hours mapping helpers

A small, pure, unit-tested module (e.g. `app/lib/dashboard/business-hours.ts`):

- `localHourToUtc(localHHmm: string, tz: string): number` — `"09:00"`,
  `America/New_York` → stored UTC hour, using the zone's current offset.
- `utcHourToLocal(utcHour: number, tz: string): string` — inverse, returns
  `"HH:00"` for display.

Used by `rowToGuardrails` (read) and `guardrails.update` (write) in
`calderyn.server.ts`. Pure functions so the conversion is testable without a DB.

## Merchant-facing UX

Default screen ≈ today's screen + a "Custom" option + one toggle:

```
Guardrails
  Daily action budget   [$250] [$500] [$1,000] [ Custom ]
  Per-action cap        [$100] [$250] [$500]   [ Custom ]
  Cooldown              [15m]  [30m]  [1h]      [ Custom ]
        - "Custom" reveals one small input; a preset tap stays one click.

  Only act during business hours   ( ● off )
        - ON reveals:  Start [09:00]   End [17:00]   (store's timezone, no picker)

Autopilot   ( ● off )          <- unchanged; limits appear only when ON
  Max actions/day      [ 6 ]
  Min spend to act     [ $100 ]
  Max budget cut       [ 50% ]
  Max budget increase  [ 20% ]      <- new (scale-up)
  Daily budget ceiling [ $500 ] / none   <- new (scale-up)
```

## Components & files

**New dashboard primitives** (`app/components/dashboard/`):
- `GuardrailField` — preset chips + "Custom" reveal + number input. Reused for
  all six numeric guardrails.
- `BusinessHoursEditor` — the toggle + Start/End whole-hour inputs.
- Minimal input styling added to the dashboard CSS (no shared text input exists
  today; follow the raw-`<input>` patterns already used in `Predictor.tsx` /
  `BugReportButton.tsx`).

**Edited:**
- `app/lib/types.ts` — add `business_hours_only` to `GuardrailConfig`.
- `app/components/dashboard/view-models.ts` — add `business_hours_only` to
  `GuardrailVM`; map it in `toGuardrailVM`.
- `app/lib/dashboard/guardrails-validation.ts` — consolidated bounds.
- `app/routes/dashboard.api.guardrails.tsx` — expanded `PATCHABLE_KEYS`; route
  validation delegates to the shared validator; specific error codes.
- `app/lib/calderyn.server.ts` — `rowToGuardrails` reads `business_hours_only` +
  converts UTC→local; `guardrails.update` writes start/end (local→UTC) and
  `business_hours_only`.
- `app/components/dashboard/screens/Settings.tsx` — swap `Segmented` for
  `GuardrailField`; add `BusinessHoursEditor`; add the two scale-up fields.
- `app/routes/app.settings.tsx` — add the business-hours editor (replacing the
  disabled field + its TODO) and the two scale-up fields; route the action
  through the shared validator.

**Tests:**
- `guardrails-validation.test.ts` — every bound, pass and fail, partial patches.
- New `business-hours.test.ts` — local↔UTC round-trips, DST-boundary behavior.
- `app/lib/dashboard/__tests__/api-write-routes.test.ts` — new patchable keys
  accepted; out-of-range rejected with the right code.
- Embedded-admin settings action tests — new fields parsed + validated.

## Parity

Both surfaces get the business-hours editor and the two scale-up fields in this
change, so the extension and the dashboard stay in parity (the numeric
custom-entry capability already exists on the embedded admin). No separate
dashboard repo work — `app/routes/dashboard.*` **is** the dashboard.

## Pre-commit gate

Before any commit (per `CLAUDE.md`): `/code-review` → `npm run typecheck` →
`npm run lint` (`--max-warnings=0` on new code) → `npm run build`, all green,
output shown. `npx prisma validate` is not needed (no schema change).
