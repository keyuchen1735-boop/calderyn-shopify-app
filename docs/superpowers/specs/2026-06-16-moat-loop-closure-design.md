# Moat Loop Closure — Umbrella Design (Shared Contract)

> **Status:** Approved design. This is the FIXED contract that the five slice
> specs (#2–#6) build against. Slice specs MUST NOT contradict anything here.
> If a slice needs to change a shared interface, it raises it as an open
> question back to the orchestrator — it does not unilaterally diverge.

**Date:** 2026-06-16
**Owner:** orchestrator (this session)
**Plan 05** — moat (cross-tenant learning) layer.

---

## 1. Problem

The moat layer (`engine/calderyn_engine/moat/`) is a **horseshoe, not a circle**.
Verified against this checkout + prod DB (`ajgrmnvzxfxxlwrxcgnu`):

- **EMIT** — `emit_moat_event` is called once (`pipeline.py:248`, `detection_fired`
  only), savepoint-guarded, gated on `MOAT_PEPPER`. `moat_keys.shop_pseudonym`
  has **0 rows** in prod ⇒ the live emitter has **never successfully run**.
- **REWARD** — `alert_feedback` / `action_executed` / `outcome_confirmed` have
  **no producer** (the TS app emits zero moat events; no `packages/` dir exists).
- **TRAIN** — `compute_reward`, `update_threshold`, `compute_peer_baselines`,
  `extract_incident` are pure kernels called **only by tests**. No trainer, no cron.
- **CONSUME** — `get_threshold` (`thresholds.py:68`) is the only reader of
  `moat.detection_models` and is **never called**; all 12 detectors use the
  static `DEFAULT_THRESHOLD_USD = Decimal("500")`.
- Prod moat tables exist but hold only a **single 2026-06-04 seed load**
  (14 event_log rows w/ 0 backing pseudonyms; 1 detection_models row with
  integer α=5/β=1 — a hand fixture, not trainer output).

## 2. Decision — derive at train time (hybrid)

The reward signal **already exists** in domain tables. Do NOT build a parallel
click-time event stream. Instead:

- **Per-shop training** reads RAW domain tables directly
  (`alerts ⋈ alert_feedback ⋈ action_audit`). No pseudonymization (own data).
- **Cross-tenant moat** flows through a nightly **pseudonymized projection**
  into `moat.event_log` (consent + k≥5 gated), which feeds `compute_peer_baselines`.
  `moat.event_log` becomes its true thing: the **anonymized cross-tenant ledger**,
  not a redundant per-shop copy.
- The click-time `emit_moat_event` in `pipeline.py` becomes **redundant**; leave
  it dormant (a #3 footnote may remove it). It is NOT part of "green the emit."

## 3. The closed loop

```
nightly /cron/moat-train
  │
  ├─(#2 per-shop, RAW)  alerts ⋈ alert_feedback ⋈ action_audit ─► reward inputs per (shop, detector)
  │                                                                       │
  ├─(#5 cross-tenant, ANONYMIZED) domain ─► pseudonymized projection ─► moat.event_log
  │        └─► compute_peer_baselines (consent + k≥5) ─► moat.peer_baselines ──┐
  │        └─► extract_incident ─► incident library                            │ (peer PRIOR)
  │                                                                            ▼
  └─(#3 trainer)  seed prior α₀,β₀ from peer baseline ─► update_threshold(prior, reward)
                                                          ─► upsert moat.detection_models
                                                             (threshold_json, posterior_json,
                                                              keyed by shop_id_pseudonym)
                                                                            │
  (#6 consume)  12 detectors call get_threshold ◄───────────────────────────┘
                (falls through to $500 until a model row exists — safe cutover)
```

## 4. THE FULL MOAT EFFECT — acceptance criteria (definition of done)

**Per-shop self-tuning is NOT a moat.** 5,000 isolated tuners create no network
effect. The moat is the **anonymized cross-tenant prior**. The end-state (when
#2–#6 + Phase B are 100% live) MUST satisfy:

1. **Empirical-Bayes prior seeding (the core mechanism).** The trainer (#3) seeds
   each `(shop, detector)` posterior's prior `(α₀, β₀)` from the **peer baseline**
   for that shop's segment — NOT a flat `(1,1)`. Own feedback then shrinks the
   threshold away from peer consensus toward the shop's own reality.
2. **Cold start.** A shop with zero feedback history inherits the anonymized
   cross-tenant consensus threshold on day one — strictly better than the static
   `$500` default. This is the compounding value: every new customer benefits
   from every prior customer's anonymized signal.
3. **Steady state.** Every published threshold is peer-informed; as N shops grow,
   peer baselines sharpen and all thresholds improve.

**Anonymization invariants (HARD — must hold end-to-end; verified at integration):**

| # | Invariant |
|---|---|
| A1 | Cross-tenant aggregation reads only pseudonymized ids (`pseudonym_for(shop_id, pepper)`), never raw `shop_id`. |
| A2 | Only consenting shops (`shops.peer_data_consent = true`) contribute to ANY peer aggregate or to `moat.event_log`. |
| A3 | k≥5 distinct-contributor floor per `(segment, detector)` before a baseline is published; suppress otherwise (`MIN_CONTRIBUTORS`). |
| A4 | `moat.detection_models` is keyed by `shop_id_pseudonym`; the stored model never carries raw shop identity. |
| A5 | Per-shop training MAY use the shop's own raw data (it is theirs). Only the CROSS-tenant prior must be anonymized + consented + k-floored. |

A slice that cannot satisfy a relevant invariant STOPS and reports it.

## 5. Fixed shared contract (existing code — do not redefine)

**Kernels — `engine/calderyn_engine/moat/`:**
- `compute_reward(feedback_kind: str, dollar_impact: Decimal|int|float, days_to_confirm: int) -> Decimal` (`rewards.py:41`).
  `feedback_kind ∈ {'confirmed_loss','false_positive','already_handled'}`;
  confirmed_loss → `+impact` (clamped ≥0); false_positive → `FALSE_POSITIVE_PENALTY`;
  else → 0. `days_to_confirm` reserved (unused in v1).
- `update_threshold(prior_posterior: Mapping{'alpha','beta',...}, reward, learning_rate=0.1) -> dict{'alpha','beta',...}` (`threshold_updater.py:35`).
  Beta-posterior nudge; passes extra keys through; zero reward = no-op.
- `compute_peer_baselines(...)` (`peer_baselines.py:42`) — aggregates `moat.event_log`
  `detection_fired` rows for consenting shops; k≥5; per `(segment, detector_id)`.
  **Open contract item for #5:** read this file and pin the exact `segment` key.
- `extract_incident(...)` (`incident_extractor.py:80`) — incident library entry on confirmed loss.
- `pseudonym_for(shop_id, pepper) -> str` (`moat/pseudonym.py`) — HMAC-SHA256, irreversible.
- `emit_moat_event(...)` (`emitter.py:39`) — writes `moat.event_log`; consent-gated;
  `ALWAYS_EMIT_KINDS = {detection_fired, threshold_update}`. Reusable by #5's projection.

**Consume — `engine/calderyn_engine/thresholds.py`:**
- `get_threshold(conn, shop_id, detector_id, *, pepper=None) -> Decimal` (`:68`).
  Lookup: `moat.detection_models` (by detector_id, pseudonym) → `alert_thresholds`
  (by shop_id, detector_id) → `_DETECTOR_THRESHOLDS` default → `0`. Falls through
  safely on missing pepper/schema/row ⇒ **#6 is a zero-behavior-change cutover**
  until #1+#3 land.
- `_DETECTOR_THRESHOLDS` (`:52`) — the 12 detectors + canonical key + `$500` default.

**The 12 detectors** (`engine/calderyn_engine/detectors/`): `sku_stockout_vs_spend`,
`campaign_below_breakeven`, `regional_spend_starved_stock`, `scaling_sku_fulfillment_risk`,
`return_rate_hidden_loss`, `margin_erosion`, `cogs_drift`, `ad_tax_overload`,
`negative_unit_economics`, `reorder_timing`, `wrong_location_concentration`,
`regional_shortage_risk`.

**Tables (prod schema live):**
- `public.alerts(id, shop_id, detector_id, entity_ref jsonb, status, severity, dollar_impact numeric, day_bucket, first_seen_at, last_seen_at, resolved_at, snoozed_until, …)`.
- `public.alert_feedback(id, alert_id, shop_id, kind ENUM, note, created_by, created_at)`.
  **Open contract item for #2:** read the `kind` enum definition and pin the
  `kind → {confirmed_loss,false_positive,already_handled}` mapping.
- `public.action_audit(id, shop_id, alert_id, action_kind ENUM, outcome ENUM, undo_of uuid, dollar_impact_at_exec numeric, created_at, completed_at, …)`.
- `public.alert_thresholds(shop_id, detector_id, threshold_json jsonb, …)`.
- `moat.event_log(id, pseudonym_id, event_kind, detector_id, payload jsonb, ingested_at)`.
- `moat.detection_models(detector_id, shop_id_pseudonym, threshold_json jsonb, posterior_json jsonb, updated_at)` — PK `(detector_id, shop_id_pseudonym)`; `threshold_json` = `{canonical_key: number}`; `posterior_json` = `{alpha, beta, …}`.
- `moat.peer_baselines(...)`, `moat_keys.shop_pseudonym(shop_id, pseudonym_id)`, `shops.peer_data_consent bool`.

**Cron convention:** follow the existing `/cron/detect` route — `CRON_SECRET`
auth header, engine invocation pattern, `vercel.json` `crons` array. (Note prod
history: detector route had to move OFF the Python fn URL — commit `551dabf`;
#4 must respect that.)

## 6. The five slices

Each slice = **one parallel agent** → produces **one spec** + **one plan**.
Files (disjoint — no write conflicts):
- spec: `docs/superpowers/specs/2026-06-16-moat-<slice>-spec.md`
- plan: `docs/superpowers/plans/2026-06-16-moat-<slice>-plan.md`

| Slice | `<slice>` | Owns | Consumes (seam) | Produces (seam) |
|---|---|---|---|---|
| **#2** | `reward-derivation` | `alerts ⋈ alert_feedback ⋈ action_audit` → per-`(shop,detector)` reward inputs; pin `alert_feedback.kind` mapping | domain tables | reward-input rows for #3 |
| **#3** | `threshold-trainer` | group rewards → seed prior from peer baseline (§4.1) → `update_threshold` → upsert `detection_models`; idempotent | #2 reward inputs **+ #5 peer_baselines (as prior)** | `moat.detection_models` rows |
| **#4** | `train-cron` | `/cron/moat-train` route + `vercel.json` entry; nightly; `CRON_SECRET`; locking/idempotency | invokes #3 orchestrator | scheduled trainer run |
| **#5** | `peer-incident-etl` | pseudonymized projection (domain → `event_log`, consent+k≥5) → `compute_peer_baselines`; `extract_incident` | domain tables + consent flag | `moat.peer_baselines` (prior for #3) + incidents |
| **#6** | `detector-consume` | thread `get_threshold` into all 12 detectors; safe cutover | `moat.detection_models` via `get_threshold` | peer-informed live thresholds |

**Dependency note (implementation order, NOT spec order):** #2,#5 → #3 → #4; #6 independent (safe no-op until #3 writes). Specs are written in parallel because every seam interface above already exists as code.

## 7. Phase B — "green the emit stage in prod" (AFTER planning)

Under Fork A this means: get the nightly **derive→train→write** running in prod so
`moat.detection_models` fills with real (fractional) posteriors AND the
pseudonymized projection accumulates `moat.event_log` for the moat. Concretely:
1. Confirm/set `MOAT_PEPPER` in prod env (Vercel).
2. Confirm the `app_pseudonymizer` role + grant on `moat_keys.shop_pseudonym`
   (emitter.py:119 says Task 22 landed; `__init__.py` still says "Phase C" — reconcile).
3. Run `/cron/moat-train` once; verify `detection_models` gets fractional posteriors
   and `peer_baselines` respects k≥5; verify `get_threshold` returns peer-informed
   values for a consenting shop.

## 8. Non-goals (YAGNI)

- No TS-side click-time emitter; no dashboard-parity work for the producer.
- No recency decay in `compute_reward` (signature reserves `days_to_confirm`; v1 ignores).
- No new detector logic; #6 only swaps the threshold source.
- No schema migrations for NEW moat tables (all exist); #4 may add the
  `supabase/migrations/` entries that codify the already-deployed moat schema if needed.

---

## 9. Cross-slice reconciliation (post-fan-out — AUTHORITATIVE; overrides any slice doc where they differ)

**Verified facts (prod `ajgrmnvzxfxxlwrxcgnu`, 2026-06-16):**
- `alerts.dollar_impact` is **whole USD** (185 alerts, $6.25–$13.66M). ⇒ reward `dollar_impact`, peer `p*`, and `threshold_json` are ALL dollars — **no cents conversion at any seam** (resolves #3 OQ-1).
- The four detectors `return_rate_hidden_loss`, `reorder_timing`, `wrong_location_concentration`, `regional_shortage_risk` truly gate at `Decimal("200")`, but `_DETECTOR_THRESHOLDS` hardcodes `$500` for all 12 — a **latent bug** (confirms #6 Q1).

**Decisions:**
1. **Shared segment resolver.** Create `engine/calderyn_engine/moat/segments.py` → `segment_for(conn, shop_id) -> "gmv:<band>"` (bands: micro/small/mid/large/xl from trailing-90d `order_fact.total_cents`). **#5 owns/creates it; #3 imports it.** Both baseline-write (#5) and prior-seed (#3) MUST use this one function or the prior won't match the baseline. (Resolves #3 OQ-2 + #5 segment.)
2. **Per-segment baselines = additive function.** The fixed `compute_peer_baselines` groups by **detector only** and treats `segment` as an opaque write-label — §5's "per (segment, detector)" phrasing was inaccurate. Accept #5's additive `compute_peer_baselines_by_segment` (reuses the kernel SQL + k≥5 + upsert, adds `payload->>'segment'=$segment`). Original kernel untouched (still used by `consent_purge`).
3. **Trainer entrypoint + cohort.** #3 owns a Python HTTP entrypoint `POST /api/engine/moat-train` (Bearer `CRON_SECRET`, body `{}`) that **enumerates the cohort itself**: trains every fed-back shop from its rewards AND seeds every *consenting* shop with no feedback from the peer baseline (the §4.2 cold-start guarantee). Returns `{shops_trained, models_written, skipped, errors[]}`. #4's cron calls it and surfaces non-empty `errors[]` as non-200. (Resolves #3 OQ-3 + #4 OQ-1.)
4. **Registry fix.** #6 corrects `_DETECTOR_THRESHOLDS` `$500 → $200` for the 4 detectors above (one line each), with a test that each detector's `get_threshold` fallback equals its historical default. (Resolves #6 Q1.)
5. **Scope = 10 detectors, not 12.** Only 10 have a dollar gate. `ad_tax_overload` + `scaling_sku_fulfillment_risk` gate on ratios/days — left byte-for-byte unchanged (a dollar floor would be new detector logic = non-goal). (Resolves #6 Q2.)
6. **GDPR follow-up is a Phase-B BLOCKER.** `consent_purge.py` re-runs the detector-only kernel; with per-segment baselines a withdrawn shop could linger in a band baseline. **#5 must extend `consent_purge` to re-aggregate per-segment** before Phase B ships — not optional (invariant A2). (Resolves #5 conflict 3.)
7. **#4 lock.** No-op single-flight stub for v1 (the `detection_models` PK upsert is concurrency-safe); real run-row lock deferred (documented `TODO(moat OQ-3)`). Accept.
8. **#5 emit caveat.** `detection_fired ∈ ALWAYS_EMIT_KINDS`, so the emitter does NOT consent-gate it; #5 applies the consent filter in the projection SQL and uses an inline INSERT if `PAYLOAD_MODELS['detection_fired']` forbids the extra `segment`/`day_bucket` keys. Accept.

## 10. Prod data reality — what "100% moat effect" actually requires

The code will be correct and **dormant**. As of 2026-06-16 the loop produces nothing because the DATA isn't there:
- **0 `alert_feedback` rows** → no reward signal → per-shop posteriors never move off their prior.
- **0 consenting shops** (of 6) → **no peer baselines** (k≥5 impossible) → **no cross-tenant prior → no moat effect**.
- **6 shops total** → even at 100% consent, reaching k≥5 in one GMV band is unlikely until the base grows.

"100% moat" is gated on **go-to-market, not merge**: (1) merchants grant `peer_data_consent`; (2) ≥5 consenting shops share a GMV band; (3) merchants leave alert feedback. This is by design — the consent gate, k≥5 floor, and fall-through-to-default keep the system safe and silent until real anonymized data accrues. **Phase B ("green the emit stage") can prove the pipeline runs end-to-end (per-shop self-tuning + projection + k-floor enforced); the peer moat stays correctly dormant until the cohort exists.**
