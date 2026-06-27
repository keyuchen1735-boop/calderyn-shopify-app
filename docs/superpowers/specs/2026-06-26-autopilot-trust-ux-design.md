# Autopilot trust UX — design

Date: 2026-06-26
Status: Slice A specced for build; Slices B and C captured at design-intent level (each gets its own plan).

## Vision

Autopilot should never surprise a merchant by acting on its own before they trust
it, and should never silently hide an action it *won't* take. Trust is earned
(the existing calibration "graduation"), and the system eases in rather than
acting hands-off the instant autopilot is switched on. Three slices move toward
that, in build order:

- **A — Queue magnitude-awareness** (this repo, small): an autonomous action that
  is too big for its safety cap is *blocked* by autopilot (block-not-clamp), so
  it needs a human. Today it vanishes from the approval queue; it must stay
  visible there, not only on the alert detail page.
- **C — Warm-up / recommend-to-enable** (this repo, medium): when a merchant first
  enables autopilot, no action fires on day one. The three "no-brainer" actions
  start as suggestions; once the merchant has approved enough of them, Calderyn
  *recommends* turning that feature on, and the merchant opts in per feature.
- **B — Auto-resume on stockout-clear** (cross-stack, big): when Calderyn paused a
  campaign because the product sold out and it is now restocked, it can resume the
  campaign autonomously — only that exact case, and only once the pair has earned
  trust like every other autonomous action.

---

## Slice A — Queue magnitude-awareness (BUILD NOW)

### Problem
`buildActionQueue` (`app/lib/calibration/queue.server.ts`) drops *every* alert on a
graduated `(detector, action)` pair (the I5 "no double actor" rule: graduated
pairs run via autopilot, so they must not also be approvable). But an alert whose
move exceeds the merchant's autonomy cap is **blocked** by autopilot
(block-not-clamp, design 2026-06-26 §2.4) — autopilot will *not* act on it, so it
needs manual approval. Dropping it from the queue hides it; it only appears on the
alert detail page.

### Scope
Among the block-not-clamp kinds (`adjust_price`, `reallocate_inventory`), only
`reallocate_inventory` flows through `buildActionQueue`: `adjust_price`,
`reallocate_spend_sku`, and `discontinue_sku` are in `PLAN_ONLY_ACTIONS`
(`app/lib/labels.ts`) and are never returned by `recommendedAction`, so they are
never queued here (they surface via the ranked remediation plan on the alert
detail). `reallocate_inventory` is the recommended action for the pure
inventory-relocation detectors (e.g. `regional_shortage_risk`,
`wrong_location_concentration`). Its magnitude — the transfer-plan unit delta — is
present in the alert evidence, so the over-cap check is **exact and pure** (no
Shopify I/O in the queue-list path).

### Design
- `buildActionQueue` gains a param `overCapAlertIds: Set<string>` (default empty).
  The graduated-pair drop becomes: skip a graduated-pair alert **unless** its id is
  in `overCapAlertIds`. Kept-because-over-cap proposals are flagged
  `over_autopilot_cap: true` on `QueueProposal` so the UI can render a
  "needs your approval — over the autopilot limit" treatment. The function stays
  pure.
- The facade (`queue.list` in `app/lib/calderyn.server.ts`) computes
  `overCapAlertIds`: for each open alert on a graduated `(inventory-detector,
  reallocate_inventory)` pair, read the transfer-plan delta from evidence
  (`transferPlanFromEvidence`) and compare `|delta|` against
  `guardrail_config.autopilot_max_inventory_units_per_move`. A null cap means
  unlimited → never over-cap. Over-cap → add the alert id to the set.
- Within-cap graduated alerts stay hidden (autopilot handles them) → no double
  actor. Only genuinely-over-cap alerts (which autopilot refuses) are surfaced.

### UI / parity
Parity is automatic: both the embedded Action Queue (`app/routes/app.queue.tsx`)
and the dashboard queue (`app/routes/dashboard.api.queue._index.tsx`) call the same
`queue.list` facade, so the over-cap alerts now appear in both queues for approval
with no separate work. The proposals render through the existing
`reallocate_inventory` proposal path (already supported for non-graduated inventory
pairs), so no new render path is needed.

The explanatory "over your autopilot limit" **badge** is deferred as a small
follow-up: the codebase does not currently render the sibling `always_ask` flag
either, and the two queue UIs are bespoke (no badge pattern to mirror). The
`over_autopilot_cap` flag is plumbed end-to-end and ready for the badge when added.

### Tests
- `buildActionQueue`: a graduated-pair alert in `overCapAlertIds` is KEPT (flagged
  `over_autopilot_cap`); a graduated-pair alert NOT in the set is dropped; a
  non-graduated alert is unaffected.
- Facade: an over-cap inventory delta produces the alert id in `overCapAlertIds`;
  a within-cap one does not; a null cap never flags.

---

## Slice C — Warm-up / recommend-to-enable (design intent; own plan)

Today `20260624120000_autounlock_no_brainer_features.sql` seeds the three
no-brainer `pause_campaign` pairs as `graduated=true` for every shop, and the
autopilot run-path gates only on the shop-level `autopilot_enabled` switch +
graduation — so the three no-brainers fire as soon as a merchant switches autopilot
on. Desired: nothing fires on day one. The no-brainers run as *suggestions*; once
the merchant has approved enough of a given pair, Calderyn surfaces a recommendation
to enable that feature, and the merchant opts in per feature. Needs: a per-feature
"enabled" state defaulting off (verify whether one already exists via the Live
Engine feature toggles), a recommendation surface keyed on accrued clean approvals,
and the autopilot path honoring the per-feature enable. Mirror to the dashboard.

## Slice B — Auto-resume on stockout-clear (design intent; own plan)

When a campaign was auto-paused for `sku_stockout_vs_spend` (out-of-stock vs spend)
and the SKU is now restocked, resume the campaign. Only that case. Needs a new
"stockout cleared" detection (Python engine) that emits an alert mapping to
`resume_campaign` via `DETECTOR_TO_ACTIONS`, an autopilot branch that fires
`resume_campaign` (graduation-gated + guardrails; `resume_campaign` already has an
executor and undo branch and is in `GRADUATABLE`), and queue/recommend surfacing
until the pair graduates. Mirror to the dashboard.
