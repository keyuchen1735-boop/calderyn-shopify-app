# Outcome-Gated Autonomy — Design

> **Status:** Approved design (brainstorm 2026-06-26). This is the fixed contract
> that the implementation plan builds against.

**Date:** 2026-06-26
**Topic:** Make Calderyn's trust/graduation decision depend on *measured outcomes*
(real dollar results), not merchant approval clicks alone; expand the set of
actions that can graduate from autonomy from 3 to 7; and make high-stakes actions
safe through bounded magnitude rather than a time delay.

---

## 1. Problem

Calderyn has three independent "brains" today, and only two of them talk to the
autonomy decision:

| Brain | Question it answers | Driven by | Feeds autonomy? |
|---|---|---|---|
| **Detectors** (`engine/.../detectors/*`) | "Is this actually a problem?" | Real spend, revenue, COGS, units | Yes — generates the suggestion |
| **Outcome scoring** (`engine/.../moat/action_rewards.py`) | "Did my action actually work?" | ROAS/profit, 14d before vs after | **No — only tunes magnitude** |
| **Calibration** (`app/lib/calibration/*`) | "Can I act without asking?" | Merchant approve / reject clicks | Yes — drives graduation |

Two consequences:

1. **Trust is earned from clicks, not results.** A `(detector, action)` pair can
   graduate to fully autonomous purely because the merchant kept approving it,
   even if those actions never actually made or saved money. The outcome math
   (`compute_action_reward`) already measures whether an action worked, but its
   signal is wired only to the aggressiveness dial (`μ`), never to graduation or
   demotion.
2. **Only 3 actions can ever graduate.** `GRADUATABLE_V1`
   (`app/lib/calibration/graduation.ts`) hard-codes `pause_campaign`,
   `reduce_campaign_budget`, `discontinue_sku`. Several other actions already have
   complete, working undo paths (`app/lib/actions/undo.server.ts`:
   `resume_campaign`, `reallocate_budget`, `reallocate_inventory`, `adjust_price`)
   but are held behind approval indefinitely, with no merchant-usage path to
   unlock them.

The product promise is "Calderyn saves money while you sleep." That requires
autonomy the merchant can trust *because the math proved it*, across more than 3
actions, acting immediately (no human-in-the-loop delay).

## 2. Decision

Graduation becomes **outcome-gated** and the graduatable set **expands to 7**.
Safety for high-stakes actions comes from **bounded magnitude**, not a time delay.

### 2.1 Two-bar graduation (the core change)

A pair graduates to autonomous only when it clears **both** bars. The first bar is
today's approval count; the second is new and reads the existing outcome reward.

| Reversibility tier | Examples | Clean approvals (existing) | Net-positive measured outcomes (NEW) |
|---|---|---|---|
| reversible | resume_campaign, reallocate_budget, reduce_campaign_budget | 3 | 3 |
| hard_to_reverse | adjust_price, discontinue_sku | 10 | 5 |
| irreversible | reallocate_inventory | 25 | 8 |

- A "measured outcome" is the sign of `compute_action_reward` for an executed
  action of this pair once its per-kind confirmation window has elapsed (§4.2 —
  3 days for defensive actions, 7 for growth/demand ones, never the old 14).
  Positive = it helped. The count is **net-positive outcomes** (positives minus
  negatives), floored at 0.
- Outcomes accrue from **every executed action of the pair**, including the ones
  the merchant approved while the pair was still in "ask first" mode. So the
  outcome track record is being built in parallel with the approval count — the
  two bars are gathered from the same stream of actions, just measured differently
  (a click vs a 14-day dollar result).
- The existing graduation gates in `graduationVerdict` (undo branch exists, not
  merchant-disabled, not on probation, no recent undo, confidence ≥ threshold) all
  still apply, unchanged. The outcome bar is an **additional** gate, never a
  relaxation of an existing one.
- The three shipped `NO_BRAINER` pairs keep their day-one autonomy (they bypass the
  approval bar today via the "shipped no-brainer" branch). They do **not** bypass
  the new outcome demotion in §2.3 — a shipped no-brainer that starts losing money
  autonomously still auto-demotes.

### 2.2 Expanded graduatable set (3 → 7)

`GRADUATABLE_V1` (rename to `GRADUATABLE`) adds the four actions that already have
a complete, tested undo branch:

```
existing: pause_campaign, reduce_campaign_budget, discontinue_sku
added:    resume_campaign, reallocate_budget, reallocate_inventory, adjust_price
```

Explicitly **not** added (no undo branch exists today, per `undo.server.ts`):
`increase_campaign_budget`, `create_po_draft`. They remain approval-only until
their undo path is built — a future change, out of scope here.

### 2.3 Outcome demotion (reality can revoke trust)

A graduated pair that starts producing **negative measured outcomes** auto-demotes
back to "ask first" — without waiting for the merchant to undo anything.

- Trigger: the pair's recent autonomous outcomes go net-negative over a rolling
  window (exact window/threshold pinned in the plan; starting point: 2 consecutive
  net-negative measured outcomes, or the rolling net-positive count for the tier
  falling back below the §2.1 bar).
- Effect: same mechanism as the existing `consecutive_undos`/probation demotion —
  the pair stops being `graduated` and returns to the Action Queue for approval.
- This composes with, and is independent of, the existing undo→demote path. Either
  signal (a merchant undo OR a measured loss) demotes.

### 2.4 Bounded autonomy for high-stakes actions (no time delay)

`adjust_price` and `reallocate_inventory` are customer-visible / physical and only
partially reversible in practice (a price the customer already paid; stock that
sold through at the new location). They fire **immediately** like every other
action — there is **no cooling-off / cancel window** (a delay would break "saves
money while you sleep"). Safety comes from magnitude instead:

- When graduated, these two may fire autonomously **only if the move is within the
  merchant's existing guardrail caps** (e.g. `guardrail_max_price_change_pct`, and
  the inventory unit/percentage cap). This reuses the existing guardrail check, now
  enforced as a *condition of autonomous execution* for these kinds, not just a
  one-time clamp.
- A move that would exceed the cap does **not** get clamped-and-fired
  autonomously; it falls back to the Action Queue and asks. The merchant decides on
  anything dramatic.
- **`adjust_price` tier:** today `adjust_price` has no `ACTION_TIER` entry, so
  `actionTier` defaults it to `irreversible` (25-approval bar). This design assigns
  it `hard_to_reverse` (10 approvals / 5 outcomes) — reversible via its undo branch
  but customer-visible — which requires an **explicit `ACTION_TIER` addition** in
  the plan. (`reallocate_inventory` is already `irreversible` in the map and stays
  there; `resume_campaign` / `reallocate_budget` are already `reversible`.)
- The cheap/reversible actions (`resume_campaign`, `reallocate_budget`) fire
  immediately + notify with the 48h autonomous undo window, exactly like
  `pause_campaign` does today.

## 3. The safety gauntlet (end-to-end)

Every autonomous action runs this gauntlet. Most layers already exist; this design
adds layers 1b and 6b and extends layer 3 to the new kinds.

```
1.  Earned trust?      approvals  ── existing
1b. Proven by math?    net-positive measured outcomes ── NEW (§2.1)
2.  Still true now?    re-check detector math on fresh data at fire time ── existing
3.  Inside limits?     price/inventory move within merchant caps ── existing, extended (§2.4)
4.  Blast radius?      daily action cap ── existing
5.  Fire + notify      48h autonomous undo window ── existing
6.  One regret →       merchant undo → demote ── existing
6b. One loss →         measured negative outcome → demote ── NEW (§2.3)
```

## 4. Outcome signal — reuse the existing kernel

No new reward math. Graduation/demotion read the **existing**
`compute_action_reward` (`engine/.../moat/action_rewards.py`):

- Inputs per executed action (from `action_audit`): `action_kind`, target
  campaign/SKU, exec time `T`, and whether a later row has `undo_of = this.id`.
- Outcome metric (from `ad_spend_fact` / grades): ROAS and profit over the
  post-window `[T, T+W]` vs the pre-window `[T−14d, T)`, where `W` is the
  **per-action confirmation window** from §4.2 (not a flat 14 days); break-even
  reference from `campaign_grade_fact.break_even_roas`.
- Sign convention: positive = the action helped; undo = hard negative override.

**New plumbing (not new math):** a per-pair tally of net-positive measured
outcomes, surfaced to the calibration graduation/demotion path beside the existing
approval counters. The plan pins where this tally lives (a column on
`pair_calibration` vs a small view over `action_audit` joined to the reward) and
how it is recomputed (the nightly calibration recompute job is the natural host).

### 4.2 Confirmation window matched to signal speed (fast graduation)

The single biggest source of graduation lag is the wait before an action's outcome
can be counted. A flat 14-day window is wrong: a defensive action's benefit is
visible almost immediately, while a growth action genuinely needs time to convert.
So the confirmation window `W` is **per action kind**, set to how fast that action's
signal actually appears:

| Action kind | Window `W` | Why |
|---|---|---|
| `pause_campaign`, `reduce_campaign_budget` | **3 days** | Loss-averted is near-instant: the bleed stops the moment spend stops; 3 days confirms it held. |
| `resume_campaign`, `reallocate_budget`, `discontinue_sku` | **7 days** | Mixed: a loss-stop side is fast, but the "did the winner / catalog actually do better" side needs a week of conversions. |
| `adjust_price`, `reallocate_inventory` | **7 days** | Demand response to a new price / restocked region takes about a week of orders to read. |

No action waits the old 14 days. The pre-window stays `[T−14d, T)` (a stable
baseline of how things were before); only the *post*-window (how long we watch the
result) is shortened per kind. An outcome counts toward graduation as soon as its
window `W` has elapsed, not on a fixed two-week clock.

The exact day counts are fixed constants in v1 (tunable later); the plan pins them
in one shared table read by both the tally and any UI countdown copy.

### 4.3 Data-reality caveat (honest)

Outcome data is **slower than clicks and currently sparse**. As of the
action-learning design (2026-06-19) prod had **zero** `actor_user_id = 'autopilot'`
rows. Implications the plan must handle gracefully:

- The outcome bar can only be met after actions have executed *and* their
  per-kind window `W` (§4.2) has closed — days, not the old two weeks, but still
  not instant. For brand-new pairs graduation is genuinely gated on a few days of
  real results, which is the intended behavior.
- Until a pair has any measured outcomes, its net-positive count is 0, so it cannot
  graduate on clicks alone. This is the desired "both bars" semantics.
- The system must be correct-and-dormant: no measured outcomes ⇒ no graduation and
  no spurious demotion, never a crash or a default-to-trusted.

## 5. Surfaces & parity

- **Embedded app + dashboard:** both already render the calibration band/track and
  the per-pair graduation state. The two-bar progress (approvals *and* outcomes)
  and the new "graduatable" actions must surface on **both** surfaces, mirrored per
  the extension⇄dashboard parity rule (match the contract, not the Polaris code).
- **Plain-language framing:** keep the merchant-facing copy in the existing
  baby-language register — e.g. "Calderyn has done this 6 times and it made money 4
  of those — a couple more good results and it can do this on its own." No jargon
  on the surface; the math lives underneath.

## 6. Non-goals (YAGNI)

- No new reward kernel or outcome metric — reuse `compute_action_reward` verbatim.
- No graduation for `increase_campaign_budget` / `create_po_draft` (no undo branch
  yet).
- No cooling-off / time-delay window for any action (explicitly rejected: breaks
  the overnight-autonomy promise).
- No change to detector math, to `compute_action_reward`, or to guardrail
  semantics — guardrails are read as an autonomous-execution condition, not
  redefined.
- No learned outcome thresholds — the per-tier counts in §2.1 are fixed constants
  in v1 (tunable later).

## 7. Existing seams this design pins (do not redefine)

- `app/lib/calibration/graduation.ts` — `GRADUATABLE_V1` (→ `GRADUATABLE`),
  `MIN_APPROVALS`, `graduationVerdict` (add the outcome gate + demotion inputs).
- `app/lib/calibration/confidence.ts` — `HAS_EXECUTOR`, `ACTION_TIER`,
  `NO_BRAINER` (tiers for the new kinds already present).
- `app/lib/actions/undo.server.ts` — the undo branches that justify the expanded
  set (`resume_campaign`, `reallocate_budget`, `reallocate_inventory`,
  `adjust_price`).
- `engine/calderyn_engine/moat/action_rewards.py::compute_action_reward` — the
  outcome sign, read (not changed) by the new tally.
- `app/lib/calibration/recompute.server.ts` + `app/routes/cron.calibration-recompute.tsx`
  — natural host for the nightly outcome tally + demotion sweep.
- `app/lib/actions/guardrails.ts` / `guardrails.server.ts` — the caps that bound
  autonomous price/inventory moves (§2.4).
- Tables: `public.pair_calibration`, `public.action_audit`, `public.ad_spend_fact`,
  `public.campaign_grade_fact`.

## 8. Open items for the plan to pin (do not guess in code)

1. **Where the outcome tally lives** — new `pair_calibration` columns
   (`net_positive_outcomes`, `last_outcome_sign`, …) vs a view over `action_audit`
   + reward. Leaning toward persisted columns updated by the recompute job, for
   symmetry with the existing approval counters.
2. **Exact demotion window** in §2.3 (consecutive count vs rolling net) — start
   conservative (demote readily), since a demotion is low-cost (just asks again).
3. **Inventory cap field** — confirm the existing guardrail key for the
   per-action inventory unit/percentage cap, or add one if absent.
4. **NO_BRAINER + outcome demotion interaction** — confirm the no-brainer
   confidence floor (`NO_BRAINER_CONF_FLOOR`) does not block §2.3 demotion (it
   shouldn't; the floor is about visibility, demotion is about `graduated`).
