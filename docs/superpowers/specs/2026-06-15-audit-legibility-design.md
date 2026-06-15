# Audit log legibility — design

**Date:** 2026-06-15
**Surfaces:** Shopify embedded extension (`app/routes/app.audit.tsx`) **and** Calderyn dashboard (`app/components/dashboard/screens/Audit.tsx`) — both ship together (dashboard parity is mandatory).
**Goal:** Make every audited action legible and trustworthy by showing (1) the booked-margin source, (2) why the action fired, and (3) whether it was manual or automatic.

## Problem

The audit log today answers *what happened* but not *why you should trust it*. Three concrete gaps:

1. **Booked-margin source is invisible.** `dollar_impact_at_exec` is shown bare, but it is derived three different ways in `app/lib/audit-impact.ts`:
   - a **measured** budget pre/post delta (verifiable),
   - an **alert at-stake estimate** (e.g. the PO-draft row's `+$4,668.85` is the alert's `estimate_cents`, not realized margin),
   - a **snapshot estimate** (`post_state.estimate_cents`).
   The merchant cannot tell which, nor which cost data fed the margin math.
2. **Why an action fired is unexplained.** Only the `detector_id` badge hints at cause. Autopilot's actual trigger + guardrail reasoning (`app/lib/actions/autopilot.server.ts`) is never persisted.
3. **Manual vs auto is not first-class.** It is derivable from `actor` (`autopilot` vs everything else) but surfaced inconsistently as a free-text string. The dashboard's `entry.actor === "Autopilot"` tone check is **dead code** (raw value is lowercase `autopilot`), and `merchant:web-dashboard` renders as that raw ugly string.

## Decisions (locked with the user)

- **Booked-margin source = BOTH** provenance (measured / alert-estimate / snapshot) **and** cost-data lineage (COGS from QuickBooks vs vendor invoice, price from Shopify, ad spend from Meta/Google/TikTok).
- **Build depth = HYBRID:** derive mode + margin-source + cost lineage at read-time (retroactive across all 90 days, no migration, no drift because it reads the same `pre/post_state` the figure came from); persist a small `trigger_reason` **only on the autopilot path** going forward (the one thing that cannot be re-derived). No backfill — there are **zero autopilot rows in production today** (autopilot is opt-in and currently unused).
- **Surface = INLINE + EXPAND:** at-a-glance pills/captions inline on both surfaces; click a row to reveal the full breakdown. Extension moves `DataTable` → Polaris **IndexTable** (App-Store-blessed) for the expandable detail; dashboard rows gain a `Collapsible`.

## Architecture

### One shared brain, two native renderings

A single module `app/lib/audit-legibility.ts` turns an `AuditEntry` (enriched with cost-lineage + `trigger_reason`) into a display-ready `AuditLegibility`. The extension imports it directly; the dashboard's `adaptAudit` (`app/lib/dashboard/client.ts`) calls it. This is parity **by construction** — same contract, two renderings (Polaris vs dashboard primitives). We match the contract, not the code (per CLAUDE.md dashboard-parity rule).

```ts
export type ActionMode  = "auto" | "manual";
export type MarginBasis = "measured" | "alert_estimate" | "snapshot" | "none";
export type CostSourceKind = "cogs" | "price" | "ad_spend";

export interface CostSource {
  kind: CostSourceKind;          // what the input is
  source: string;                // "quickbooks" | "vendor_invoice" | "shopify" | "meta" | "google" | "tiktok"
}

export interface AuditLegibility {
  mode: ActionMode;
  actorDisplay: string;          // "Autopilot" | "You" | "You (dashboard)" | teammate email
  marginBasis: MarginBasis;
  marginBasisLabel: string;      // human label for the basis
  costLineage: CostSource[];
  why: string;                   // one-line trigger summary
  whyDetail?: string;            // fuller reasoning (autopilot rule/guardrail, or detector term)
}

export function auditLegibility(entry: AuditEntry): AuditLegibility;
```

### The four signals

1. **Mode (manual/auto)** — `actor.startsWith("autopilot")` → `auto`, else `manual`. Drives a normalized Auto/Manual badge on both surfaces. Fixes the dashboard's dead `=== "Autopilot"` check (use `mode`) and the raw `merchant:web-dashboard` string (normalized via extended `actorLabel`).

2. **Margin-source provenance** — derived from the *same* inputs the figure was computed from, so it can never disagree with the number:
   - `dollar_impact_at_exec === 0` and action is not value-recovering → `none`
   - `alert_id` present → `alert_estimate`
   - else budget pre/post states present → `measured`
   - else `post_state.estimate_cents` present → `snapshot`
   - else → `none`

   This mirrors the branch in `insertAuditWithIdempotency` (`alert → recoveredDollarsForAlertAction`; no-alert → `recoveredCentsFromStates`). A co-located `marginBasisFor(entry)` helper plus an **anti-drift test** pin the basis label to the basis `audit-impact.ts` actually used.

3. **Cost lineage** — derived from action kind + `params` + a lineage lookup:
   - budget/campaign actions (`pause_campaign`, `reduce_campaign_budget`, `reallocate_budget`, `exclude_geo`) → the booked figure is ad-spend dollars stopped, so lineage = `ad_spend` from `params.platform` (`meta`/`google`/`tiktok`) only. (We do not claim Shopify revenue as an input — it is not a component of the spend-stopped figure.)
   - inventory/PO actions (`create_po_draft`, `reallocate_inventory`) → COGS source from `sku_cost_history.source` for `params.sku_id` (latest effective row) + price = Shopify.
   - `snooze_alert`, `resume_campaign` → none.

   The COGS source is resolved with **one batched query** in `calderyn.server.ts › audit.list`: `select sku_id, source from sku_cost_history where sku_id = any(...)` for every `sku_id` on the page, attached to each `AuditEntry`. Because both surfaces fetch via `calderynClient(...).audit.list()`, the dashboard inherits lineage for free.

4. **Why it fired** —
   - autopilot **with** `trigger_reason` → that string (truncated for the inline caption; full in expansion)
   - autopilot **without** → "Autopilot — {detector label}, auto-{action} rule"
   - manual **with** alert → "Resolved: {detector label}"
   - manual **no alert** → "Manual — {surface}" (campaigns page vs dashboard, from `merchant` vs `merchant:web-dashboard`)
   - undo row → "Reversal of {shortId(undo_of)}"

   `whyDetail` (expansion only) adds the detector plain term + at-stake note (when `alert_id`), and the full `trigger_reason` for autopilot. No alert-title join (detector label suffices).

### Data changes

- **Schema (only change):** `alter table action_audit add column trigger_reason text;` — nullable, no backfill.
- **`v_audit_view`:** add `aa.trigger_reason`.
- **`AuditEntry` (`app/lib/types.ts`):** add `trigger_reason?: string | null` and `cost_sources?: CostSource[]` (raw lineage resolved in `audit.list`).
- **`rowToAudit` (`calderyn.server.ts`):** read `trigger_reason`.
- **`audit.list` (`calderyn.server.ts`):** batch-resolve `cost_sources` and attach.
- **`AuditVM` (`app/components/dashboard/view-models.ts`):** add the `AuditLegibility` fields; populated in `adaptAudit`.

### Persisting the autopilot reason

`runAutopilotForShop` builds a one-line reason at the decision point, e.g.
`"Auto-pause: 'campaign_below_breakeven' alert, $420 at stake; within daily cap, business hours"`.
It threads via an optional `triggerReason` on `ExecuteInput` / the reallocation input → `AuditInsert` → the new column. Manual executor paths never set it (stays null → derived fallback). This is the irreducible piece: for manual actions "why" is the alert (derivable); for autopilot the captured reason is richer than any derivation.

## Surfaces

### Extension — `app/routes/app.audit.tsx`

`DataTable` → Polaris **IndexTable** (`selectable={false}`, App-Store-blessed). 

- **Inline cells gain:** a leading **Auto/Manual `Badge`**, the margin-source as a subdued caption under Impact, a short why-caption under Action.
- **Row click toggles a `Collapsible` detail row** (full-width) with three blocks: *Why this fired* (`whyDetail`) · *Booked margin* (figure + `marginBasisLabel`) · *Cost lineage* (a chip per `CostSource`), plus the existing pre→post summary.
- **Undo / Download PDF stay inline** — they are primary actions; only explanatory content moves into the expansion.

### Dashboard — `app/components/dashboard/screens/Audit.tsx`

Each `AuditRow` becomes expandable (a chevron toggling a `Collapsible` div).

- **Inline:** Auto/Manual **pill** (tone driven by `mode`, fixing the dead check), margin-source caption under the `+$` figure, why-caption under the title.
- **Expanded:** the same three blocks rendered in dashboard-native primitives (`CDIcon`, `Pill`, captions) — **not** Polaris. Same `AuditLegibility` object, dashboard rendering.

### Labels — `app/lib/labels.ts`

- Extend `ACTOR_LABELS` / `actorLabel` to normalize `merchant:web-dashboard` → "You (dashboard)", `autopilot` → "Autopilot", `system`, and pass emails through.
- Add `MARGIN_BASIS_LABELS` and `COST_SOURCE_LABELS` (`quickbooks` → "QuickBooks", `vendor_invoice` → "Vendor invoice", `shopify` → "Shopify", platform names). All human-facing strings live here (repo convention).

## Error handling (fail-visibly, rule 12)

- A cost-lineage lookup failure must **not** blank the audit log: degrade that row's lineage to "source unavailable" and `console.error` (mirrors the `dailyUsedCents` fallback in `calderyn.server.ts`).
- Malformed `pre/post_state` JSON → `marginBasis = none`, no crash (`audit-impact.ts` already treats malformed as 0).
- `trigger_reason` null on old/manual rows → derived "why" fallback.
- Unknown actor string → passes through `actorLabel` unchanged.

## Testing (behavior, not coverage theater — rule 9)

- `app/lib/__tests__/audit-legibility.test.ts`: for each `ActionKind` × actor combination, assert `mode`, `marginBasis`, `costLineage`, `why`. Cover: autopilot pause (auto / `alert_estimate` / ad_spend:meta / why from `trigger_reason`), merchant reduce no-alert (manual / `measured` / ad_spend), PO draft (`alert_estimate` / cogs+price lineage), undo row, snooze (`none`).
- **Anti-drift test:** `marginBasisFor(entry)` agrees with the basis `audit-impact.ts` actually used (measured vs alert) for representative rows.
- `adapt-audit.test.ts`: `AuditVM` carries the legibility fields (dashboard parity).
- Autopilot: assert `trigger_reason` is written and threads through `executeAction` / `executeReallocation`.
- **Regression:** the Auto pill fires for autopilot rows, and `merchant:web-dashboard` renders as the normalized manual label (guards the previously-dead `=== "Autopilot"` check).

## Out of scope (YAGNI)

- No alert-title join into the audit row (detector label is enough).
- No backfill of `trigger_reason`.
- No new cost-data ingestion — only surfacing existing `sku_cost_history.source`.
- No persisted `impact_basis` column (read-time derivation is sufficient and retroactive).

## Process

- Built in an isolated `feat/audit-legibility` git worktree (CLAUDE.md feature-isolation rule).
- Both surfaces ship in the same change (dashboard parity).
- Full pre-commit gate before any commit: `/code-review`, patch sanity, `npm run typecheck` / `lint` / `build`, `npx prisma validate` + `migrate diff` (schema changed), regenerated GraphQL types if any `.graphql` changed (none expected).
