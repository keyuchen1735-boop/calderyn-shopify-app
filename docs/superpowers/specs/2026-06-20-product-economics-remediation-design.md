# Product-economics alert remediation — design

- **Date:** 2026-06-20
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Surfaces:** Calderyn dashboard (`app/routes/dashboard.*`, `app/components/dashboard/*`) **and** embedded Shopify app (`app/routes/app.alerts.$id.tsx`). Dashboard parity is mandatory.

## Problem

Product-economics alerts (a SKU losing money, ads eating revenue, returns hiding loss) currently collapse to a single **Snooze** button in the "Fix it" panel. Root cause: `adaptAlert` (`app/lib/dashboard/client.ts:159-168`) only emits `pause_campaign`/`reduce_campaign_budget` when the alert carries a `campaign_id`, and only adds `reallocate_inventory` when the detector lists it. For SKU-scoped economics alerts there is no `campaign_id` and no inventory action, so every concrete action is filtered out. `rec_detail` (the recommendation line) is also empty — `TODO(api): server-provided recommendation`. The merchant is told there is a $5k/30d problem and offered nothing but "Snooze."

The fix is **not** to back-link the campaign. It is to give these alerts a **strategic remediation**: a short synopsis of what to do, plus ranked, executable portfolio moves — discontinue the product, cut/reallocate its ad spend, scale a better product instead, or address returns.

## Decisions (locked during brainstorming)

1. **Advisory synopsis + fully executable actions.** The merchant sees a plain-language synopsis and ranked moves; the moves are real executors, not just advice.
2. **Deterministic pick + AI prose.** Code ranks the candidate moves from SKU economics and picks the best by fixed rules (testable, guardrailable). The model only *writes* the synopsis + audit-reasoning sentence from that decision. Autopilot uses the same ranking.
3. **Full write surface.** Executors reach internal flags **and** live Shopify/Meta: `discontinue_sku` (internal `do_not_reorder` flag + Shopify archive/unpublish + undo) and `reallocate_spend_sku` (Meta cross-product budget shift).
4. **Autopilot auto-selects.** When autopilot is on it executes the top-ranked move within guardrails/caps and writes the deterministic reasoning + ranked numbers to the audit log.
5. **Architecture: server-side shared engine (Approach A).** One decision stored on the alert, read by dashboard + embedded + autopilot.
6. **Scope: all 5 product-economics detectors** — `negative_unit_economics`, `ad_tax_overload`, `return_rate_hidden_loss`, `margin_erosion`, `cogs_drift`.

## Key feasibility constraint (SKU → campaign)

Campaigns are **not** cleanly mapped to a single SKU. Some are product-dedicated (`Summit Tee — Creator Whitelisting Test`, `PMax — Hydration Push — West`, `Spark Ads — Crestline Pack UGC`); others are catalog-wide (`Advantage+ Shopping`, `PMax — All Products`, `Brand Search`). There is no structured SKU→campaign key.

Consequence: **ad-spend moves (`cut_ads`, `reallocate_spend_sku`) are only executable when the SKU is served by a dedicated, mutable campaign.** When the loser's spend lives inside a shared Advantage+/PMax campaign there is no per-SKU lever; the engine must fall back to advisory ("exclude this SKU inside Advantage+") and never offer a button it cannot honor (rule 12).

## Architecture (Approach A)

A server-side **remediation engine** runs when a product-economics alert is built (or first opened):

1. `rankMoves(inputs)` deterministically ranks candidate moves by projected 30-day $ impact and picks the best *eligible* one — pure, no I/O.
2. `prose.server.ts` has the existing assistant write a 1–2 sentence synopsis + audit reasoning **from the plan** (deterministic template fallback on model failure).
3. The result (`RemediationPlan` + synopsis) is stored on the alert (`remediation jsonb`, `rec_detail`).
4. All three consumers — dashboard detail, embedded detail, autopilot — read the same stored decision. No forked logic.

## The deterministic ranking (the crux)

Candidate moves, each scored by **projected 30-day $ recovered/gained**:

| Move | Eligible when | $ score | Executor |
|---|---|---|---|
| **discontinue** | net contribution/unit **at zero ad spend** ≤ 0 (structurally dead — free traffic still loses money) | the bleed you stop | `discontinue_sku` (P2) |
| **cut_ads** | gross margin/unit > 0 **but** net-with-ads < 0 (ads are the problem) | ad overspend above breakeven | reuse `pause_campaign` / `reduce_campaign_budget` |
| **reallocate_to_winner** | loser has a **dedicated mutable** campaign **and** a qualifying winner (stock headroom + scalable campaign) exists | winner incremental − loser lost | `reallocate_spend_sku` (P3) |
| **fix_returns** | `return_rate` is the dominant loss driver | return-driven loss | advisory deep-link (no executor) |
| **snooze** | always, ranked last | — | existing `snooze_alert` |

**The ditch-vs-tune gate:** net contribution per unit *at zero ad spend* = `price − COGS − ship − returns`.
- ≤ 0 → structurally dead → **discontinue**.
- \> 0 → product is viable; ads/returns are the problem → **cut_ads / reallocate / fix_returns**.

The recommended move is the highest-$ **eligible** move. Ineligible moves are omitted, never shown as dead buttons.

### Worked example — the screenshot (`Summit Logo Tee — M`)

Gross profit/unit = **+$23**, ad cost/sale = $170, net = **−$147**. Gross margin is healthy → `discontinue` is **not** eligible. Pure ad-cost bleed; the SKU has a dedicated campaign (`Summit Tee — Creator Whitelisting Test`, ROAS collapsed to 0.1). Engine picks **cut_ads / reallocate_to_winner**.

Synopsis (illustrative):
> "This product makes $23 a unit — it isn't the problem. You're paying $170 in ads per sale because the 'Summit Tee — Creator Whitelisting Test' campaign's ROAS fell to 0.1. Kill that campaign; the spare budget earns 4.5× on Retargeting."

A naive "ditch this product" would be **wrong** here. This is the argument for deterministic ranking over a guessed suggestion.

## Types (sketch)

```ts
type StrategicMoveKind =
  | "discontinue" | "cut_ads" | "reallocate_to_winner" | "fix_returns" | "snooze";

interface StrategicMove {
  kind: StrategicMoveKind;
  eligible: boolean;
  ineligibleReason?: string;        // surfaced, not hidden (rule 12)
  dollarImpact30d: number;          // projected $ recovered/gained
  executor: ActionKind | null;      // null = advisory
  target?: { skuId?: string; campaignId?: string; winnerSkuId?: string };
}

interface RemediationPlan {
  moves: StrategicMove[];           // ranked desc by dollarImpact30d, eligible first
  recommended: StrategicMoveKind | null;
  structurallyDead: boolean;        // net-at-zero-ad-spend ≤ 0
  marginSourceAvailable: boolean;   // false → advisory + "margin source unavailable"
}
```

## Data flow

```
alert built / first open → rankMoves() → prose → {plan, synopsis} on alert (computed on read — see Non-goals: no jsonb cache)
  ├─ merchant: detail renders synopsis + ranked moves → click → action layer (audit + undo)
  └─ autopilot: reads plan.recommended → guardrail/cap check → execute → audit reasoning + ranked numbers
```

## Components

| Unit | Responsibility |
|---|---|
| `app/lib/remediation/rank.ts` | Pure `rankMoves(inputs) → RemediationPlan`. The entire decision. Fully unit-tested. |
| `app/lib/remediation/prose.server.ts` | Plan → synopsis + audit reasoning via existing assistant; template fallback. |
| `v_sku_remediation_inputs` (new view) | `v_skus_flat_ship_pnl` (contribution) + `v_sku_returns_30d` (returns) + dedicated campaign (if any) + catalog winner ranking. |
| `remediation jsonb` + `rec_detail` on `alerts` | Stores plan + synopsis. Migration via `prisma migrate dev` / Supabase migration. |
| `Alert` / `AlertVM` DTO | Gains `remediation` + synopsis fields. `adaptAlert` reads the stored plan instead of deriving actions from `campaign_id`. |
| "Fix it" panel (dashboard `Alerts.tsx`, embedded `app.alerts.$id.tsx`) | Render synopsis + ranked moves; recommended flagged; each shows $ impact and names the winner. Advisory moves deep-link; executable moves are buttons. |
| Executors (P2–P3) | `discontinue_sku`, `reallocate_spend_sku` through existing action/audit/undo layer. |
| Autopilot (P4) | `v_autopilot_candidates` + `autopilot.server.ts` consume `plan.recommended`. |

## Phases (each independently shippable)

1. **Synopsis + move ranking + advisory display.** Engine (`rank.ts` + `prose.server.ts`), the new view, storage, DTO, and the redesigned "Fix it" panel on both surfaces. **No writes** — executable moves render as advisory/deep-link for now. This alone replaces Snooze-only with real guidance.
2. **`discontinue_sku` executor.** Internal `do_not_reorder` flag (shows on Inventory, blocks `create_po_draft`) + Shopify `productUpdate` archive/unpublish + one-click undo (re-publish). New `write_products` scope (App Store review note). Through existing action/audit/undo infra.
3. **`reallocate_spend_sku` executor.** Meta budget shift loser→winner, gated on both SKUs having dedicated mutable campaigns; advisory fallback otherwise. Reuse existing `pause`/`reduce` for plain "cut ads."
4. **Autopilot integration.** Autopilot picks the top-ranked move within guardrails/caps, executes, writes deterministic reasoning + ranked numbers to the audit log. `negative_unit_economics` and `ad_tax_overload` are already in the autopilot candidate allow-list.

## Failure visibility (rule 12)

- AI prose fails → deterministic template synopsis. Never blank.
- No dedicated campaign → ad-shift not offered; advisory "exclude this SKU inside Advantage+" instead.
- No qualifying winner → `reallocate_to_winner` omitted, not faked.
- Missing COGS/ship → `marginSourceAvailable=false` → advisory + "margin source unavailable" (reuses existing `CostSource: "unavailable"`).
- Shopify/Meta write fails → rolls back, error toast, alert stays open (existing `executeAction` behavior).

## Testing

`rankMoves` unit tests are the backbone:
- `+$23` Summit case → picks **cut_ads/reallocate**, *not* discontinue.
- structurally-dead SKU (net-at-zero-ad ≤ 0) → picks **discontinue**.
- no qualifying winner → reallocate omitted.
- SKU served only by a shared campaign → ad-shift omitted, advisory shown.
- returns-dominant loss → picks **fix_returns**.

Plus: executor tests (`discontinue_sku` sets flag + Shopify mock + undo reverts; `reallocate_spend_sku` moves Meta budget + guardrail-reject path) and one autopilot test (picks `recommended`, respects caps, writes audit reasoning).

## Dashboard parity

Both the dashboard (`app/routes/dashboard.*`, `app/components/dashboard/*`) and the embedded app (`app/routes/app.alerts.$id.tsx`) consume the same server-stored `RemediationPlan`, so parity is structural — translate the panel into each surface's own primitives (Polaris for embedded, the dashboard's non-Polaris UI for the dashboard), not a JSX copy.

## Non-goals

- Back-linking alerts to their campaign (`campaign_id` resolution) — explicitly out of scope per the merchant's direction.
- Per-SKU spend control *inside* shared Advantage+/PMax campaigns — not modeled; advisory only.
- New detectors — this is remediation for existing ones.
- **Persisted `remediation jsonb` cache — deliberately not shipped.** The design above assumed the plan would be "computed once, then cached" on the alert to amortize an expensive AI-prose recompute. That AI prose was dropped (Phase 1 ships a deterministic template; `enrich.server.ts` makes no model call), so the rationale for caching dissolved. As shipped: the pure rank runs on every alert read (`attachRemediation`, zero I/O), and `enrichRemediation` runs **only on single-alert detail open and the execute paths** (`app.alerts.$id.tsx`, `dashboard.api.alerts.$id.tsx`) — never across the alert list, so there is no N+1. That is 1–2 indexed Supabase reads on an explicit click. Persisting the plan would also serve **stale** campaign targets / shift amounts (the plan resolves live budgets, live winner ranking, live price) unless paired with invalidation — so compute-on-read is the *correct* behavior here, not a deficiency. Revisit only if AI prose returns or profiling shows the detail-open reads matter.
