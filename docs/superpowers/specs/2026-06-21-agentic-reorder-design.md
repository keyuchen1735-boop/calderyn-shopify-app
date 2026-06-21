# Agentic Reorder (Calderyn Calibration capability)

**Date:** 2026-06-21
**Status:** Spec — ready for implementation plan
**Builds on:** [Calderyn Calibration design](2026-06-20-calderyn-calibration-design.md)

## 1. Summary

Calderyn's Calibration engine already learns to run ad and inventory-relocation actions hands-off, earning trust per `(detector, action)` pair through an approve/reject loop. **Reorder is in its action map but permanently dead:** `create_po_draft` is not in `HAS_EXECUTOR` ([app/lib/calibration/confidence.ts:43](../../../app/lib/calibration/confidence.ts#L43)), so it scores `GUARDRAIL_VETO = 0 -> conf 0` forever and can never be flagged, learned, or graduated. Restocking is arguably the single most important inventory decision a store makes, and the engine is blind to it.

This capability gives the engine the missing ability: **observe each product's sell-through and supplier rhythm from data Calderyn already has, compute when and how much to reorder, and draft a ready-to-send purchase order** — with zero merchant data entry. The agent does 100% of the judgment; the merchant does the final "send to supplier" click.

### The core constraint that shapes the whole design

Every action the engine runs today ends inside a system Calderyn is plugged into (pause campaign -> Meta API; move stock -> Shopify API). **Reorder ends at a supplier, and Calderyn has no pipe to the supplier.** There is no API to a merchant's factory. So the engine's reorder action cannot place a real order. Per founder decision (Option A), the auto-action is **draft the PO + notify the merchant**; the merchant sends it. This is what makes the action *reversible* (a draft is discardable; no money moves, no order is placed), which in turn lets it graduate at the easy bar instead of being gated as an irreversible money-moving action.

### Fully agentic, zero input

Per founder direction, the merchant never types lead times or reorder points. Every input the math needs is **derived** from data Calderyn already ingests, seeded by the engine's existing anonymized peer priors, and refined by the existing learning loop. See Section 3.

## 2. The engine unlock (why this is small, not a new brain)

The Calibration engine is already built (slices 0–5 on main). It does not need new decision logic. It needs `create_po_draft` turned from a dead pair into a live one:

| Change in `confidence.ts` | Today | After |
|---|---|---|
| `HAS_EXECUTOR` contains `create_po_draft` | ❌ (conf 0 forever) | ✅ (can earn trust) |
| `create_po_draft` tier | `hard_to_reverse` (0.5 factor, graduates at 88 / 10 approvals) | `reversible` (1.0 factor, graduates at 75 / 3 approvals) |

**Rationale for the tier flip:** under Option A the auto-action only *creates a draft and notifies*. Nothing irreversible happens — no purchase is placed, no money is spent, the draft can be discarded with no real-world effect. By the engine's own definition (a kind is `reversible` only if it has a working undo within the window — spec I7), "discard the draft" is a trivially complete undo. So `reversible` is the honest classification, not a loosening. The reorder *decision* (qty/timing) is learned; the irreversible part (actually buying) stays a human click and never auto-executes.

Once live, reorder flows through the **exact existing machinery**: it appears in the Action Queue when below threshold, auto-drafts when graduated, lands in Agent Activity, and learns from approve/reject via the existing Beta math. No new execution path, no new learning path.

## 3. How the engine derives every input (no merchant entry)

Four signals, all from data Calderyn already has or already plans to have:

| Signal | Source | What it yields |
|---|---|---|
| **Sell-through velocity** | `sku_velocity` (already built; 1/7/28-day windows) | units/day -> days until zero |
| **Restock observation** | `inventory_level_fact` history (already ingested; `observed_at`) | observed lead time + typical batch size per SKU |
| **Peer/category prior** | calibration `action_pair_prior` pattern (`moat` baselines, k-anon n>=5) | cold-start lead time for a SKU with no history yet |
| **Approve/reject/edit + manual moves** | the calibration loop + Shopify inventory webhooks | refines qty/timing to match how this merchant actually operates |

### 3.1 Restock observer (the key new derivation)

Calderyn records on-hand over time. A **sudden upward jump** in `inventory_level_fact.available` for a SKU is a delivery landing. The observer:

1. Scans each SKU's stock-level history for upward deltas above a noise floor.
2. Records each restock event: timestamp, batch size (the jump magnitude).
3. Derives, per SKU: **observed lead time** (gap from "crossed reorder point" to "stock jumped") and **typical batch size** (median of recent jumps), over the last N cycles.

This is the agentic substitute for "merchant enters supplier lead time." It learns the supplier's real behavior by watching the shelves.

### 3.2 Reorder math (pure, testable)

```
days_to_zero    = on_hand / velocity                 (from sku_velocity)
order_by_date   = stockout_date − observed_lead_time
suggested_qty   = velocity × (observed_lead_time + coverage_target) − on_hand
                  (nudged toward the merchant's observed typical batch size)
```

`coverage_target` is a buffer (how many days of stock to hold after the delivery lands). Default derived; refined by reject signals. All presentation policy lives in TS (consistent with `inventory-demand.ts`), not SQL.

### 3.3 Cold start

A brand-new SKU has no restock history. The math falls back to the **peer/category prior** (e.g. "apparel ~3 weeks") via the existing `action_pair_prior` mechanism, and self-corrects after the SKU's first observed restock cycle. The capability is therefore **never blocked on input** — it starts with a sensible guess and sharpens fast.

### 3.4 Learning from manual merchant actions (implicit feedback)

Shopify already pushes `inventory_levels/update` to Calderyn ([app/routes/webhooks.inventory_levels.update.tsx](../../../app/routes/webhooks.inventory_levels.update.tsx)). When the merchant **manually restocks in Shopify**, the agent observes it and treats it as a strong hint:

| Observed manual move | What the agent learns |
|---|---|
| Merchant restocks SKU in a consistent batch size | Nudge `suggested_qty` toward that batch size |
| Merchant restocks *before* the agent flagged it | "I'm too slow for this merchant" -> shift the trigger earlier |
| Merchant restocks more/less than a recent suggestion | Adjust `coverage_target` up/down for this SKU |

**Honest limit:** Calderyn sees *that* a restock happened and *how much*, but not *why* (a one-off bulk buy for a sale looks like a normal restock). So manual moves are weighted as **hints, not gospel** — they nudge beliefs, the merchant can still correct, and a single outlier cannot dominate (median over recent cycles, not last-value). This mirrors the engine's existing "implicit positive/negative" signals (calibration design Section 7) rather than inventing a new mechanism.

## 4. The PO draft executor (the missing piece)

Today `create_po_draft` is `mode: "link"` ([app/lib/inventory-alerts.ts:62](../../../app/lib/inventory-alerts.ts#L62)) — it opens the alert detail for the merchant to fill in by hand. There is no executor. PO draft *state* and rendering already exist (`audit-state-diff.ts` reads `po.total_cents` / `po.lines[].quantity`; there is a PO PDF route `app.audit.$id.po[.]pdf.tsx`).

The new executor, invoked by Approve (queue) or autopilot (graduated):

1. Builds a PO draft record from the alert's evidence (SKU, suggested qty, est. unit cost from `cogs_fact`, order-by date, supplier note if known).
2. Writes it through `insertAuditWithIdempotency` (same audit path as every other action), so it lands in Agent Activity with a working **undo = discard draft**.
3. Notifies the merchant (channel TBD, Section 7).

The merchant opens the draft, reviews, and sends it to their supplier (existing PO PDF / detail surface). Calderyn never contacts the supplier.

**Reversibility / undo:** the executor's undo branch discards the draft (sets it inactive, writes the `undo_of` audit row). Because no order was placed, undo is complete and side-effect-free — satisfying spec I7 for `reversible` classification.

## 5. Data flow

```
nightly (cron):
   restock observer updates per-SKU lead-time + batch belief
   reorder math computes which SKUs need ordering, by when, how many
   reorder_timing alert fires carrying a complete draft plan in evidence

per alert (engine, existing machinery):
   score (reorder_timing, create_po_draft) pair
      graduated + conf >= 75 + invariants hold  -> auto-draft + notify (Agent Activity)
      else                                       -> Action Queue ("Needs your OK")

merchant:
   approve  -> executor drafts PO + notify; alpha += 1
   edit qty -> draft uses merchant qty; belief nudged toward it
   reject   -> existing reason taxonomy (too_aggressive -> order less;
               wrong_timing -> shift trigger); beta bump
   manual restock in Shopify (any time) -> observer logs it as implicit feedback (Section 3.4)
```

## 6. Safety / invariants (reuse, do not reinvent)

All Calibration safety invariants (I1–I10) apply unchanged. Notes specific to reorder:

- **I3 shadow gate:** the first 3 real reorder instances are queued and approved before the pair can ever graduate, even though it's reversible.
- **I4 freshness:** the executor re-reads live stock at draft time and aborts (`skipped: precondition_stale`) if the SKU was restocked since the alert (no duplicate PO).
- **I5 idempotency:** one open draft per `(shop, sku, day-bucket)` — never two drafts for the same need.
- **I2 daily ceiling:** drafting moves no money, so it does not consume the dollar budget; it still respects the daily action *count* cap.
- **Manual-move guard:** implicit feedback from manual restocks updates beliefs only (never auto-fires an action), so a bulk one-off can't trigger a cascade.

## 7. Open decisions (resolve in the plan, not blockers)

1. **Lead-time / batch belief storage:** new small table `sku_reorder_belief` (recommended — keeps it clean and independently testable) vs. extending the calibration store. Lean: new table, RLS `ENABLE + FORCE` shop-scoped, `security_invoker` views.
2. **Notification channel:** reuse the existing digest/email vs. a dedicated reorder ping. Lean: reuse existing, consistent with autonomous-action notification (calibration I7).
3. **Restock-jump noise floor:** the threshold above which an upward delta counts as a restock vs. a small correction (e.g. ignore jumps < X% of typical batch). Tune against seed data.
4. **`coverage_target` default + bounds** before any per-SKU learning kicks in.

## 8. Dashboard parity (MANDATORY)

Dual-surface per CLAUDE.md. The reorder belief, draft action, queue row, and activity entry all read the same contract and mirror into the dashboard's own (non-Polaris, Lucide/`CDIcon`, `cd-*`) primitives. The data layer (restock observer, reorder math, executor) is build-once in the server/`lib` layer and shared; render twice. Match the contract, not the JSX. If a surface must ship single-sided, say so and leave an explicit dashboard TODO.

## 9. Testing

- **Pure-fn unit tests:** reorder math (zero velocity -> no date; no history -> peer prior; fractional cover; rounding), restock detection (jump above/below noise floor; multiple cycles -> median lead time/batch).
- **Implicit-feedback tests:** manual restock nudges belief; single outlier does not dominate (median, not last-value).
- **Integration:** a seeded restock pattern produces the expected lead time; a graduated pair auto-drafts; freshness gate aborts on a restock-since-alert.
- **RLS:** new table passes `get_advisors` (0 ERRORs) + cross-tenant test (shop A sees zero of shop B's beliefs).
- **Engine wiring:** `create_po_draft` now in `HAS_EXECUTOR`, tier `reversible`, graduates at 75/3, shadow-gated first 3.

## 10. Build order (smallest shippable first)

| Slice | Ships | Why first |
|---|---|---|
| 1. Restock observer + belief store | new table + observer + RLS/advisor tests | nothing computes without the belief; pure + safe |
| 2. Reorder math (pure) | `order_by_date` / `suggested_qty` helpers + unit tests | testable in isolation, no I/O |
| 3. PO draft executor + `HAS_EXECUTOR`/tier flip | the executor + undo branch + engine wiring | turns the dead pair live; still queue-only (no graduation yet) |
| 4. Implicit feedback from manual restocks | observer feeds the learning loop | sharpens beliefs; reuses existing signal plumbing |
| 5. Graduation + notification | shadow gate, auto-draft, reorder ping | the only slice enabling unattended drafting; gated behind all invariants |

Each slice: its own worktree (`feat/reorder-<slice>`), full pre-commit gate, dashboard mirror or explicit TODO.
