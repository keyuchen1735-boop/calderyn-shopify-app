# Autopilot Action-Learning ("the action moat") — Umbrella Design (Shared Contract)

> **Status:** Approved design (brainstorm 2026-06-19). This is the FIXED contract
> that the six slice specs build against. A slice MUST NOT contradict anything
> here; if it needs to change a shared interface, it raises an open question back
> to the orchestrator rather than diverging.

**Date:** 2026-06-19
**Topic:** make autopilot get smarter as it acts on more merchant data — magnitude
tuning, targeting, and an anonymized cross-tenant peer prior — by mirroring the
existing moat loop but for *action policy* instead of *detection thresholds*.

This is the **D** workstream. The sibling fast-track streams (A = make-it-act
observability, B = guardrail parity, C = custom/unlimited guardrail fields) ship
separately and are preconditions for *data*, not for *this design*.

---

## 1. Problem

The autopilot (`app/lib/actions/autopilot.server.ts` → `runAutopilotForShop`, run by
`app/routes/cron.autopilot.tsx` every 30 min) chooses action **magnitude** from
static per-shop caps: a pause is binary, a cut is always `currentBudget × (1 −
maxCutPct)`, a scale is always `currentBudget × (1 + maxIncreasePct)`. It never
learns. Two consequences:

1. **No magnitude intelligence.** Every cut is the maximum allowed cut; every
   scale is the maximum allowed scale. There is no notion of "this shop /
   segment does better with a gentler 15% trim than a 50% chop."
2. **Shop- and SKU-scoped problems can never act.** The detectors that should
   drive cuts/reallocation — `ad_tax_overload` (shop-scoped) and
   `negative_unit_economics` (SKU-scoped) — emit alerts whose `entity_ref` has no
   `campaign_id`. `v_autopilot_candidates` inner-joins `ad_campaign_dim ON
   (entity_ref->>'campaign_id')::uuid`, so those alerts are dropped before
   autopilot sees them. **Reallocate is therefore structurally impossible today**;
   pause works only for `campaign_below_breakeven`.

Verified against prod (`ajgrmnvzxfxxlwrxcgnu`, 2026-06-19): `action_audit` has
**zero** rows with `actor_user_id = 'autopilot'` — autopilot has never acted, so
there is also zero action-outcome history to learn from yet.

The moat (`engine/calderyn_engine/moat/`) already solves the analogous problem for
*detection*: a per-`(shop, detector)` Beta posterior, seeded from an anonymized
k≥5 peer prior, shrunk by the shop's own reward signal. We mirror that machinery
for *action policy*.

## 2. Decision — a learned aggressiveness dial within the merchant's hard caps

Autopilot keeps one learned scalar per `(shop, detector, action_kind)`: an
**aggressiveness dial** `μ ∈ [0, 1]`.

- At act-time, `chosen_magnitude_pct = μ × merchantCapPct`. The merchant guardrail
  (`autopilot_max_budget_cut_pct`, `autopilot_max_budget_increase_pct`, and the new
  Custom/Unlimited limits from stream C) is the **hard ceiling**; learning only
  ever picks a value *within* `[0, cap]`. Learning can make autopilot more
  conservative on its own; it can NEVER exceed a limit the merchant set, and
  `checkGuardrails` still runs and can still block.
- `μ` is the mean of a Beta posterior, **seeded from the anonymized peer baseline**
  for the shop's GMV segment and **updated nightly** from the shop's own action
  outcomes. This is the moat mechanism (`threshold_trainer._seed_prior` +
  `update_threshold`), reused verbatim.
- **Cold start:** a shop with no action history of its own inherits the peer
  consensus dial (`μ = peer p50`) — strictly better than "always max." This is the
  network effect: every new shop benefits from every prior shop's anonymized
  action outcomes.

**Trust graduation is explicitly out of scope.** Autopilot stays autonomous within
guardrails; there is no propose-first / earn-autonomy mode. Learning tunes *how
much*, *where*, and *cold-start-from-peers* — not *whether to act on its own*.

## 3. The closed loop

```
nightly /cron/autopilot-train  →  POST /api/engine/autopilot-train
  │
  ├─(D1 per-shop, RAW)  action_audit ⋈ ad_spend_fact[T±14d] ─► action-reward inputs
  │                       per (shop, detector, action_kind)              │
  │                                                                      │
  ├─(D2 cross-tenant, ANON)  winning actions ─► pseudonymized projection │
  │     └─► moat.action_baselines (consent + k≥5, per segment) ──────────┤ (peer PRIOR)
  │                                                                      ▼
  └─(D3 trainer)  seed prior α₀,β₀ from peer action-baseline ─► update_threshold(prior, reward)
                    ─► rescale posterior mean → μ ∈ [0,1]
                    ─► upsert moat.action_models (policy_json={mu,…}, posterior_json,
                                                  keyed by shop_id_pseudonym)
                                                                      │
  (D5 consume, TS)  runAutopilotForShop reads μ via get_action_policy ◄┘
                    magnitude = μ × merchantCap   (falls through to full cap until a row exists)

  (D6 targeting, TS, independent)  shop/SKU-scoped alert ─► resolve campaign via
                    campaign_grade_fact / v_campaigns_flat ─► feeds the SAME action loop
                    (this is what finally makes reduce + reallocate fire)
```

## 4. Reward signal — hybrid (outcome delta + undo veto)

Pure kernel `compute_action_reward(...)` (mirrors `moat/rewards.py`): numbers in,
`Decimal` reward out, no I/O, fully reproducible.

**Inputs per executed autopilot action** (from `action_audit` where
`actor_user_id='autopilot'`): `action_kind`, target `campaign_id` (and
`dest_campaign_id` for reallocations) from `params`, exec time `T = created_at`,
and whether a later row has `undo_of = this.id`.

**Outcome metric** (from `ad_spend_fact`, per campaign): ROAS =
`Σ revenue_attrib_cents / Σ spend_cents` and profit = `Σ(revenue_attrib_cents −
spend_cents)`, each computed over the **post window `[T, T+14d]`** vs the **pre
window `[T−14d, T)`**. Break-even reference from `campaign_grade_fact.break_even_roas`
(or `v_campaigns_flat`).

**Goal-aware reward** (sign convention: positive = the action helped):
- `pause_campaign`, `reduce_campaign_budget` → **loss averted**: positive when the
  pre-window campaign was below break-even and the post-window bleed stopped/shrank.
- `increase_campaign_budget` → **profit delta**, positive ONLY if post-window ROAS
  held above break-even (penalize scaling into diminishing returns).
- `reallocate_budget` → `Δprofit(source) + Δprofit(dest)`.
- **Undo → hard negative** (a flat penalty mirroring `FALSE_POSITIVE_PENALTY`),
  overriding the outcome math: a merchant reverting an autopilot action is an
  unambiguous veto.

`days_to_confirm`-style recency decay is reserved but unused in v1 (matches the
moat's v1 `compute_reward`).

## 5. The learned object & rescale

`moat.action_models` row per `(detector_id, action_kind, shop_id_pseudonym)`:
- `posterior_json` = `{alpha, beta, n_events, last_reward, n_peers, seeded_from}`
  — same Beta-posterior shape `update_threshold` reads/writes.
- `policy_json` = `{mu}` where `μ = alpha/(alpha+beta)`, clamped to `[0, 1]`.

The posterior mean `m = alpha/(alpha+beta) ∈ [0,1]` is rescaled to `μ` by the moat's
`_rescale` **in fraction-space instead of dollar-space**: the peer baseline's
`p25/p50/p75` are *winning aggressiveness fractions* (see §6), and the same
piecewise-linear anchor maps `m=0.5 → p50`, `m>0.5 → toward p25`, `m<0.5 → toward
p75`. So **cold start (mean 0.5) lands exactly on the peer median fraction `p50`**,
and own rewards then shrink μ away from peer consensus. With NO baseline, `μ`
falls back to `1.0` (the full merchant cap = today's behavior), never a bare `0.5`.
The exact monotonic direction (does a *good* outcome push toward more or less
aggressive next time?) is pinned in the D3 slice spec; the umbrella only fixes that
cold-start = `p50` and that μ ∈ [0,1] scales the merchant cap.

## 6. Peer action-baselines (the actual moat)

`moat.action_baselines(segment, detector_id, action_kind, p25, p50, p75, n)`.
Nightly, a pseudonymized projection takes each *positively-rewarded* autopilot
action across **consenting** shops, computes its **aggressiveness fraction**
(`chosen_magnitude_pct / cap_at_exec`), and aggregates the distribution per
`(segment, detector_id, action_kind)` with a **k≥5 distinct-contributor floor**.
`segment` is the shared `gmv_band_for_shop(conn, shop_id, run_date)` resolver
(reused from `moat/peer_incident_etl.py`) so the baseline a shop reads at
train-time matches the band it contributed under.

**Open contract items (D1/D2 must pin, do not guess):**
- *Chosen-pct source.* The historical action's chosen magnitude pct is derived
  from `action_audit.params` (old vs new daily budget for cut/scale; transferred
  amount vs source budget for reallocate). D1 reads the actual `params` key names
  from a live `autopilot`-actor row and pins them; if old-budget isn't recorded,
  fall back to `ad_spend_fact` budget around `T`.
- *Cap-at-exec source.* `aggressiveness_fraction = chosen_pct / cap`. If the cap
  in force at exec time is not persisted on the action row, D2 approximates with
  the shop's CURRENT `autopilot_max_budget_*_pct` and **flags this approximation in
  the projection payload** (fail-visible, rule 12) rather than silently assuming.

## 7. Consume seam (TypeScript)

`get_action_policy(sb, shopId, detectorId, actionKind) → number | null` in the TS
runtime (new helper beside `autopilot.server.ts`), mirroring Python `get_threshold`:

1. Resolve pseudonym via the existing key table — `select pseudonym_id from
   moat_keys.shop_pseudonym where shop_id = $1`. **Do NOT re-implement `pseudonym_for`
   (HMAC) in TypeScript** — read the mapping the Python emitter already wrote. If no
   pseudonym row, return `null`.
2. `select policy_json->>'mu' from moat.action_models where shop_id_pseudonym = $p
   and detector_id = $d and action_kind = $k`. Missing → `null`.
3. `null` → autopilot uses the **full merchant cap** (today's exact behavior). This
   is a zero-behavior-change cutover until D3 writes rows.

`runAutopilotForShop` then computes the cut/scale target with
`effectivePct = (μ ?? 1) × merchantCapPct`, still passed through `checkGuardrails`.

## 8. Targeting (D6 — deterministic v1, the "where it sees fit" enabler)

Shop-scoped `ad_tax_overload` alerts gain a campaign target so they can finally
act. **Do not loosen `v_autopilot_candidates`'s inner join** (it correctly serves
campaign-scoped detectors); instead add a SECOND candidate source for the scoped
detector that resolves the campaign in TS:
- `ad_tax_overload` (cut/reallocate-source) → the worst-graded non-winning
  campaign with a live daily budget, via the existing `pickReallocation` helper
  (which already ranks by `campaign_grade_fact` grade then ROAS).

v1 selection is **deterministic grade-rank** (rule 5: routing in code, not the
model). The reward loop attributes outcomes per `(detector, chosen campaign,
action)`, so learned campaign-selection is a clean future extension — explicitly
**deferred**, not designed here.

**SKU-scoped `negative_unit_economics` targeting is CUT from v1** (verified against
prod `ajgrmnvzxfxxlwrxcgnu`, 2026-06-19): `attribution_fact` carries
`order_id → campaign_id → attributed_revenue_cents`, **no `sku_id` and no `roas`**.
A SKU→campaign map therefore needs an `order_id → order-line-item SKU → campaign`
join plus per-campaign ROAS derived from `ad_spend_fact` — a real feature, not a
deterministic one-liner, and `negative_unit_economics` is a unit-economics/COGS
signal that doesn't cleanly map to a single ad campaign anyway. Deferred to a
follow-up; v1 targeting is `ad_tax_overload` only. `negative_unit_economics`
remains in `PAUSE_DETECTORS` (harmless: SKU-scoped alerts still never enter the
campaign-scoped candidate view, exactly as today).

## 9. Architecture — Hybrid (reuse kernels, own model family + cron)

- **Reuse (never re-implement):** `pseudonym_for`, `update_threshold` (Beta nudge),
  `_seed_prior`, consent + k≥5 gating, the cohort-runner + per-`(shop, group)`
  fail-visible/pooler-safe transaction shape from `threshold_trainer.py`, and
  `gmv_band_for_shop`. These carry the anonymization invariants — importing them is
  mandatory; copying them is forbidden.
- **Own:** new tables `moat.action_models`, `moat.action_baselines`; Python trainer
  entrypoint `POST /api/engine/autopilot-train`; TS cron route `/cron/autopilot-train`;
  TS consume seam `get_action_policy`; TS targeting resolver. Decoupled from the
  detector-threshold trainer — separate cron, separate failure domain.
- **Language split (contract):** TRAIN is Python (to reuse the kernels and read
  `action_audit ⋈ ad_spend_fact`); CONSUME is TypeScript (autopilot runtime is TS).
  The two meet only at `moat.action_models` + `moat_keys.shop_pseudonym`.

## 10. Anonymization invariants (HARD — inherited verbatim from the moat)

| # | Invariant |
|---|---|
| A1 | Cross-tenant aggregation reads only pseudonymized ids, never raw `shop_id`. |
| A2 | Only consenting shops (`shops.peer_data_consent = true`) contribute to any peer aggregate or projection. |
| A3 | k≥5 distinct-contributor floor per `(segment, detector_id, action_kind)` before a baseline is published; suppress otherwise. |
| A4 | `moat.action_models` is keyed by `shop_id_pseudonym`; the stored model never carries raw shop identity. |
| A5 | Per-shop training MAY use the shop's own raw `action_audit`/`ad_spend_fact` (it is theirs). Only the CROSS-tenant prior must be anonymized + consented + k-floored. |

A slice that cannot satisfy a relevant invariant STOPS and reports it.

## 11. Slice decomposition

| Slice | `<slice>` | Owns | Consumes (seam) | Produces (seam) |
|---|---|---|---|---|
| **D1** | `action-reward` | `compute_action_reward` kernel + `derive_action_reward_inputs` (action_audit ⋈ ad_spend_fact, T±14d, goal-aware, undo veto) | domain tables | reward-input rows for D3 |
| **D2** | `peer-action-etl` | pseudonymized projection of winning actions → `moat.action_baselines` (consent + k≥5, per segment) | domain tables + consent flag | `moat.action_baselines` (prior for D3) |
| **D3** | `action-trainer` | seed prior from baseline → fold rewards → rescale → μ → upsert `moat.action_models`; idempotent; `POST /api/engine/autopilot-train` | D1 inputs + D2 baselines | `moat.action_models` rows |
| **D4** | `train-cron` | `/cron/autopilot-train` route + `vercel.json` entry; nightly; `CRON_SECRET`; surfaces non-empty `errors[]` as non-200 | invokes D3 entrypoint | scheduled trainer run |
| **D5** | `consume` | TS `get_action_policy`; thread μ into `runAutopilotForShop`'s cut/scale magnitude; safe full-cap fall-through | `moat.action_models` + `moat_keys.shop_pseudonym` | learned magnitudes at act-time |
| **D6** | `targeting` | TS resolver: shop/SKU-scoped detectors → campaign via grades; second candidate source; **makes reduce + reallocate fire** | `campaign_grade_fact`, `v_campaigns_flat`, `attribution_fact` | campaign-targeted defensive actions |

**Dependency order (implementation, not spec):** D1, D2 → D3 → D4; D5 independent
(safe no-op until D3 writes); **D6 independent and deterministic** — it delivers
the user-visible "pause + reallocate where it sees fit" capability with no learning
dependency, so it can ship FIRST.

## 12. Data reality — what "smart" actually requires (honest)

The code will be correct and **largely dormant** at first, exactly like the moat:
- **0 `action_audit` autopilot rows** → no own action-reward signal until stream A
  lands and autopilot actually acts (and accrues 14d of post-action outcomes).
- **6 shops, all consenting**, but reaching **k≥5 in one GMV band** is unlikely
  until the base grows → peer action-baselines stay suppressed a while.
- Until both exist, `get_action_policy` returns `null` and autopilot behaves
  **exactly as it does post-A** (full merchant cap). D6's targeting, being
  deterministic, is the one slice that delivers value on day one.

"Smart" is gated on go-to-market (actions accrue + cohort grows), not on merge —
by design: the consent gate, k≥5 floor, and full-cap fall-through keep the system
safe and silent until real anonymized action data accrues.

## 13. Non-goals (YAGNI)

- No trust-graduation / propose-mode (autopilot stays autonomous within guardrails).
- No learned campaign-selection in v1 (targeting is deterministic grade-rank).
- No recency decay in `compute_action_reward` (signature reserves it; v1 ignores).
- No change to `v_autopilot_candidates`'s existing inner join, to `executeAction`,
  or to guardrail semantics — D5 only chooses a value *within* the existing cap.
- No re-implementation of any anonymization primitive in TypeScript (consume reads
  the pseudonym mapping the Python side already wrote).
- No dependency on streams A/B/C beyond the obvious: A makes autopilot act (so
  outcomes exist to learn from); C's new caps are honored as the hard ceiling.

## 14. Existing seams this design pins (do not redefine)

- `engine/calderyn_engine/moat/threshold_updater.py::update_threshold` — Beta nudge.
- `engine/calderyn_engine/moat/threshold_trainer.py` — `_seed_prior`, `_fold_group`,
  `_cohort_shop_ids`, `_upsert_model`, the pooler-safe per-group transaction shape.
- `engine/calderyn_engine/moat/pseudonym.py::pseudonym_for` — HMAC, irreversible.
- `engine/calderyn_engine/moat/peer_incident_etl.py::gmv_band_for_shop` — segment.
- `app/lib/actions/autopilot.server.ts::runAutopilotForShop` — consume host.
- `app/lib/actions/guardrails.ts` / `guardrails.server.ts` — the hard caps μ scales within.
- `app/lib/actions/reallocation-suggest.server.ts` (`loadReallocationCandidates`,
  `pickReallocation`) + `reallocate.server.ts` — reused by D6 for dest selection.
- Tables: `public.action_audit`, `public.ad_spend_fact`, `public.campaign_grade_fact`,
  `public.v_campaigns_flat`, `public.attribution_fact`, `moat.action_models` (new),
  `moat.action_baselines` (new), `moat_keys.shop_pseudonym`, `shops.peer_data_consent`.
