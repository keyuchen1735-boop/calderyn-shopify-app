# Moat Threshold Trainer — Spec (Slice #3)

> **Status:** Draft for implementation. Builds against the FIXED shared contract in
> `docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md` (the "umbrella").
> This slice MUST NOT contradict the umbrella; where it needs a shared interface to
> change, it is raised here as an **Open Question** back to the orchestrator — it does
> not unilaterally diverge.

**Date:** 2026-06-16
**Slice:** #3 — `threshold-trainer`
**Owner:** parallel agent (this session)
**Depends on (seam):** #2 `reward-derivation` (reward inputs) **+** #5 `peer-incident-etl`
(`moat.peer_baselines` as the empirical-Bayes prior). Consumed by #4 `train-cron`
(invokes this orchestrator) and #6 `detector-consume` (reads the rows we write via
`get_threshold`).

---

## 1. What this slice owns

The nightly **threshold trainer**: a pure-Python orchestrator that, for every
`(shop, detector)` with reward signal, turns

1. the shop's own per-`(shop, detector)` **reward inputs** (from #2), and
2. the **anonymized peer baseline** for that shop's segment (from #5),

into one upserted `moat.detection_models` row carrying the trained Beta `posterior_json`
and the rescaled `threshold_json` that the 12 detectors read at detect time.

**This slice IS the moat mechanism.** Per umbrella §4.1, the posterior's prior
`(α₀, β₀)` is seeded from the **peer baseline**, NOT from a flat `(1, 1)`. A cold-start
shop (zero own feedback) inherits the anonymized peer consensus threshold (umbrella §4.2).
The shop's own feedback then shrinks the published threshold away from peer consensus
toward the shop's own reality.

**Out of scope (other slices):**
- Deriving the reward-input rows from domain tables (`alerts ⋈ alert_feedback ⋈
  action_audit`) — that is #2.
- Computing `moat.peer_baselines` and the pseudonymized projection — that is #5.
- The `/cron/moat-train` HTTP route, `vercel.json` `crons` entry, locking, `CRON_SECRET`
  — that is #4. This slice exposes a single async entrypoint #4 calls.
- Threading `get_threshold` into detectors — that is #6.
- New SQL migrations for moat tables — they already exist (umbrella §8). We add **no**
  migration.

---

## 2. Fixed contract we consume (verbatim from existing code)

### 2.1 `update_threshold` (the math kernel — DO NOT redefine)
`engine/calderyn_engine/moat/threshold_updater.py`:

```python
def update_threshold(
    prior_posterior: Mapping[str, float],   # must contain "alpha","beta"; extra keys pass through
    reward: Decimal | float | int,          # from compute_reward
    learning_rate: float = 0.1,
) -> dict[str, float]:                       # {"alpha","beta", ...pass-through}
```

Behaviour we rely on (read from source, not assumed):
- `reward > 0` → `alpha += learning_rate * reward`; `beta` unchanged.
- `reward < 0` → `beta += learning_rate * |reward|`; `alpha` unchanged.
- `reward == 0` → **returns a copy of the prior unchanged** (idempotent no-op).
- Defensive copy: the input dict is never mutated.
- Floors `alpha`/`beta` at `1e-6`.
- **Extra keys pass through untouched** — we use this to park `{"n_events", "n_peers",
  "seeded_from", "last_reward"}` metadata in the same blob.

### 2.2 `compute_reward` (the reward scalar — DO NOT redefine)
`engine/calderyn_engine/moat/rewards.py`:

```python
def compute_reward(feedback_kind: str, dollar_impact, days_to_confirm: int) -> Decimal
```

- `"confirmed_loss"` → `+dollar_impact` (clamped ≥ 0).
- `"false_positive"` → `FALSE_POSITIVE_PENALTY` = `Decimal("-10")` (flat).
- `"already_handled"` / unknown → `Decimal("0")`.
- `days_to_confirm` reserved; unused in v1.

The trainer **does not re-implement reward semantics** — it calls `compute_reward` once
per reward-input row.

### 2.3 `moat.peer_baselines` output shape (our PRIOR source — #5 produces it)
`engine/calderyn_engine/moat/peer_baselines.py` + DDL
`tests/engine/schema/migrations/20260501000033_peer_baselines.sql`:

```sql
moat.peer_baselines (
  detector_id text, segment text,
  p25 numeric(18,6), p50 numeric(18,6), p75 numeric(18,6),
  n integer,                       -- distinct consenting contributors, k≥5 enforced at write
  computed_at timestamptz,
  primary key (detector_id, segment)
)
```

`p25/p50/p75` are the **dollar-impact quartiles** of `detection_fired` events across
consenting peers in that segment (`compute_peer_baselines` aggregates
`payload->>'dollar_impact'`). `n` is the contributor count; a row only exists when `n ≥
K_FLOOR (=5)` — invariant A3 is enforced upstream, so **any row we read is already
k-safe**. We never compute baselines and never read `moat.event_log` — we read only the
finished `moat.peer_baselines` row.

### 2.4 `pseudonym_for` (keying — invariant A4)
`engine/calderyn_engine/moat/pseudonym.py`:

```python
def pseudonym_for(shop_id: str, pepper: str) -> str   # "p_" + hex(HMAC_SHA256(pepper, shop_id))[:32]
```

`moat.detection_models` is keyed by `shop_id_pseudonym`. We compute the pseudonym from
the raw `shop_id` + active pepper **at the moment of upsert** and write only the
pseudonym — never the raw `shop_id` — into the moat schema (invariant A4).

### 2.5 `get_threshold` + `_DETECTOR_THRESHOLDS` (our SEAM-OUT — #6 reads it)
`engine/calderyn_engine/thresholds.py`:

```python
_DETECTOR_THRESHOLDS: dict[str, tuple[str, Decimal]] = {
    "sku_stockout_vs_spend":        ("min_spend_usd",  Decimal("500")),
    "campaign_below_breakeven":     ("min_loss_usd",   Decimal("500")),
    "regional_spend_starved_stock": ("min_spend_usd",  Decimal("500")),
    "scaling_sku_fulfillment_risk": ("min_impact_usd", Decimal("500")),
    "return_rate_hidden_loss":      ("min_impact_usd", Decimal("500")),
    "margin_erosion":               ("min_impact_usd", Decimal("500")),
    "cogs_drift":                   ("min_impact_usd", Decimal("500")),
    "ad_tax_overload":              ("min_impact_usd", Decimal("500")),
    "negative_unit_economics":      ("min_impact_usd", Decimal("500")),
    "reorder_timing":               ("min_impact_usd", Decimal("500")),
    "wrong_location_concentration": ("min_impact_usd", Decimal("500")),
    "regional_shortage_risk":       ("min_impact_usd", Decimal("500")),
}
```

`get_threshold` reads `moat.detection_models.threshold_json` first, then extracts the
**per-detector canonical key** (`canonical_key`). Therefore our `threshold_json` MUST be
the shape `{canonical_key: number}` for *that detector's* key. The trainer reads
`_DETECTOR_THRESHOLDS` to learn each detector's canonical key — it does not hardcode a
second copy.

### 2.6 `moat.detection_models` DDL (where we write — invariant A4)
`tests/engine/schema/migrations/20260501000032_moat_detection_models.sql`:

```sql
moat.detection_models (
  detector_id text not null,
  shop_id_pseudonym text not null,
  threshold_json jsonb not null,     -- {canonical_key: number}  (engine reads)
  posterior_json jsonb not null,     -- {alpha, beta, ...}        (trainer state, opaque to engine)
  updated_at timestamptz not null default now(),
  primary key (detector_id, shop_id_pseudonym)
)
```

PK is `(detector_id, shop_id_pseudonym)` ⇒ our upsert is one `INSERT … ON CONFLICT
(detector_id, shop_id_pseudonym) DO UPDATE`, idempotent on re-run.

---

## 3. SEAM-IN contracts (what we assume from #2 and #5)

### 3.1 From #2 — reward-input row shape
The umbrella (§6 table, row #3) pins the consumed shape as
`(shop_id, detector_id, feedback_kind, dollar_impact, days_to_confirm, alert_id)`. This
slice assumes #2 yields an **async iterable / list of rows** with exactly these fields:

```python
class RewardInput(TypedDict):
    shop_id: str            # public.shops.id (uuid as str) — raw; OWN data, allowed (invariant A5)
    detector_id: str        # one of the 12 detector ids
    feedback_kind: str      # already mapped to {"confirmed_loss","false_positive","already_handled"}
    dollar_impact: Decimal  # detector dollar impact at alert time (USD)
    days_to_confirm: int    # days alert→confirmation; passed straight to compute_reward (unused v1)
    alert_id: str           # provenance only; not used in the fold math
```

**Key assumption:** #2 has already mapped `alert_feedback.kind` (the prod enum) to the
three `compute_reward` kinds (that mapping is #2's open contract item per umbrella §5).
The trainer treats `feedback_kind` as already-canonical and passes it straight to
`compute_reward`; an unrecognized kind degrades to reward `0` (no-op) exactly as
`compute_reward` already specifies — we do **not** raise.

The trainer is **agnostic to how #2 delivers the rows** as long as they can be grouped by
`(shop_id, detector_id)`. To keep #3 testable without #2, the trainer accepts an injected
**reward-input provider** callable (see §5.3); the default provider (a thin DB query) is
specified but its exact SQL is #2's responsibility, so the default is a small adapter the
plan stubs against #2's documented row shape.

> **Open Question OQ-1 (to orchestrator):** does #2 emit `dollar_impact` as `Decimal`, or
> as integer cents? `compute_reward` coerces via `Decimal(str(x))` so either works
> numerically, **but** the rescale formula in §4 interprets the value as *whole USD*
> (matching `peer_baselines.p*`, which `compute_peer_baselines` stores from
> `payload->>'dollar_impact'` as whole-dollar numerics). If #2 emits cents, the trainer
> needs a `/100` normalisation at the seam. **Assumed: whole USD**, consistent with the
> peer-baseline units. Flag if #2 diverges.

### 3.2 From #5 — peer-baseline read + segment resolution
We read `moat.peer_baselines` by `(detector_id, segment)`. Two facts the trainer needs
that the umbrella leaves to #5:

1. **The `segment` key for a given shop.** `compute_peer_baselines(conn, detector_id,
   segment)` is "segment-agnostic — the caller decides which shops belong to which
   segment" (peer_baselines.py docstring). The trainer must resolve *this shop's* segment
   to look up its baseline row. The umbrella does not pin a shop→segment function.

   > **Open Question OQ-2 (to orchestrator):** what is the canonical shop→segment
   > resolver, and where does it live? #5 owns segment assignment for the ETL; #3 needs
   > the **same** function so the prior it seeds matches the baseline #5 wrote.
   > **Assumed seam:** #5 (or a shared `moat/segments.py`) exposes
   > `async def segment_for(conn, shop_id: str) -> str`. The trainer takes this as an
   > **injected dependency** (`segment_resolver`) so #3 is testable in isolation and the
   > production wiring (#4) passes #5's resolver. If no resolver exists yet, the trainer
   > falls back to a single global segment `"all"` (still k-safe via #5's k-floor) and
   > logs `segment_resolver_missing` — fail-visible, never silent (rule 12).

2. **Missing baseline row.** If `(detector_id, segment)` has no `moat.peer_baselines` row
   (k-floor not yet met upstream, or a brand-new detector), there is **no peer prior**.
   The trainer falls back to a flat prior `(1.0, 1.0)` and a `threshold_json` equal to the
   detector's static default from `_DETECTOR_THRESHOLDS` — i.e. the current $500 behaviour,
   degrading gracefully to "no worse than today" (umbrella §4.2 cold-start guarantee still
   holds the moment a baseline appears). This path is logged as
   `peer_baseline_absent_flat_prior`.

---

## 4. THE MOAT MECHANISM — peer baseline → `(α₀, β₀)` → `threshold_json`

This is the core deliverable (umbrella §4.1). All constants live in one module-level
block so a reviewer can audit the math in one place.

### 4.1 Definitions
For a `(shop, detector)`:
- Let the detector's canonical key be `K` and static default `D` (from
  `_DETECTOR_THRESHOLDS`).
- Let the peer baseline row for the shop's segment be `(p25, p50, p75, n)` (all whole
  USD; `n ≥ 5` guaranteed by upstream A3). Define the **inter-quartile range**
  `iqr = max(p75 - p25, EPS)` with `EPS = Decimal("1")` to avoid divide-by-zero on a
  degenerate (all-equal) cohort.

### 4.2 Prior seed `(α₀, β₀)` from the peer baseline
The Beta posterior models **"what fraction of the peer dollar band should this detector
fire on?"** Its mean `μ = α/(α+β)` is the *position within the IQR* of the published
threshold; its concentration `s = α+β` is the *prior strength* (how hard own feedback has
to push to move off peer consensus).

- **Mean (where the prior sits):** seed at the median, i.e. `μ₀ = 0.5`. By construction
  (§4.3) `μ = 0.5` maps the published threshold to `p50` — the peer consensus threshold.
  This is the cold-start value (umbrella §4.2): zero own feedback ⇒ posterior stays at
  the seed ⇒ published threshold == `p50`.

- **Strength (peer confidence):** more contributors and a tighter band ⇒ a stronger,
  harder-to-move prior. Define

  ```
  s₀ = BASE_STRENGTH + CONTRIB_WEIGHT * ln(1 + n)
  ```

  with `BASE_STRENGTH = 2.0`, `CONTRIB_WEIGHT = 1.0`. (Log keeps a 500-shop segment from
  producing an immovable prior; with `n=5`, `s₀ ≈ 2.0 + ln(6) ≈ 3.79`; with `n=50`,
  `s₀ ≈ 5.93`.)

- Therefore:

  ```
  α₀ = μ₀ * s₀ = 0.5 * s₀
  β₀ = (1 - μ₀) * s₀ = 0.5 * s₀
  ```

  i.e. a **symmetric** Beta centred on the peer median, with strength rising in `n`.

  > Rationale for symmetry: the peer baseline tells us *where the band is* (p25..p75) but
  > not *which direction* a given shop should deviate — that is precisely the signal the
  > shop's own feedback supplies. Seeding `μ₀ = 0.5` keeps the prior neutral on direction
  > while pinning the magnitude (the band) from peers. This is the empirical-Bayes
  > shrinkage target.

- **Cold-start (no peer baseline row):** `α₀ = β₀ = 1.0` (flat), and the published
  threshold is `D` (the static default), per §3.2.

### 4.3 Posterior → `threshold_json` rescale (the inverse map)
After folding the shop's own rewards through `update_threshold` (§5.2) we have a
posterior `(α, β)` with mean `μ = α / (α + β)`. Map it back into the peer dollar band:

```
threshold_usd = clamp(
    p25 + (1 - μ) * iqr,        # μ high (loosen) → toward p25; μ low (tighten) → toward p75
    lo = THRESH_FLOOR,          # Decimal("0")
    hi = p75 * THRESH_CEIL_MULT # Decimal("3") * p75  — never let a noisy shop push absurdly high
)
```

Sign convention (consistent with `update_threshold` + `compute_reward`):
- **Confirmed-loss** feedback → positive reward → `alpha ↑` → `μ ↑` → `(1-μ) ↓` →
  `threshold_usd ↓` toward `p25`. The alert was *useful*, so we **loosen** (fire on
  smaller dollar impacts) — the shop wants more of these alerts.
- **False-positive** feedback → negative reward → `beta ↑` → `μ ↓` → `(1-μ) ↑` →
  `threshold_usd ↑` toward `p75`. The alert was *noise*, so we **tighten** (only fire on
  bigger impacts) — fewer alerts.
- **No own feedback** → posterior == seed → `μ = 0.5` → `threshold_usd = p25 + 0.5*iqr =
  (p25 + p75)/2`.

> **Cold-start exactness note.** Umbrella §4.2 says a zero-feedback shop "inherits the
> anonymized cross-tenant consensus threshold." We define **consensus threshold ≡ p50**
> (the median dollar impact at which peers' alerts fire). To make the cold-start output
> land *exactly* on `p50` (not the IQR midpoint, which only equals `p50` for symmetric
> distributions), the rescale uses a **piecewise-linear** map anchored on all three
> quartiles:
>
> ```
> if μ >= 0.5:   threshold_usd = p50 - (μ - 0.5) / 0.5 * (p50 - p25)   # μ:0.5→1  maps p50→p25
> else:          threshold_usd = p50 + (0.5 - μ) / 0.5 * (p75 - p50)   # μ:0.5→0  maps p50→p75
> ```
>
> This is the **authoritative rescale** (the single-line IQR form above is the intuition;
> the piecewise form is what ships). At `μ = 0.5` it returns `p50` exactly → cold-start
> equals the peer consensus threshold, satisfying §4.2 as a hard equality the acceptance
> test asserts (§7, `test_cold_start_inherits_peer_consensus`). Both branches are then
> passed through the same `clamp(lo=0, hi=3*p75)`.

### 4.4 Final `threshold_json`
```python
threshold_json = {canonical_key: float(threshold_usd_quantized)}
# quantize to cents: threshold_usd.quantize(Decimal("0.01"))
```
Exactly the `{canonical_key: number}` shape `get_threshold` reads for that detector
(§2.5). `posterior_json` carries `{"alpha","beta","n_events","n_peers","seeded_from",
"last_reward"}` where `seeded_from ∈ {"peer_baseline","flat_default"}` for observability.

### 4.5 Worked example (acceptance-test fixture)
Segment baseline for `sku_stockout_vs_spend`: `p25=200, p50=300, p75=400, n=5`
(matches `test_peer_baselines.test_5_consenting_shops_writes_row_with_quartiles`).
`s₀ = 2.0 + ln(6) ≈ 3.79`; `α₀ = β₀ ≈ 1.896`.

- **Cold-start shop** (no own feedback): `μ = 0.5` → piecewise → `threshold_usd = p50 =
  300.00` → `threshold_json = {"min_spend_usd": 300.0}`. **Strictly better than the
  static $500** and equal to peer consensus. ✅ (umbrella §4.2)
- **Confirmed-loss shop** (one `confirmed_loss`, `dollar_impact=50`, `lr=0.5`):
  reward `= +50`; `update_threshold` → `alpha = 1.896 + 0.5*50 = 26.896`, `beta = 1.896`;
  `μ = 26.896/28.792 ≈ 0.934`; `μ ≥ 0.5` branch →
  `threshold_usd = 300 - (0.934-0.5)/0.5 * (300-200) = 300 - 86.8 = 213.2` →
  `threshold_json ≈ {"min_spend_usd": 213.2}`. **Shifted DOWN, away from the 300
  consensus, toward the shop's own willingness to act.** ✅ (umbrella §4.1)

These two outcomes are the proof-of-moat acceptance test (§7).

---

## 5. The fold (trainer algorithm)

### 5.1 Grouping
Collect reward inputs and group by `(shop_id, detector_id)`. Each group is trained
independently and produces exactly one `moat.detection_models` upsert.

### 5.2 Per-group reduction
```
for (shop_id, detector_id), rows in groups:
    canonical_key, default_usd = _DETECTOR_THRESHOLDS[detector_id]   # KeyError ⇒ skip+log (rule 12)
    segment   = await segment_resolver(conn, shop_id)               # OQ-2; falls back to "all"
    baseline  = await _read_peer_baseline(conn, detector_id, segment)  # (p25,p50,p75,n) | None
    posterior = _seed_prior(baseline)                               # §4.2 → {"alpha","beta",...}
    for r in rows:                                                  # deterministic order (sorted by alert_id)
        reward    = compute_reward(r["feedback_kind"], r["dollar_impact"], r["days_to_confirm"])
        posterior = update_threshold(posterior, reward, learning_rate=LEARNING_RATE)
    threshold_json = _rescale(posterior, baseline, canonical_key, default_usd)   # §4.3/§4.4
    await _upsert_model(conn, detector_id, shop_id, posterior, threshold_json, pepper)
```

- `LEARNING_RATE` is a module constant (default `0.1`, matching the kernel default and
  the acceptance test). The acceptance/proof tests pass `learning_rate=0.5` for fast
  convergence, mirroring `test_moat_acceptance.py`'s "dial up to 0.5" convention.
- **Determinism:** rows are sorted by `alert_id` before folding so a re-run over the same
  input produces byte-identical posteriors (reproducible-from-event-log property the
  kernels were designed for). `update_threshold` addition is commutative in the limit but
  the float order is pinned for exact idempotence.
- **Cold-start group:** a `(shop, detector)` with **zero reward rows** never appears in
  the grouping (nothing to iterate), so the trainer would not write a row for it. That is
  correct: cold-start shops have no `detection_models` row and `get_threshold` falls
  through to `alert_thresholds`/default — **except** we still want the §4.2 guarantee that
  a *consenting* shop benefits from peers on day one. See §5.4.

### 5.3 Entrypoint (#4 seam)
```python
async def train_thresholds(
    conn: asyncpg.Connection,
    *,
    pepper: str,
    reward_provider: RewardProvider,        # async () -> Iterable[RewardInput]  (default wraps #2)
    segment_resolver: SegmentResolver | None = None,  # async (conn, shop_id) -> str (from #5)
    learning_rate: float = LEARNING_RATE,
) -> TrainSummary:                          # {"groups_trained": int, "rows_upserted": int, "skipped": int}
```
- Single async function #4's route calls after `CRON_SECRET` auth. Returns a summary for
  the cron to log. **No `BEGIN/COMMIT` spanning groups** — see §6.
- `RewardProvider` / `SegmentResolver` are injected so #3 is unit-testable without #2/#5.

### 5.4 Cold-start seeding pass (the §4.2 guarantee)
A shop with **zero own feedback** still must inherit peer consensus on day one. Because
§5.2 only iterates `(shop, detector)` pairs that *have* reward rows, a pure
reward-driven loop would skip brand-new consenting shops. To honour umbrella §4.2 the
trainer runs an explicit **cold-start pass**:

```
for shop_id in consenting_shops_without_feedback(conn):     # peer_data_consent=true AND no reward rows
    for detector_id in _DETECTOR_THRESHOLDS:
        baseline = await _read_peer_baseline(conn, detector_id, segment_resolver(conn, shop_id))
        if baseline is None:
            continue                                        # no peer signal yet → leave to static default
        posterior = _seed_prior(baseline)                   # μ=0.5
        threshold_json = _rescale(posterior, baseline, canonical_key, default_usd)   # == p50
        await _upsert_model(conn, detector_id, shop_id, posterior, threshold_json, pepper)
```

This writes the peer-consensus threshold (`p50`) for every consenting cold-start shop,
making the moat compounding (umbrella §4 criterion 2). The pass is idempotent: a shop that
later gains feedback is picked up by §5.2 instead and its row is overwritten by the
`ON CONFLICT DO UPDATE`.

> **Open Question OQ-3 (to orchestrator):** the "consenting shops" enumeration needs to
> read `public.shops.peer_data_consent` and the set of shops with **no** reward rows.
> Deriving "no reward rows" precisely couples to #2's storage. **Assumed seam:** the
> `reward_provider` also exposes `async def shops_with_feedback() -> set[str]`, and the
> trainer reads consenting shops from `public.shops` directly (own-data read; allowed by
> A5 since we resolve the pseudonym only at write time). If #2 cannot expose
> `shops_with_feedback`, the cold-start pass degrades to "seed every consenting shop"
> (still idempotent; §5.2 overwrites the ones with feedback) — flag if a tighter contract
> is wanted.

---

## 6. Transaction scoping under the pgbouncer TRANSACTION pooler (HARD)

Production `DATABASE_URL` points at Supabase's **transaction pooler (port 6543)**. Under
pgbouncer transaction mode, **each statement may be routed to a different backend** — there
is no session affinity (confirmed: `db.py` creates the pool with
`statement_cache_size=0` precisely for this reason; prior audit flagged
`compute_peer_baselines` and `purge_shop_contributions` as at-risk for exactly this). The
trainer MUST therefore:

1. **Never assume cross-statement session state.** No session GUCs, no `SET`, no temp
   tables, no advisory locks held across statements, no reliance on a statement landing on
   the same backend as the previous one.

2. **Wrap each per-`(shop, detector)` upsert path in its own explicit `conn.transaction()`**
   so the *read-baseline → compute → upsert* of one group is atomic on one backend. The
   block is small and self-contained:

   ```python
   async with conn.transaction():
       baseline = await _read_peer_baseline(conn, detector_id, segment)  # SELECT
       posterior = _seed_prior(baseline)                                 # pure Python
       for r in rows: posterior = update_threshold(posterior, compute_reward(...))  # pure Python
       threshold_json = _rescale(...)                                    # pure Python
       await _upsert_model(...)                                          # INSERT ... ON CONFLICT
   ```

   Because the only DB statements inside are one `SELECT` and one `INSERT … ON CONFLICT`,
   and the rescale/seed/fold are pure in-memory Python, the transaction is short and the
   baseline read is consistent with the write within the same backend snapshot.

3. **Do NOT open a single mega-transaction across all groups.** That would hold one
   backend for the whole nightly run and defeat the pooler. Each group is its own tiny
   transaction; a failure in one group rolls back only that group and is logged
   (`group_train_failed`, with `shop_id` + `detector_id`) — never silently swallowed
   (rule 12). The orchestrator continues to the next group and reflects the failure in
   `TrainSummary.skipped`.

4. **The single `SELECT` baseline read inside the transaction is sufficient** — we do not
   re-read or do read-decide-write across statement boundaries the way the flagged
   functions did, so the known at-risk pattern does not recur. The upsert itself is a
   single atomic statement (`INSERT … ON CONFLICT DO UPDATE`), correct under the pooler
   regardless.

5. **Idempotent re-runs:** the `ON CONFLICT (detector_id, shop_id_pseudonym) DO UPDATE`
   makes a second identical run overwrite with identical values (posteriors are
   deterministic given identical inputs, §5.2). Re-running the cron is safe.

---

## 7. Acceptance criteria (definition of done for #3)

1. **Pure-fold convergence (mirrors umbrella acceptance #3 / `test_moat_acceptance`):**
   feeding 50 synthetic rewards (4:1 confirmed:false) through the trainer's fold yields a
   posterior with `alpha > beta`. (Re-uses the kernel; proves the trainer wires it right.)

2. **THE MOAT PROOF — cold-start inherits peer consensus:** given a `moat.peer_baselines`
   row `(p25=200, p50=300, p75=400, n=5)` and a shop with **zero own feedback**, the
   trained `threshold_json[canonical_key]` equals **`300.0`** (== `p50`), and the written
   `posterior_json.seeded_from == "peer_baseline"`. Strictly less than the static `500`.
   (umbrella §4.2)

3. **THE MOAT PROOF — own confirmed-loss shifts away from consensus:** same baseline, but
   the shop has one `confirmed_loss` reward (`dollar_impact=50`, `lr=0.5`); the trained
   `threshold_json[canonical_key]` is **strictly less than `300.0`** (loosened, toward
   `p25`), and `posterior_json.alpha > posterior_json.beta`. (umbrella §4.1) The
   *difference* between this and the cold-start value is the moat effect made observable.

4. **Symmetric proof — false-positive tightens:** same baseline, one `false_positive`
   reward; trained `threshold_json[canonical_key]` is **strictly greater than `300.0`**
   (tightened, toward `p75`), and `posterior_json.beta > posterior_json.alpha`.

5. **No peer baseline ⇒ flat prior + static default:** a `(shop, detector)` whose segment
   has no `moat.peer_baselines` row produces `posterior_json.seeded_from ==
   "flat_default"`, `alpha`/`beta` seeded from `(1,1)` then nudged, and a `threshold_json`
   that, with zero feedback, equals the detector's static default (`500.0`).

6. **Invariant A4 — no raw shop_id in moat:** after a training run, every row in
   `moat.detection_models` is keyed by a `p_…` pseudonym; the trainer wrote no raw
   `shop_id` into any `moat.*` table. (Assert via `information_schema` + the row key
   matching `pseudonym_for(shop_id, pepper)`.)

7. **Idempotent re-run:** running `train_thresholds` twice over identical inputs leaves
   `moat.detection_models` byte-identical (same `threshold_json`, same `posterior_json`
   modulo `updated_at`).

8. **Pooler safety (review-gated, not a unit test):** no session-state assumptions; each
   group wrapped in its own `conn.transaction()`; no mega-transaction. Verified by code
   review against §6.

---

## 8. File plan (for the implementation plan)

- **Create** `engine/calderyn_engine/moat/threshold_trainer.py` — the orchestrator:
  `train_thresholds`, `_seed_prior`, `_rescale`, `_read_peer_baseline`, `_upsert_model`,
  the `RewardInput`/`RewardProvider`/`SegmentResolver` types, and the constants block
  (`LEARNING_RATE`, `BASE_STRENGTH`, `CONTRIB_WEIGHT`, `EPS`, `THRESH_CEIL_MULT`,
  `THRESH_FLOOR`). Reuses `update_threshold`, `compute_reward`, `pseudonym_for`,
  `_DETECTOR_THRESHOLDS`. **No new migration; no edits to existing modules.**
- **Create** `tests/engine/moat/test_threshold_trainer.py` — pure-Python unit tests for
  `_seed_prior` / `_rescale` and the fold (no DB), incl. acceptance criteria 1–5.
- **Create** `tests/engine/integration/test_threshold_trainer_db.py` — DB-backed tests
  (`pg_pool` fixture, skips without `TEST_DATABASE_URL`) for the upsert, A4 keying,
  idempotent re-run, and the end-to-end cold-start-vs-feedback moat proof (criteria 2–4,
  6, 7) against `moat.peer_baselines` + `moat.detection_models`.

No other slice's files are touched.

---

## 9. Open questions (consolidated, for the orchestrator)

- **OQ-1 — reward `dollar_impact` units (cents vs USD).** Assumed whole USD to match
  `peer_baselines.p*`. If #2 emits cents, add `/100` at the seam.
- **OQ-2 — shop→segment resolver.** Assumed injected `segment_for(conn, shop_id)` shared
  with #5; falls back to `"all"` + warn if absent. #3 and #5 MUST use the *same* resolver
  or the seeded prior won't match the written baseline.
- **OQ-3 — "consenting shops without feedback" enumeration** for the cold-start pass.
  Assumed `reward_provider.shops_with_feedback()` + a direct `public.shops` read; degrades
  to "seed every consenting shop" (idempotent) if unavailable.
- **No contradictions with the umbrella** were found. The only *additions* beyond the
  umbrella's prose are (a) the precise `(α₀,β₀)` formula and (b) the piecewise rescale that
  pins cold-start to `p50` — both are realisations of umbrella §4.1/§4.2, not departures.
