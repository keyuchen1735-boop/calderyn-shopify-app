# Calderyn Calibration

## 1. Summary

Calderyn already runs your shop on autopilot for a tiny set of "no-brainer" fixes (like pausing ads for a product that just sold out). Calibration turns that on/off switch into a leveling-up system: your agent starts at about 25% calibrated and earns its way toward 100% (running the whole shop hands-off) by learning which decisions you trust. Every time the agent is not sure enough to act on its own, it puts the suggestion in an Action Queue; you approve it (and it learns to do that for you next time) or reject it with a reason (and it adjusts how it behaves). Trust is tracked separately for each (problem it detects, fix it proposes) pair, so trusting "pause ads on sold-out products" does not make it trust "move inventory between warehouses." The whole loop is plain arithmetic (no AI deciding anything), and your safety dials (your dollar caps and limits) stay the hard ceiling at every level.

## 2. How calibration % works (the confidence math)

Each (detector, action) pair gets a confidence score from 0 to 100. It is built from three quality factors blended together, with one hard on/off gate in front.

```
conf(detector, action) =
    GUARDRAIL_VETO                         (0 or 1, a hard gate)
  x 100
  x ( 0.30 * detection                     (is the detector right?)
    + 0.50 * historical                    (do this shop's results back it up?)
    + 0.20 * reversibility )               (how easy to undo?)
```

The weights add to 1.0. `historical` carries the most weight (0.50) because it is the only factor that actually learns from you. `detection` and `reversibility` are structural starting points.

| Factor | What it measures | Range |
|---|---|---|
| GUARDRAIL_VETO | Could this pair ever clear the shop's safety dials, and does it have a real executor? | 0 or 1 |
| detection (0.30) | How reliable the detector is for this shop (severity + how often you dismiss it) | 0 to 1 |
| historical (0.50) | Track record: approvals vs rejections/undos/failures, as a Beta posterior | 0 to 1 |
| reversibility (0.20) | How safely the action can be undone | 0 to 1 |

**The `historical` term (the learned dial).** It is a Beta-Bernoulli posterior mean. Each pair stores two counters, `alpha` (good outcomes) and `beta` (bad outcomes). The read always folds in a prior so it never divides by zero:

```
historical = (alpha + alpha0) / (alpha + beta + alpha0 + beta0)
```

where the prior `(alpha0, beta0)` is set from a prior strength `K = 8`:

```
alpha0 = K * p_prior          beta0 = K * (1 - p_prior)
```

`p_prior` comes from the anonymized peer baseline (`moat.action_baselines.p50`) if one exists, otherwise from a static, reversibility-tiered seed in code (see Section 4). After roughly 8 of your real approvals, your signal outweighs the prior.

**Worked example, the canonical pair `(sku_stockout_vs_spend, pause_campaign)` on day one:**

```
reversibility tier = reversible -> base 0.55
in the NO_BRAINER set           -> x 1.30  -> p_prior = 0.715
alpha0 = 8 * 0.715 = 5.72,  beta0 = 8 * 0.285 = 2.28   (no real events yet)
historical   = 5.72 / 8        = 0.715
detection    = 0.6             (cold start, capped at 0.6 until 10+ alerts seen)
reversibility = 1.0
GUARDRAIL_VETO = 1

conf = 100 * (0.30*0.6 + 0.50*0.715 + 0.20*1.0)
     = 100 * (0.18 + 0.3575 + 0.20)
     = 100 * 0.7375  =  ~74
```

So a pre-trusted no-brainer shows ~74% confidence at install. Note: that display number does NOT license an unattended action on day one. Auto-execute requires real evidence (the shadow gate, Section 4 and Section 9, I3).

**The headline Calibration %** is the frequency-weighted average of `conf` across the pairs this shop actually encounters:

```
Calibration_raw = round( SUM over pairs ( weight(pair) * conf(pair) ) )
```

where a pair's weight = how often its detector fired in the last 90 days, split across that detector's legal actions with rank-decay (the recommended action gets the biggest slice). The shown number is then smoothed (Section 9, I6).

**Why the baseline lands around ~25% honestly (not hardcoded).** Only 3-4 pairs are no-brainers scoring ~74. Most legal pairs score low or zero at cold start, because most actions a detector maps to either have no real executor (`exclude_geo`, `create_po_draft`, free-ship kinds, `snooze_alert` -> GUARDRAIL_VETO = 0 -> conf = 0) or are reversible-but-untrained (~50-65). Averaging a few ~74s against a long tail of zeros and mid-range pairs lands in the low-to-mid 20s. A worked early-shop mix:

| Encountered pair | conf | weight | contribution |
|---|---|---|---|
| sku_stockout_vs_spend, pause_campaign | 74 | 0.25 | 18.5 |
| sku_stockout_vs_spend, reduce_campaign_budget | 50 | 0.10 | 5.0 |
| sku_stockout_vs_spend, exclude_geo (no executor) | 0 | 0.10 | 0 |
| sku_stockout_vs_spend, snooze_alert (no executor) | 0 | 0.10 | 0 |
| campaign_below_breakeven, pause_campaign | 74 | 0.10 | 7.4 |
| campaign_scaling_opportunity, increase_campaign_budget | 50 | 0.10 | 5.0 |
| margin_erosion, snooze_alert (no executor) | 0 | 0.10 | 0 |
| long tail of veto-0 pairs | 0 | 0.15 | 0 |
| **Calibration_raw** | | | **~24** |

The number is fully auditable: every term traces back to a row. It rises as you approve, falls if you reject, and can only reach 100 once even the irreversible/no-executor pairs have earned executors plus trust.

## 3. Trust per (detector, action) pair + graduation

Trust is keyed on the pair `(detector_id, action_kind)`. The legal pairs are exactly those in the existing `DETECTOR_TO_ACTIONS` map (`app/lib/labels.ts`). The action-to-detector bridge for raw signal is `action_audit.alert_id -> alerts.detector_id` (the only join that exists).

A pair **graduates to autonomous** (autopilot may fire it without queueing) only if ALL of these hold:

```
1. conf(pair)              >= graduation_threshold(pair)
2. clean_approvals(pair)   >= min_approvals(tier)        (merchant-approved-and-not-undone only)
3. consecutive_undos(pair) = 0
4. merchant_disabled(pair) = false                       ("I handle this myself")
5. has_executor(action)    = true                        (a real platform executor exists)
6. has_undo_branch(action) = true                        (undoAction supports the kind)
7. checkGuardrails(live)   = allowed, with bypass forced OFF (Section 9, I1)
8. passed the mandatory shadow gate (first 3 real instances queued + approved)
```

**Reversible vs irreversible sets a HIGHER BAR, never a permanent ceiling.** With enough clean approvals, `historical -> ~1.0` and the reversibility factor can itself be earned up (every 10 consecutive clean approvals adds +0.10 to the reversibility factor, capping at 1.0), so even an irreversible pair can reach 100. A single undo resets the consecutive-clean counter to 0 (but keeps alpha/beta history).

| Tier | Examples | graduation_threshold | min_approvals | Extra gate |
|---|---|---|---|---|
| reversible | pause_campaign, reduce_campaign_budget, reallocate_budget | 75 | 3 | - |
| hard_to_reverse | create_po_draft | 88 | 10 | - |
| irreversible | physical inventory relocation, exclude_sku_free_ship | 95 | 25 | needs `outcome_confirmed` evidence + merchant raised guardrail headroom |

`graduation_threshold` can be raised per-pair by a `too_aggressive` rejection (+5 each, capped 99), never lowered below the tier floor.

**Graduation is not permanent.** If any condition stops holding (a fresh undo, a reject dropping conf, the merchant tightening a guardrail so the structural veto flips), the pair de-graduates back to queue-only on the next recompute. Trust is continuously re-earned, never banked.

```
   detect alert
        |
        v
   pair graduated? ----no----> ACTION QUEUE (merchant Approve / Reject)
        |                              |
       yes                        approve -> run via existing executor
        |                         reject  -> record reason, learn, no execution
        v
   checkGuardrails (bypass OFF) --block--> skip + record decision
        |
      allowed
        v
   execute -> insertAuditWithIdempotency -> AGENT ACTIVITY (undo within window)
```

## 4. The baseline ~25% set (no-brainers that ship pre-trusted)

These are the only pairs seeded above neutral at install. Each has a static `p_prior = REVERSIBILITY_BASE[tier] x NOBRAINER_BONUS(1.30)`, clamped <= 0.95.

| Pair | Why it is a "no-brainer" | Ships at |
|---|---|---|
| sku_stockout_vs_spend, pause_campaign | Out of stock -> stop paying for ads | conf ~74, shadow-gated |
| campaign_below_breakeven, pause_campaign | ROAS below break-even -> pause | conf ~74, shadow-gated |
| negative_unit_economics, pause_campaign | Losing money on every sale -> pause | conf ~74, shadow-gated |

**Critical: the display seed does NOT auto-run on install.** Every pair, including no-brainers, must pass a mandatory shadow gate (the first 3 real instances on this shop are queued, you approve them, then it graduates). The ~25% headline is a belief, not evidence (Section 9, I3).

**The flagship action `(sku_stockout_vs_spend, pause_campaign)` is NOT always safe.** "Out of stock -> pause ad" is wrong in many common shops. It auto-fires only when ALL of these hold (otherwise it queues):

| Gate | Why |
|---|---|
| `inventory_policy = deny` (not `continue`) | Never auto-pause a pre-order / backorder campaign that is intentionally sold at zero |
| inventory tracking is ON for the SKU | Skip dropship / digital / made-to-order where 0 is normal |
| ALL sellable variants out at ALL locations serving the campaign's geo | Do not pause a campaign over one dead variant when others are in stock; do not pause when another location covers the region |
| live re-check at execution time (freshness gate) | The merchant may have restocked since the alert was written |
| campaign is still actively spending | Do not act on an already-paused / ended campaign |

These preconditions are encoded on the no-brainer, not assumed. They are baked into Section 9, I10.

## 5. The Action Queue page

The to-do list of proposals the agent is not yet confident enough to auto-run. Modeled on the existing alerts-index / audit list, not a new pattern. Graduated (autonomous) pairs are NEVER shown here (they auto-run and appear only on Agent Activity); the queue is exclusively below-threshold proposals.

**Layout (one row per proposal):**

| Element | Source |
|---|---|
| Detector (plain label) + severity dot | `alertDetectorLabel()`, `SevBadge` |
| Proposed action (verb) | `ACTION_LABELS` |
| $ at risk | `alert.dollar_impact` |
| Confidence bar ("62% confident") | per-pair conf, the number that moves the global % |
| Reasoning (one deterministic line) | "ROAS 0.7 for 5 days, reversible, 8/8 past cuts stuck" from evidence + score breakdown |
| "Needs your OK" pill | distinguishes from the Activity feed's "Auto" pill |

**Approve** runs the EXACT existing executor: embedded posts `kind` + `alertId` + `idempotencyKey` to the `app.alerts.$id` `action()` (re-derives all inputs from the trusted alert, never the form body). No new execution path. `reallocate_budget` deep-links to `/app/campaigns` as it does today.

**Reject** opens the reason picker. Reject never calls an executor; it only records the deterministic learning signal and resolves the proposal.

**Reason taxonomy (each reason has a fixed, deterministic effect):**

| Reason | Beta hit (beta +=) | Structural adjustment (deterministic) | "What I learned" reflection |
|---|---|---|---|
| too_aggressive | 0.5 (directionally right) | pair dollar cap x0.75 (compounding, floors at 1 cent); pair mu -0.15 clamp[0.05,1]; graduation_threshold +5 | "Got it. I'll be gentler. I won't cut {campaign} by more than {pct}% at a time." |
| wrong_timing | 0.5 | log reject hour into a per-pair histogram; at >= 3 in a bin, emit `pair_blackout_hours` veto | "Thanks, I'll factor in timing." / once learned: "I won't touch {pair} between {start} and {end} your time." |
| not_enough_data | 1.0 | raise graduation bar +2; 14-day promotion probation; raise detector `alert_thresholds` sensitivity floor | "Fair. I'll wait for stronger proof and keep asking you first for 2 weeks." |
| i_handle_this | 0.0 (NO Beta change) | set `merchant_disabled = true` (mute the action, NOT the alert) | "Got it, I'll leave {pair} to you. Hand it back any time from Learned rules." |
| other (+ note) | 1.0 | none (note stored verbatim, never parsed) | "Noted. Pick a reason category next time so I can learn precisely." |

`i_handle_this` writes NO Beta change on purpose, so muting a pair does not poison the anonymized peer baselines for other shops (Section 9, I8). The note is display-only: escaped, length-capped, parameterized, never fed to any model.

The reflection line uses `DETECTOR_LABELS` + `ACTION_VERBS` for `pair_label`, so it reuses the already-shipped plain-language vocabulary. The exact applied rule is frozen into `action_feedback.applied_rule` at write time.

## 6. The Agent Activity page

A reverse-chronological feed of what the agent is doing (baseline auto-actions + approved actions + retrying rows), each with a time-limited undo. Strong in-repo precedent: the `ActivityFeed` component already inside `screens/Dashboard.tsx`, promoted to a full screen.

**One feed item:**

| Element | Source |
|---|---|
| Relative time (abs on hover) | `created_at` |
| What it did (verb + target) | `ACTION_VERBS` / `ACTION_LABELS` |
| Why | `action_audit.trigger_reason` |
| Mode pill: "Auto" vs "Approved by you" | `actor_user_id` ('autopilot' vs 'merchant') |
| $ impact ("+$240 recovered") | `dollar_impact_at_exec` |
| Undo + countdown ("Undo, 23h left") | `v_audit_view.undo_eligible` + `UNDO_WINDOW_MS` |
| "Retrying" pill | `outcome = 'retrying'` |

**Undo respects the real exec path:** there is NO `undo_token`. Undo posts `intent=undo`, which writes a NEW `action_audit` row with `undo_of = orig.id`, swapped pre/post state, and `dollar_impact_at_exec = -orig`. Eligibility = the computed `v_audit_view.undo_eligible` column ("succeeded AND not an undo AND not already undone AND within the window"). `increase_campaign_budget` has NO undo branch today, so its Undo button is hidden (and it cannot auto-graduate, Section 9, I7).

**Autonomous-action undo windows are 48h (longer than the shorter approved-action window), and every autonomous action triggers a notification at execution time** so the merchant has a real chance to undo something they never watched happen (Section 9, I7).

**"Live" is cheap (no websockets).** Dashboard reuses the `useLiveFeed` poller in `live.ts` (renders `app.feed` live + `app.audit` history with the `LiveBadge` toggle). Embedded uses `useRevalidator` on a 15-30s interval refresh of `client.audit.list()`, matching the existing home-page pattern.

## 7. The learning loop + merchant rules store

The loop is fully deterministic. No LLM in the decision or learning path. Every adjustment is fixed arithmetic keyed off the finite reason taxonomy.

**Signal -> counter updates (atomic DB-side increments):**

| Event | delta alpha | delta beta |
|---|---|---|
| Approve, executes, not undone in window | +1 | 0 |
| Approve, executes, then undone | 0 | +1 |
| Action fails on platform (`outcome='failed'`) | 0 | +1 |
| Reject too_aggressive / wrong_timing | 0 | +0.5 |
| Reject not_enough_data | 0 | +1 |
| Reject i_handle_this | 0 | 0 (mute only) |
| Reject other | 0 | +1 |
| Autonomous action survives 24h (implicit positive) | +0.5 | 0 |
| Autonomous action undone in 24h (implicit negative) | 0 | +1.5 (heavier: real money reversed) |

**Merchant rules store: `public.calibration_rule`** (raw shop, RLS-scoped, PostgREST-readable so the scorer reads it per-request, append-only via `superseded_by`):

| rule_kind | rule_value | Scorer / autopilot effect | Set by |
|---|---|---|---|
| muted_pair | {} | Hard veto: no propose, no auto (but the ALERT still fires) | i_handle_this |
| pair_dollar_cap | {cents} | Clamp this pair's dollar impact; downsize or skip | too_aggressive |
| pair_mu_override | {mu} | Scale this pair's cut/increase sizing (merchant-visible mirror of `moat` mu) | too_aggressive |
| pair_blackout_hours | {hours:[0..23]} | Per-pair UTC time veto, evaluated like `withinBusinessHours` | wrong_timing (hist >= 3) |
| pair_min_spend | {cents} | Per-pair spend floor above the shop-global `autopilot_min_spend_cents` | too_aggressive on small spend |
| pair_probation_until | {until, bar_bonus} | Block graduation until timestamp; add to graduation bar | not_enough_data |

**How the scorer checks rules** (per candidate, first veto wins, mirroring `evaluateGuardrails`):

```
1. muted_pair?                 -> VETO (no propose, no auto)
2. pair_blackout_hours hits?   -> VETO this cycle
3. pair_min_spend not met?     -> VETO
4. checkGuardrails(bypass OFF) -> ABSOLUTE veto if blocked
5. compute conf (Section 2)
6. apply pair_dollar_cap: clamp/downsize the proposed dollar impact
7. apply pair_mu_override: size = maxPct * mu_override
8. graduated + conf >= threshold + not on probation -> AUTO-EXECUTE (still via checkGuardrails)
   else                                              -> ENQUEUE to Action Queue
```

The learning loop may write `guardrail_config` ONLY in the tightening direction (server-side `Math.max`/`Math.min` clamp refuses any loosening). Loosening is exclusively the merchant editing Settings.

**Rules are visible, attributable, undoable.** A "Learned rules" view renders each rule in plain language ("I won't act on campaigns spending under $50/day" from `pair_min_spend {cents:5000}`) with its `source` and date. Undo sets `active=false` (never hard-delete); it does not retroactively change Beta confidence but is logged to Agent Activity.

**Latency split:** the interactive approve/reject does the alpha/beta bump and a single-pair conf recompute synchronously (so the % moves immediately). The nightly cron does peer rollups, the implicit auto-survive/auto-undo sweep, and the full re-derivation. The cron is the only writer of the smoothed headline.

## 8. Data model changes

**Reused unchanged:** `action_audit` (outcome/undo_of/dollar_impact_at_exec/actor_user_id/alert_id are the raw alpha/beta inputs), `alerts` (detector_id/severity/status feed detection + the encountered set; the queue is a query over `v_alerts_view`), `guardrail_config` (the structural veto + tightening targets), `moat.action_models`/`autopilot_action_mu` (aggressiveness, untouched), `alert_thresholds.threshold_json` (the not_enough_data target).

**New table `public.pair_calibration`** (PK `(shop_id, detector_id, action_kind)`):

| Column | Type | Note |
|---|---|---|
| shop_id, detector_id, action_kind | uuid, text, action_kind | PK; reuse the enum |
| alpha, beta | numeric (default 0) | Beta counters (prior added at read) |
| clean_approvals, consecutive_clean_approvals, consecutive_undos | int4 | graduation + reversibility ratchet |
| graduation_threshold | int4 | tier default, raised by too_aggressive |
| merchant_disabled, graduated | bool | mute flag; cached graduation verdict |
| last_conf, last_detection | int4, numeric | cached for cheap reads |
| updated_at | timestamptz | |

**New table `public.action_feedback`** (append-only reject-reason ledger, PK `id`): `shop_id, alert_id, detector_id, action_kind, decision (CHECK approve|reject), reject_reason (CHECK enum), note, applied_rule (frozen at write), created_at`.

**New table `public.calibration_rule`** (Section 7 schema).

**New column `public.shops.calibration_pct int4` + `calibration_updated_at`** the cached smoothed headline, one cheap read.

**New SECURITY-DEFINER fn `public.action_pair_prior(p_shop_id, p_detector, p_action) -> numeric`** mirrors `autopilot_action_mu`: resolves pseudonym, returns `moat.action_baselines.p50` (k-anon n>=5), else NULL. `search_path=''`, EXECUTE granted to `service_role` ONLY. Keeps `moat` off PostgREST.

**New view `v_pair_calibration`** (security_invoker, shop-scoped) for the queue UI; arithmetic lives in the recompute job + the synchronous path, not the view.

**RLS note (non-negotiable):** all three new tables get RLS `ENABLE + FORCE` scoped to `shop_id`, service_role bypass only for the trainer. Ship only after `get_advisors` shows 0 RLS ERRORs and a cross-tenant test confirms shop A sees zero of shop B's rows (Section 9, I9).

**New cron route `cron.calibration-recompute.tsx`** thin, identical in shape to `cron.autopilot-train.tsx` (CRON_SECRET bearer -> POST `{origin}/api/engine/calibration-recompute`), or folded into the existing `/api/engine/autopilot-train` job.

## 9. SAFETY INVARIANTS (non-negotiable)

An autonomous (auto-executed, no human) action is permitted ONLY if every one of I1-I10 holds. These are encoded in the spec, enforced in code, and covered by tests.

**I1 - Guardrails are an absolute veto with bypass forced OFF.** Every Calibration auto-execute calls `checkGuardrails` evaluated as if `autopilot_bypass_guardrails = false`. The merchant's `dollar_impact_cap_without_2fa` applies to autonomous actions unconditionally. The learning loop may write `guardrail_config` only in the tightening direction (server-side clamp).

**I2 - Daily aggregate dollar ceiling AND finite action count.** Reuse the EXISTING `daily_action_budget_cents` guardrail (default $2,500/day, already shown in Settings / onboarding / dashboard with "used today" tracking) but actually ENFORCE it. It is currently displayed and tracked but NOT checked in `evaluateGuardrails` ([guardrails.ts:55-105](app/lib/actions/guardrails.ts#L55-L105) gates the per-action `dollar_cap_cents` and per-campaign `maxDailyBudgetCents`, never the daily aggregate). Add a `todayAutopilotDollarsCents` fact and gate `SUM(today autonomous impact) + this <= daily_action_budget_cents`. The daily action COUNT cap (`dailyActionCap`) may not be unlimited for autonomous actions: a NULL cap is treated as a conservative default of 5, not infinity. (This is a PRE-EXISTING enforcement gap in current autopilot, not just a Calibration concern; Calibration must close it because it broadens the action set. The per-action cap alone is insufficient.)

**I3 - Graduation requires evidence, not belief.** `clean_approvals >= K AND conf >= threshold AND consecutive_undos = 0 AND not on probation AND not muted`, where K = 3 (reversible) / 10 (hard_to_reverse) / 25 (irreversible), and "clean approval" = merchant-approved-and-not-undone (no install-time seed counts). Every pair, including no-brainers, passes a mandatory shadow gate of the first 3 real instances before its first graduation.

**I4 - Freshness gate + live precondition re-check at execution time.** Decision facts must be <= T_fresh old (stock <= 60 min, spend <= 24h). The executor re-reads live entity state and aborts (records `skipped: precondition_stale`) if the precondition no longer holds (in stock now, already paused, live budget already <= target).

**I5 - Value-changing actions are idempotent on outcome, not just on key.** Budget mutations target an absolute value re-derived from live current budget and become a no-op if the live state already matches. Idempotency scope covers `(shop, campaign, kind, day-bucket)`. A graduated pair is never simultaneously in the merchant queue (eliminates the merchant-approve vs autopilot-fire double-execute race).

**I6 - Single-writer concurrency.** A per-shop advisory lock wraps each autopilot/recompute tick. alpha/beta are updated via atomic DB-side increments (`SET alpha = alpha + $delta`). `shops.calibration_pct` is written by the cron only (the synchronous path writes a pending nudge folded in on next read). alpha/beta are a pure idempotent re-derivation from append-only rows, so the cron self-corrects drift. The headline is smoothed: `display(t) = round(0.30*raw + 0.70*display(t-1))`, clamped to +/-5 per day with a sub-1-point dead-band; the merchant's own just-made action is exempt from the clamp for that pair so they see immediate cause and effect.

**I7 - Reversibility classification must match real undo capability.** A kind scores `reversible` only if it has a working `undoAction` branch within the promised window. `increase_campaign_budget` cannot auto-graduate until its undo branch lands in `undoAction` + `GATEWAY_UNDO_KINDS`, and scores `hard_to_reverse` (0.5) until then. `reallocate_inventory` / physical-goods kinds are `irreversible` for graduation and require `outcome_confirmed` evidence (not mere non-undo) plus explicit merchant guardrail-headroom. Autonomous-action undo windows are 48h (longer than approved-action windows) and trigger a notification at execution.

**I8 - Safety-critical (no-brainer) pairs are mute-resistant and floor-protected.** Muting or reject-spamming a no-brainer downgrades it to "always ask," never to silent: the underlying ALERT always still fires. A per-pair confidence floor prevents permanent self-disabling. After N consecutive rejects of a no-brainer, an "are you sure? this protects you from X" interstitial appears before the structural adjustment applies. `i_handle_this` writes NO Beta change (protects peer baselines).

**I9 - Per-shop RLS isolation, verified.** `pair_calibration`, `calibration_rule`, `action_feedback` have RLS `ENABLE + FORCE` scoped to `shop_id`. SECURITY-DEFINER fns are `service_role`-EXECUTE-only with `search_path=''`. `get_advisors` shows 0 RLS ERRORs; an automated cross-tenant test asserts shop A sees zero of shop B's rows and cannot call the definer fns. Free-text notes are escaped, length-capped, parameterized, never fed to any model.

**I10 - Flagship-action precondition allowlist.** `(sku_stockout_vs_spend, pause_campaign)` auto-fires only when: `inventory_policy = deny`, tracking ON, ALL sellable variants out at ALL serving locations, fresh live re-check passes, and the campaign is still actively spending. Otherwise it queues.

(Resolved cross-cutting blocker S0: the two design drafts disagreed on storage and math. This spec adopts ONE model: `public` RLS store, additive convex combination, K=8, the stricter graduation bars (75/88/95 with 3/10/25 approvals), and mute = no-Beta-change.)

## 10. Dashboard parity

This is dual-surface. Both sides read the same contract: `pair_calibration` / `shops.calibration_pct` / `action_feedback` / `calibration_rule`. Match the contract, not the code (the dashboard is non-Polaris, Lucide via `<CDIcon>`, its own `cd-*` primitives).

| Surface | Embedded (Polaris, `app/routes/app.*`) | Dashboard (SPA, `app/components/dashboard/*`) |
|---|---|---|
| Calibration header | New `app/components/calderyn/CalibrationHeader.tsx`, first `Layout.Section` in `app/routes/app._index.tsx`; reuse `GuardrailMeter` + `StatTile`; add `calibration` to the loader payload | New `CalibrationHeader({app})` as first child of `screens/Dashboard.tsx`; reuse `Card` + `RingGauge`/`Meter` + `Pill` + `CountNum`; add `target` to `CD_ICONS` |
| Action Queue | New route `app/routes/app.queue.tsx` (mirrors `app.alerts._index.tsx` loader); `intent=reject` records feedback; Approve posts to existing `app.alerts.$id` executor; add to `app.tsx` NavMenu | New `screens/ActionQueue.tsx` (copy `Audit.tsx` skeleton); register in `context.ts` Screen union + `NAV_ITEMS` (icon `bolt`) + `SCREENS`; reject via `intent=reject` branch on `dashboard.api.alerts.$id.action.tsx` |
| Agent Activity | New route `app/routes/app.activity.tsx` (reuse `app.audit.tsx` loader + `intent=undo`); `useRevalidator` interval refresh | New `screens/AgentActivity.tsx` (promote the existing `ActivityFeed`); register identically (icon `scan`); reuse `cd-feed` + `LiveBadge` + `useLiveFeed` |
| Calibration read API | `client.calibration.get()/list()` on `calderynClient` reading `action_pair_prior` + `pair_calibration` | New `dashboard.api.calibration._index.tsx` (one-liner pattern from `dashboard.api.audit._index.tsx`); `calibration` added to `OverviewVM`/`DashboardCtx` via `adaptOverview` |
| Server facade + write | New `.calibration` namespace on `calderynClient` (`app/lib/calderyn.server.ts`); reject-learning write in new `app/lib/calibration/feedback.server.ts` | Same facade reused; reject branch on the existing dashboard alert-action route |

Both sides also need: `app/lib/calibration/confidence.ts` (pure Beta math, mirrors `guardrails.ts` purity), `app/lib/calibration/rules.server.ts`, `app/lib/calibration/reflect.ts` (the reflection templates).

## 11. Build order (smallest shippable first)

| Slice | Ships | Why first |
|---|---|---|
| 0. Decisions + migrations | The three tables + `shops.calibration_pct` + `action_pair_prior` fn + RLS + advisor/cross-tenant tests | Nothing else can exist without the store; RLS gate is a hard precondition |
| 1. Pure math + read-only header | `confidence.ts`, the recompute job (cron), the Calibration header on both surfaces reading the cached %. No auto-execute yet | Proves the ~25% emerges honestly with zero risk to money; merchant sees a number |
| 2. Action Queue (read + Approve) | The queue page both surfaces; Approve reuses the existing executor; alpha/beta bump on approve | First real learning signal; still no autonomous action, so still safe |
| 3. Reject + reason taxonomy + Learned rules | The reason picker, deterministic adjustments, `calibration_rule` writes, reflections, Learned-rules view | Completes the interactive loop |
| 4. Agent Activity + undo | The feed both surfaces, reusing the existing undo path; autonomous-action notification | Visibility before autonomy |
| 5. Graduation + shadow gate + scorer in autopilot | Wire the scorer into `runAutopilotForShop`, shadow gate, graduation/de-graduation, I1-I10 enforcement, the flagship precondition allowlist | The only slice that lets the agent act unattended; gated behind everything above and all invariants |
| 6. First-run tutorial | 3-step overlay, gated on a `shops.calibration_tour_seen` flag | Polish once the surfaces exist |

Each slice goes in its own worktree (`feat/calibration-<slice>`), passes the pre-commit gate, and ships single-sided only with an explicit dashboard TODO if unavoidable.

## 12. Open questions / decisions deferred

1. **`outcome_confirmed` substrate.** Irreversible graduation (I7) requires the engine to emit a post-hoc "this action actually helped" signal. That `moat.event_log` `outcome_confirmed` kind exists but is not yet populated. Until the engine ships it, irreversible pairs cap at `shadow` and cannot graduate. Decision deferred to the engine team.
2. **Daily aggregate dollar ceiling (I2): RESOLVED.** Reuse the existing `daily_action_budget_cents` guardrail (default $2,500/day) rather than a new field. The work is wiring it into `evaluateGuardrails`, which does not currently enforce it. No new UX, no new default.
3. **Autonomous undo-window length (I7): RESOLVED at 48h** plus a notification at execution time. The notification channel (email vs the existing digest) is confirmed during build, not a design blocker.
4. **Scale-up autonomy: DEFERRED for v1 (founder call: "sure, but don't overcomplicate it for the user").** `increase_campaign_budget` stays approval-only and cannot auto-graduate in v1, because it has no `undoAction` branch and I7 forbids autonomy without one. Building that undo branch (which unlocks scale-up autonomy) is a later iteration, kept out of v1 to keep the merchant experience simple.
5. **Shadow gate count (currently 3).** Whether the mandatory shadow count should differ by tier (e.g. more for risky pairs) or stay flat at 3.
6. **Peer-prior cold-start dependency.** `action_pair_prior` returns NULL until peers train (k-anon n>=5). Early shops fall back to the static seed, which is fine, but the headline will not benefit from cross-shop learning until the network grows. No action needed, flagged for expectations.
