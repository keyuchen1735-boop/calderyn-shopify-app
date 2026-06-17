# Moat Threshold Trainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the nightly threshold trainer (slice #3) that seeds each `(shop, detector)` Beta posterior's prior from the anonymized peer baseline (empirical-Bayes), folds in the shop's own reward signal via `update_threshold`, rescales to `threshold_json`, and upserts `moat.detection_models` — idempotently and pgbouncer-safe.

**Architecture:** One new pure-orchestrator module `engine/calderyn_engine/moat/threshold_trainer.py`. It reuses the existing math kernels (`update_threshold`, `compute_reward`), the pseudonym deriver, and the `_DETECTOR_THRESHOLDS` registry — adding no migration and editing no existing file. The moat mechanism is two pure functions (`_seed_prior`, `_rescale`) plus a fold; the only DB statements are a single baseline `SELECT` and a single `INSERT … ON CONFLICT`, each wrapped in a small per-group `conn.transaction()` so the transaction pooler never splits a read-then-write invariant across backends.

**Tech Stack:** Python 3.11+, asyncpg, `Decimal` math, `structlog`, pytest + pytest-asyncio. DB-backed tests use the repo's `pg_pool` fixture (skips unless `TEST_DATABASE_URL` is a local DB).

## Global Constraints

- **No source edits outside the new files.** Reuse `update_threshold`, `compute_reward`, `pseudonym_for`, `_DETECTOR_THRESHOLDS` by import; do not redefine reward/posterior math.
- **No new SQL migration.** `moat.detection_models` and `moat.peer_baselines` already exist (umbrella §8).
- **Keying (invariant A4):** `moat.detection_models` is keyed by `shop_id_pseudonym = pseudonym_for(shop_id, pepper)`; never write a raw `shop_id` into any `moat.*` table.
- **Anonymization (A5):** the shop's OWN reward data may use raw `shop_id`; only the cross-tenant prior (`moat.peer_baselines`) is anonymized — and it is already k≥5 floored upstream (A3), so any baseline row read is k-safe.
- **`threshold_json` shape:** `{canonical_key: number}` for the detector's own canonical key from `_DETECTOR_THRESHOLDS` — exactly what `thresholds.get_threshold` reads.
- **pgbouncer TRANSACTION pooler (port 6543):** no cross-statement session state; wrap each group's read+upsert in its own `conn.transaction()`; never one mega-transaction. (`db.py` already uses `statement_cache_size=0`.)
- **Fail visibly (rule 12):** a per-group failure is logged with `shop_id`+`detector_id` and counted in `TrainSummary.skipped`; never silently swallowed; never report success when a group was skipped.
- **Determinism:** sort reward rows by `alert_id` before folding so re-runs are byte-identical.
- **Constants (verbatim from spec §4):** `LEARNING_RATE=0.1`, `BASE_STRENGTH=2.0`, `CONTRIB_WEIGHT=1.0`, `EPS=Decimal("1")`, `THRESH_FLOOR=Decimal("0")`, `THRESH_CEIL_MULT=Decimal("3")`.

---

## File Structure

- `engine/calderyn_engine/moat/threshold_trainer.py` — **Create.** The trainer: types (`RewardInput`, `RewardProvider`, `SegmentResolver`, `TrainSummary`), constants, the moat math (`_seed_prior`, `_rescale`), DB helpers (`_read_peer_baseline`, `_upsert_model`), and the entrypoint `train_thresholds` + cold-start pass.
- `tests/engine/moat/test_threshold_trainer.py` — **Create.** Pure-Python (no DB) tests of `_seed_prior`, `_rescale`, and the fold — covers spec acceptance 1–5.
- `tests/engine/integration/test_threshold_trainer_db.py` — **Create.** DB-backed tests (`pg_pool`) for the upsert, A4 keying, idempotent re-run, and the end-to-end cold-start-vs-feedback moat proof — covers spec acceptance 2–4, 6, 7.

Each test file imports only from `calderyn_engine.moat.threshold_trainer` and the existing kernels — no other slice's code.

---

### Task 1: Constants, types, and the prior seed (`_seed_prior`)

**Files:**
- Create: `engine/calderyn_engine/moat/threshold_trainer.py`
- Test: `tests/engine/moat/test_threshold_trainer.py`

**Interfaces:**
- Consumes: nothing (first task). Reads `peer_baselines` row shape `(p25, p50, p75, n)` from spec §2.3.
- Produces:
  - `PeerBaseline = TypedDict("PeerBaseline", {"p25": Decimal, "p50": Decimal, "p75": Decimal, "n": int})`
  - `def _seed_prior(baseline: PeerBaseline | None) -> dict[str, float]` — returns `{"alpha","beta","n_peers","seeded_from"}`. Peer baseline → symmetric Beta centred on the median with strength `s₀ = 2.0 + ln(1+n)`; `None` → flat `{"alpha":1.0,"beta":1.0,"n_peers":0,"seeded_from":"flat_default"}`.
  - Constants `LEARNING_RATE`, `BASE_STRENGTH`, `CONTRIB_WEIGHT`, `EPS`, `THRESH_FLOOR`, `THRESH_CEIL_MULT`.

- [ ] **Step 1: Write the failing test**

```python
# tests/engine/moat/test_threshold_trainer.py
"""Slice #3 — pure-Python unit coverage of the moat threshold trainer.

No DB: exercises the empirical-Bayes seed and the posterior->threshold
rescale directly. DB-backed coverage lives in
tests/engine/integration/test_threshold_trainer_db.py.
"""

from __future__ import annotations

import math
from decimal import Decimal

from calderyn_engine.moat.threshold_trainer import (
    BASE_STRENGTH,
    CONTRIB_WEIGHT,
    _seed_prior,
)


def _baseline(p25, p50, p75, n):
    return {
        "p25": Decimal(str(p25)),
        "p50": Decimal(str(p50)),
        "p75": Decimal(str(p75)),
        "n": n,
    }


def test_seed_prior_is_symmetric_on_the_peer_median() -> None:
    # Symmetric Beta (alpha == beta) => mean 0.5 => sits on the peer median.
    prior = _seed_prior(_baseline(200, 300, 400, 5))
    assert prior["alpha"] == prior["beta"]
    assert prior["seeded_from"] == "peer_baseline"
    assert prior["n_peers"] == 5
    # strength s0 = BASE_STRENGTH + CONTRIB_WEIGHT*ln(1+n); alpha = beta = s0/2.
    expected_s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + 5)
    assert math.isclose(prior["alpha"] + prior["beta"], expected_s0, rel_tol=1e-9)


def test_seed_prior_strength_grows_with_contributor_count() -> None:
    small = _seed_prior(_baseline(200, 300, 400, 5))
    big = _seed_prior(_baseline(200, 300, 400, 200))
    # More peers => stronger (harder-to-move) prior => larger alpha+beta.
    assert (big["alpha"] + big["beta"]) > (small["alpha"] + small["beta"])
    # Still symmetric regardless of n.
    assert big["alpha"] == big["beta"]


def test_seed_prior_none_is_flat_default() -> None:
    prior = _seed_prior(None)
    assert prior["alpha"] == 1.0
    assert prior["beta"] == 1.0
    assert prior["seeded_from"] == "flat_default"
    assert prior["n_peers"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'calderyn_engine.moat.threshold_trainer'` (collection error).

- [ ] **Step 3: Write minimal implementation**

```python
# engine/calderyn_engine/moat/threshold_trainer.py
"""Slice #3 — nightly threshold trainer (empirical-Bayes prior seeding).

Turns per-(shop, detector) reward inputs (slice #2) + anonymized peer
baselines (slice #5) into moat.detection_models rows. THE moat mechanism:
each posterior's prior (alpha0, beta0) is seeded from the peer baseline for
the shop's segment, NOT a flat (1,1); the shop's own compute_reward signal
then shrinks the published threshold away from peer consensus.

See docs/superpowers/specs/2026-06-16-moat-threshold-trainer-spec.md.
Reuses the existing kernels: update_threshold, compute_reward,
pseudonym_for, _DETECTOR_THRESHOLDS. Adds no migration; edits no other
module. pgbouncer TRANSACTION-pooler safe: each group's read+upsert is one
short conn.transaction(); no cross-statement session state.
"""

from __future__ import annotations

import math
from decimal import Decimal
from typing import TypedDict


class PeerBaseline(TypedDict):
    p25: Decimal
    p50: Decimal
    p75: Decimal
    n: int


# --- moat math constants (spec section 4) --------------------------------
LEARNING_RATE: float = 0.1          # matches update_threshold default
BASE_STRENGTH: float = 2.0          # prior pseudo-count floor
CONTRIB_WEIGHT: float = 1.0         # ln(1+n) weight on peer confidence
EPS: Decimal = Decimal("1")         # IQR floor (avoid /0 on degenerate cohort)
THRESH_FLOOR: Decimal = Decimal("0")
THRESH_CEIL_MULT: Decimal = Decimal("3")   # cap published threshold at 3*p75


def _seed_prior(baseline: PeerBaseline | None) -> dict[str, float]:
    """Empirical-Bayes prior (alpha0, beta0) from the peer baseline.

    Symmetric Beta centred on the peer median (mean 0.5) with strength
    rising in the contributor count: s0 = BASE_STRENGTH + CONTRIB_WEIGHT*
    ln(1+n). alpha0 = beta0 = s0/2. None -> flat (1,1) default.
    """
    if baseline is None:
        return {"alpha": 1.0, "beta": 1.0, "n_peers": 0, "seeded_from": "flat_default"}
    n = int(baseline["n"])
    s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + n)
    half = s0 / 2.0
    return {"alpha": half, "beta": half, "n_peers": n, "seeded_from": "peer_baseline"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -v`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/threshold_trainer.py tests/engine/moat/test_threshold_trainer.py
git commit -m "moat/threshold_trainer: empirical-Bayes prior seed (_seed_prior)"
```

---

### Task 2: The posterior → `threshold_json` rescale (`_rescale`)

**Files:**
- Modify: `engine/calderyn_engine/moat/threshold_trainer.py`
- Test: `tests/engine/moat/test_threshold_trainer.py`

**Interfaces:**
- Consumes: `_seed_prior`, `PeerBaseline`, constants (Task 1); `update_threshold` and `compute_reward` from the existing kernels.
- Produces: `def _rescale(posterior: dict, baseline: PeerBaseline | None, canonical_key: str, default_usd: Decimal) -> dict[str, float]` — returns `{canonical_key: float}`. Piecewise-linear map of posterior mean `μ = α/(α+β)` onto the peer quartiles (spec §4.3): `μ=0.5 → p50` exactly; `μ→1 → p25`; `μ→0 → p75`; clamped to `[0, 3*p75]`. `baseline is None` → `{canonical_key: float(default_usd)}`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/engine/moat/test_threshold_trainer.py
from calderyn_engine.moat.threshold_trainer import _rescale
from calderyn_engine.moat.rewards import compute_reward
from calderyn_engine.moat.threshold_updater import update_threshold

KEY = "min_spend_usd"
DEFAULT = Decimal("500")


def test_rescale_cold_start_equals_peer_median() -> None:
    # Zero feedback => posterior == seed (mean 0.5) => threshold == p50.
    base = _baseline(200, 300, 400, 5)
    prior = _seed_prior(base)
    out = _rescale(prior, base, KEY, DEFAULT)
    assert out[KEY] == 300.0


def test_rescale_confirmed_loss_loosens_below_consensus() -> None:
    # Positive reward => alpha up => mean up => threshold drops toward p25.
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    reward = compute_reward("confirmed_loss", Decimal("50"), days_to_confirm=1)
    posterior = update_threshold(posterior, reward, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] < 300.0
    assert out[KEY] >= 200.0  # never past p25 for a single moderate signal
    assert posterior["alpha"] > posterior["beta"]


def test_rescale_false_positive_tightens_above_consensus() -> None:
    # Negative reward => beta up => mean down => threshold rises toward p75.
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    reward = compute_reward("false_positive", Decimal("0"), days_to_confirm=1)
    posterior = update_threshold(posterior, reward, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] > 300.0
    assert posterior["beta"] > posterior["alpha"]


def test_rescale_no_baseline_returns_static_default() -> None:
    out = _rescale(_seed_prior(None), None, KEY, DEFAULT)
    assert out[KEY] == 500.0


def test_rescale_clamps_to_3x_p75_ceiling() -> None:
    # A barrage of false positives must not push the threshold above 3*p75.
    base = _baseline(200, 300, 400, 5)
    posterior = _seed_prior(base)
    for _ in range(200):
        r = compute_reward("false_positive", Decimal("0"), days_to_confirm=1)
        posterior = update_threshold(posterior, r, learning_rate=0.5)
    out = _rescale(posterior, base, KEY, DEFAULT)
    assert out[KEY] <= 1200.0  # 3 * p75 (=400)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -k rescale -v`
Expected: FAIL — `ImportError: cannot import name '_rescale'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to engine/calderyn_engine/moat/threshold_trainer.py
def _rescale(
    posterior: dict[str, float],
    baseline: PeerBaseline | None,
    canonical_key: str,
    default_usd: Decimal,
) -> dict[str, float]:
    """Map the posterior mean back onto the peer dollar band (spec 4.3).

    Piecewise-linear, anchored on all three quartiles so cold-start
    (mean 0.5) lands EXACTLY on p50 (the peer consensus threshold):

        mu >= 0.5:  p50 - (mu-0.5)/0.5 * (p50-p25)     # mu:0.5->1 maps p50->p25 (loosen)
        mu  < 0.5:  p50 + (0.5-mu)/0.5 * (p75-p50)     # mu:0.5->0 maps p50->p75 (tighten)

    No baseline -> static per-detector default. Result clamped to
    [THRESH_FLOOR, THRESH_CEIL_MULT * p75].
    """
    if baseline is None:
        return {canonical_key: float(default_usd)}

    alpha = float(posterior.get("alpha", 1.0))
    beta = float(posterior.get("beta", 1.0))
    mu = alpha / (alpha + beta) if (alpha + beta) > 0 else 0.5

    p25 = baseline["p25"]
    p50 = baseline["p50"]
    p75 = baseline["p75"]
    mu_d = Decimal(str(mu))
    half = Decimal("0.5")

    if mu_d >= half:
        thr = p50 - (mu_d - half) / half * (p50 - p25)
    else:
        thr = p50 + (half - mu_d) / half * (p75 - p50)

    ceil = THRESH_CEIL_MULT * p75
    thr = max(THRESH_FLOOR, min(thr, ceil))
    return {canonical_key: float(thr.quantize(Decimal("0.01")))}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -v`
Expected: PASS — all unit tests pass (8 total).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/threshold_trainer.py tests/engine/moat/test_threshold_trainer.py
git commit -m "moat/threshold_trainer: posterior->threshold rescale (_rescale, piecewise on quartiles)"
```

---

### Task 3: The pure fold over one group (`_fold_group`)

**Files:**
- Modify: `engine/calderyn_engine/moat/threshold_trainer.py`
- Test: `tests/engine/moat/test_threshold_trainer.py`

**Interfaces:**
- Consumes: `_seed_prior`, `_rescale` (Tasks 1–2); `compute_reward`, `update_threshold` kernels.
- Produces:
  - `RewardInput = TypedDict("RewardInput", {"shop_id": str, "detector_id": str, "feedback_kind": str, "dollar_impact": Decimal, "days_to_confirm": int, "alert_id": str})`
  - `def _fold_group(rows: list[RewardInput], baseline: PeerBaseline | None, canonical_key: str, default_usd: Decimal, learning_rate: float) -> tuple[dict, dict]` — returns `(posterior_json, threshold_json)`. Sorts rows by `alert_id`, seeds from baseline, folds each reward, rescales. `posterior_json` carries `{"alpha","beta","n_events","n_peers","seeded_from","last_reward"}`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/engine/moat/test_threshold_trainer.py
from calderyn_engine.moat.threshold_trainer import _fold_group


def _row(shop, det, kind, impact, alert):
    return {
        "shop_id": shop,
        "detector_id": det,
        "feedback_kind": kind,
        "dollar_impact": Decimal(str(impact)),
        "days_to_confirm": 1,
        "alert_id": alert,
    }


def test_fold_converges_on_50_events_alpha_over_beta() -> None:
    # Spec acceptance #1 — mirrors test_moat_acceptance: 4:1 confirmed:fp.
    base = _baseline(200, 300, 400, 5)
    rows = []
    for i in range(50):
        kind = "false_positive" if i % 5 == 0 else "confirmed_loss"
        impact = 0 if kind == "false_positive" else 50
        rows.append(_row("shop-a", "sku_stockout_vs_spend", kind, impact, f"al-{i:03d}"))
    posterior, threshold = _fold_group(rows, base, KEY, DEFAULT, 0.1)
    assert posterior["alpha"] > posterior["beta"]
    assert posterior["n_events"] == 50
    assert posterior["seeded_from"] == "peer_baseline"
    assert KEY in threshold


def test_fold_is_deterministic_regardless_of_row_order() -> None:
    base = _baseline(200, 300, 400, 5)
    rows = [
        _row("s", "sku_stockout_vs_spend", "confirmed_loss", 40, "al-002"),
        _row("s", "sku_stockout_vs_spend", "false_positive", 0, "al-000"),
        _row("s", "sku_stockout_vs_spend", "confirmed_loss", 70, "al-001"),
    ]
    p1, t1 = _fold_group(list(rows), base, KEY, DEFAULT, 0.5)
    p2, t2 = _fold_group(list(reversed(rows)), base, KEY, DEFAULT, 0.5)
    # Sorted by alert_id internally => identical regardless of input order.
    assert p1 == p2
    assert t1 == t2


def test_fold_unknown_kind_is_noop_signal() -> None:
    base = _baseline(200, 300, 400, 5)
    seed = _seed_prior(base)
    rows = [_row("s", "sku_stockout_vs_spend", "totally_unknown_kind", 999, "al-000")]
    posterior, _ = _fold_group(rows, base, KEY, DEFAULT, 0.5)
    # compute_reward returns 0 for unknown kind => update_threshold no-op.
    assert posterior["alpha"] == seed["alpha"]
    assert posterior["beta"] == seed["beta"]
    assert posterior["n_events"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -k fold -v`
Expected: FAIL — `ImportError: cannot import name '_fold_group'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to engine/calderyn_engine/moat/threshold_trainer.py
# (add near the top imports)
from calderyn_engine.moat.rewards import compute_reward
from calderyn_engine.moat.threshold_updater import update_threshold


class RewardInput(TypedDict):
    shop_id: str
    detector_id: str
    feedback_kind: str
    dollar_impact: Decimal
    days_to_confirm: int
    alert_id: str


def _fold_group(
    rows: list[RewardInput],
    baseline: PeerBaseline | None,
    canonical_key: str,
    default_usd: Decimal,
    learning_rate: float,
) -> tuple[dict[str, float], dict[str, float]]:
    """Seed from baseline, fold each reward, rescale to threshold_json.

    Rows are folded in ascending alert_id order so a re-run over the same
    inputs is byte-identical (idempotence). Returns
    (posterior_json, threshold_json).
    """
    posterior = _seed_prior(baseline)
    ordered = sorted(rows, key=lambda r: r["alert_id"])
    last_reward = 0.0
    for r in ordered:
        reward = compute_reward(
            r["feedback_kind"], r["dollar_impact"], r["days_to_confirm"]
        )
        posterior = update_threshold(posterior, reward, learning_rate=learning_rate)
        last_reward = float(reward)
    posterior["n_events"] = len(ordered)
    posterior["last_reward"] = last_reward
    threshold_json = _rescale(posterior, baseline, canonical_key, default_usd)
    return posterior, threshold_json
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -v`
Expected: PASS — all unit tests pass (11 total).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/threshold_trainer.py tests/engine/moat/test_threshold_trainer.py
git commit -m "moat/threshold_trainer: per-group fold (_fold_group, deterministic, reward-driven)"
```

---

### Task 4: DB helpers — read baseline + upsert model (pooler-safe)

**Files:**
- Modify: `engine/calderyn_engine/moat/threshold_trainer.py`
- Test: `tests/engine/integration/test_threshold_trainer_db.py`

**Interfaces:**
- Consumes: `PeerBaseline`, `_fold_group` (Task 3); `pseudonym_for` kernel.
- Produces:
  - `async def _read_peer_baseline(conn, detector_id: str, segment: str) -> PeerBaseline | None` — single `SELECT` from `moat.peer_baselines`.
  - `async def _upsert_model(conn, detector_id: str, shop_id: str, posterior_json: dict, threshold_json: dict, pepper: str) -> None` — derives the pseudonym (A4) and runs one `INSERT … ON CONFLICT (detector_id, shop_id_pseudonym) DO UPDATE`. Casts dicts to jsonb via `json.dumps(...)::jsonb`.

- [ ] **Step 1: Write the failing test**

```python
# tests/engine/integration/test_threshold_trainer_db.py
"""Slice #3 — DB-backed coverage of the moat threshold trainer.

Uses the pg_pool fixture (skips unless TEST_DATABASE_URL is a local DB).
Exercises the real moat.peer_baselines read and the moat.detection_models
upsert, plus the A4 pseudonym keying and idempotent re-run.
"""

from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest

from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_trainer import (
    _read_peer_baseline,
    _upsert_model,
)

PEPPER = "pepper-trainer-db"
DETECTOR = "sku_stockout_vs_spend"
KEY = "min_spend_usd"
SEGMENT = "cat:trainer-db"


async def _seed_baseline(conn, p25, p50, p75, n) -> None:
    await conn.execute(
        "DELETE FROM moat.peer_baselines WHERE detector_id = $1 AND segment = $2",
        DETECTOR,
        SEGMENT,
    )
    await conn.execute(
        "INSERT INTO moat.peer_baselines "
        "(detector_id, segment, p25, p50, p75, n, computed_at) "
        "VALUES ($1,$2,$3,$4,$5,$6, now())",
        DETECTOR,
        SEGMENT,
        Decimal(str(p25)),
        Decimal(str(p50)),
        Decimal(str(p75)),
        n,
    )


@pytest.mark.asyncio
async def test_read_peer_baseline_roundtrips(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _seed_baseline(conn, 200, 300, 400, 5)
        base = await _read_peer_baseline(conn, DETECTOR, SEGMENT)
        assert base is not None
        assert base["p25"] == Decimal("200")
        assert base["p50"] == Decimal("300")
        assert base["p75"] == Decimal("400")
        assert base["n"] == 5


@pytest.mark.asyncio
async def test_read_peer_baseline_missing_returns_none(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM moat.peer_baselines WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            "no-such-segment",
        )
        base = await _read_peer_baseline(conn, DETECTOR, "no-such-segment")
        assert base is None


@pytest.mark.asyncio
async def test_upsert_writes_pseudonym_keyed_row(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        pseudonym = pseudonym_for(shop_id, PEPPER)
        await conn.execute(
            "DELETE FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        await _upsert_model(
            conn,
            DETECTOR,
            shop_id,
            {"alpha": 2.0, "beta": 1.0, "seeded_from": "peer_baseline"},
            {KEY: 213.2},
            PEPPER,
        )
        row = await conn.fetchrow(
            "SELECT shop_id_pseudonym, threshold_json, posterior_json "
            "FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        assert row is not None
        # A4 — keyed by pseudonym, never the raw shop_id.
        assert row["shop_id_pseudonym"] == pseudonym
        assert row["shop_id_pseudonym"].startswith("p_")
        tj = json.loads(row["threshold_json"]) if isinstance(row["threshold_json"], str) else row["threshold_json"]
        assert tj[KEY] == 213.2


@pytest.mark.asyncio
async def test_upsert_is_idempotent_on_conflict(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        pseudonym = pseudonym_for(shop_id, PEPPER)
        await _upsert_model(conn, DETECTOR, shop_id, {"alpha": 2.0, "beta": 1.0}, {KEY: 213.2}, PEPPER)
        await _upsert_model(conn, DETECTOR, shop_id, {"alpha": 9.0, "beta": 1.0}, {KEY: 111.0}, PEPPER)
        rows = await conn.fetch(
            "SELECT threshold_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym,
        )
        # ON CONFLICT DO UPDATE => still exactly one row, carrying the latest values.
        assert len(rows) == 1
        tj = json.loads(rows[0]["threshold_json"]) if isinstance(rows[0]["threshold_json"], str) else rows[0]["threshold_json"]
        assert tj[KEY] == 111.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/integration/test_threshold_trainer_db.py -v`
Expected: FAIL — `ImportError: cannot import name '_read_peer_baseline'` (or, with no local DB, tests SKIP — set `TEST_DATABASE_URL` per `tests/engine/scripts/test-db.sh` to run them).

- [ ] **Step 3: Write minimal implementation**

```python
# append to engine/calderyn_engine/moat/threshold_trainer.py
# (add to imports at the top)
import json
from typing import Any

import asyncpg  # noqa: F401  (type only; conn is asyncpg.Connection)

from calderyn_engine.moat.pseudonym import pseudonym_for


async def _read_peer_baseline(
    conn: Any, detector_id: str, segment: str
) -> PeerBaseline | None:
    """Single SELECT of the (detector_id, segment) baseline. None if absent.

    Any row returned is already k>=5 floored upstream (invariant A3) — the
    trainer never re-checks k here.
    """
    row = await conn.fetchrow(
        "SELECT p25, p50, p75, n FROM moat.peer_baselines "
        "WHERE detector_id = $1 AND segment = $2",
        detector_id,
        segment,
    )
    if row is None:
        return None
    return {
        "p25": Decimal(str(row["p25"])),
        "p50": Decimal(str(row["p50"])),
        "p75": Decimal(str(row["p75"])),
        "n": int(row["n"]),
    }


async def _upsert_model(
    conn: Any,
    detector_id: str,
    shop_id: str,
    posterior_json: dict[str, float],
    threshold_json: dict[str, float],
    pepper: str,
) -> None:
    """Upsert one detection_models row keyed by the shop's pseudonym (A4).

    Single atomic INSERT ... ON CONFLICT DO UPDATE — correct under the
    transaction pooler with no session-state assumptions.
    """
    pseudonym = pseudonym_for(shop_id, pepper)
    await conn.execute(
        """
        INSERT INTO moat.detection_models
          (detector_id, shop_id_pseudonym, threshold_json, posterior_json, updated_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
        ON CONFLICT (detector_id, shop_id_pseudonym) DO UPDATE SET
          threshold_json = EXCLUDED.threshold_json,
          posterior_json = EXCLUDED.posterior_json,
          updated_at     = EXCLUDED.updated_at
        """,
        detector_id,
        pseudonym,
        json.dumps(threshold_json),
        json.dumps(posterior_json),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericchen/Developer/shopify-app && TEST_DATABASE_URL="$(cat tests/engine/.test-db-url 2>/dev/null || echo postgres://postgres:postgres@127.0.0.1:5433/calderyn_test)" python -m pytest tests/engine/integration/test_threshold_trainer_db.py -v`
Expected: PASS — 4 passed (or SKIP if no local DB is provisioned; provision via `tests/engine/scripts/test-db.sh` to get green).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/threshold_trainer.py tests/engine/integration/test_threshold_trainer_db.py
git commit -m "moat/threshold_trainer: DB helpers (_read_peer_baseline, pseudonym-keyed _upsert_model)"
```

---

### Task 5: The orchestrator entrypoint `train_thresholds` (pooler-safe, fail-visible)

**Files:**
- Modify: `engine/calderyn_engine/moat/threshold_trainer.py`
- Test: `tests/engine/integration/test_threshold_trainer_db.py`

**Interfaces:**
- Consumes: `_read_peer_baseline`, `_upsert_model`, `_fold_group`, `RewardInput`, `_DETECTOR_THRESHOLDS`.
- Produces:
  - `TrainSummary = TypedDict("TrainSummary", {"groups_trained": int, "rows_upserted": int, "skipped": int})`
  - `RewardProvider`, `SegmentResolver` type aliases.
  - `async def train_thresholds(conn, *, pepper: str, reward_provider, segment_resolver=None, learning_rate=LEARNING_RATE) -> TrainSummary`. Groups reward inputs by `(shop_id, detector_id)`; for each group, in its own `conn.transaction()`: resolve segment → read baseline → fold → upsert. Unknown `detector_id` or per-group exception → log + `skipped += 1`, never raises. This is the function slice #4's cron route calls.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/engine/integration/test_threshold_trainer_db.py
from calderyn_engine.moat.threshold_trainer import train_thresholds


def _ri(shop, det, kind, impact, alert):
    return {
        "shop_id": shop,
        "detector_id": det,
        "feedback_kind": kind,
        "dollar_impact": Decimal(str(impact)),
        "days_to_confirm": 1,
        "alert_id": alert,
    }


@pytest.mark.asyncio
async def test_train_moat_proof_cold_start_vs_feedback(pg_pool) -> None:
    """THE MOAT PROOF (spec acceptance 2 + 3).

    Same peer baseline (p25=200,p50=300,p75=400,n=5). A cold-start shop
    with NO feedback gets threshold == p50 (peer consensus). A shop with a
    confirmed_loss shifts strictly BELOW p50 (away from consensus, toward
    its own willingness to act).
    """
    async with pg_pool.acquire() as conn:
        await _seed_baseline(conn, 200, 300, 400, 5)

        cold_shop = str(uuid.uuid4())
        warm_shop = str(uuid.uuid4())
        cold_pseud = pseudonym_for(cold_shop, PEPPER)
        warm_pseud = pseudonym_for(warm_shop, PEPPER)
        for ps in (cold_pseud, warm_pseud):
            await conn.execute(
                "DELETE FROM moat.detection_models "
                "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
                DETECTOR,
                ps,
            )

        # reward_provider returns: cold shop = nothing; warm shop = 1 confirmed_loss.
        async def provider():
            return [_ri(warm_shop, DETECTOR, "confirmed_loss", 50, "al-000")]

        # segment resolver maps every shop to our seeded segment.
        async def seg(_conn, _shop_id):
            return SEGMENT

        # 1) warm shop trains from its own feedback.
        summary = await train_thresholds(
            conn,
            pepper=PEPPER,
            reward_provider=provider,
            segment_resolver=seg,
            learning_rate=0.5,
        )
        assert summary["skipped"] == 0
        assert summary["groups_trained"] == 1

        warm_row = await conn.fetchrow(
            "SELECT threshold_json, posterior_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            warm_pseud,
        )
        warm_tj = json.loads(warm_row["threshold_json"]) if isinstance(warm_row["threshold_json"], str) else warm_row["threshold_json"]
        warm_pj = json.loads(warm_row["posterior_json"]) if isinstance(warm_row["posterior_json"], str) else warm_row["posterior_json"]
        # Feedback shop: strictly BELOW the 300 consensus, alpha>beta.
        assert warm_tj[KEY] < 300.0
        assert warm_pj["alpha"] > warm_pj["beta"]
        assert warm_pj["seeded_from"] == "peer_baseline"

        # 2) cold-start: seed the no-feedback shop directly from the baseline
        #    (the seam slice #4 invokes for consenting shops with no rows).
        from calderyn_engine.moat.threshold_trainer import _seed_prior, _rescale
        base = await _read_peer_baseline(conn, DETECTOR, SEGMENT)
        cold_posterior = _seed_prior(base)
        cold_threshold = _rescale(cold_posterior, base, KEY, Decimal("500"))
        await _upsert_model(conn, DETECTOR, cold_shop, cold_posterior, cold_threshold, PEPPER)

        cold_row = await conn.fetchrow(
            "SELECT threshold_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            cold_pseud,
        )
        cold_tj = json.loads(cold_row["threshold_json"]) if isinstance(cold_row["threshold_json"], str) else cold_row["threshold_json"]
        # Cold-start inherits peer consensus EXACTLY (== p50), better than static 500.
        assert cold_tj[KEY] == 300.0
        # And the moat effect is observable: feedback moved the threshold off consensus.
        assert warm_tj[KEY] < cold_tj[KEY]


@pytest.mark.asyncio
async def test_train_unknown_detector_is_skipped_not_fatal(pg_pool) -> None:
    """Fail-visible (rule 12): an unknown detector_id is counted in
    `skipped`, never raised, and writes no row."""
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())

        async def provider():
            return [_ri(shop_id, "not_a_real_detector", "confirmed_loss", 50, "al-000")]

        async def seg(_conn, _shop_id):
            return SEGMENT

        summary = await train_thresholds(
            conn, pepper=PEPPER, reward_provider=provider, segment_resolver=seg
        )
        assert summary["skipped"] == 1
        assert summary["rows_upserted"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/integration/test_threshold_trainer_db.py -k train -v`
Expected: FAIL — `ImportError: cannot import name 'train_thresholds'` (or SKIP without a local DB).

- [ ] **Step 3: Write minimal implementation**

```python
# append to engine/calderyn_engine/moat/threshold_trainer.py
# (add to imports at the top)
from collections import defaultdict
from collections.abc import Awaitable, Callable, Iterable

import structlog

from calderyn_engine.thresholds import _DETECTOR_THRESHOLDS

logger = structlog.get_logger()

RewardProvider = Callable[[], Awaitable[Iterable[RewardInput]]]
SegmentResolver = Callable[[Any, str], Awaitable[str]]


class TrainSummary(TypedDict):
    groups_trained: int
    rows_upserted: int
    skipped: int


async def _default_segment(_conn: Any, _shop_id: str) -> str:
    """Fallback segment when slice #5 supplies no resolver (spec OQ-2).

    A single global bucket is still k-safe (slice #5 enforces k>=5 when it
    writes the baseline). Logged so the missing wiring is never silent.
    """
    return "all"


async def train_thresholds(
    conn: Any,
    *,
    pepper: str,
    reward_provider: RewardProvider,
    segment_resolver: SegmentResolver | None = None,
    learning_rate: float = LEARNING_RATE,
) -> TrainSummary:
    """Nightly trainer entrypoint (slice #4 calls this after CRON_SECRET auth).

    Groups reward inputs by (shop_id, detector_id); each group is trained
    and upserted inside its OWN short conn.transaction() so the
    read-baseline -> upsert invariant stays on one backend under the
    pgbouncer transaction pooler. A bad group is logged and counted in
    `skipped` — never raised, never silently dropped (rule 12).
    """
    resolver = segment_resolver or _default_segment
    if segment_resolver is None:
        logger.warning("segment_resolver_missing", fallback="all")

    rows = list(await reward_provider())
    groups: dict[tuple[str, str], list[RewardInput]] = defaultdict(list)
    for r in rows:
        groups[(r["shop_id"], r["detector_id"])].append(r)

    summary: TrainSummary = {"groups_trained": 0, "rows_upserted": 0, "skipped": 0}

    for (shop_id, detector_id), group_rows in groups.items():
        spec = _DETECTOR_THRESHOLDS.get(detector_id)
        if spec is None:
            logger.error(
                "train_group_skipped_unknown_detector",
                shop_id=shop_id,
                detector_id=detector_id,
            )
            summary["skipped"] += 1
            continue
        canonical_key, default_usd = spec
        try:
            # One short transaction per group — pooler-safe (spec section 6).
            async with conn.transaction():
                segment = await resolver(conn, shop_id)
                baseline = await _read_peer_baseline(conn, detector_id, segment)
                posterior_json, threshold_json = _fold_group(
                    group_rows, baseline, canonical_key, default_usd, learning_rate
                )
                await _upsert_model(
                    conn, detector_id, shop_id, posterior_json, threshold_json, pepper
                )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "train_group_failed",
                shop_id=shop_id,
                detector_id=detector_id,
                error=str(exc),
                exc_type=type(exc).__name__,
            )
            summary["skipped"] += 1
            continue
        summary["groups_trained"] += 1
        summary["rows_upserted"] += 1

    logger.info("train_thresholds_complete", **summary)
    return summary
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ericchen/Developer/shopify-app && TEST_DATABASE_URL="$(cat tests/engine/.test-db-url 2>/dev/null || echo postgres://postgres:postgres@127.0.0.1:5433/calderyn_test)" python -m pytest tests/engine/integration/test_threshold_trainer_db.py -v`
Expected: PASS — all DB-backed tests pass (6 total), including the moat proof.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/threshold_trainer.py tests/engine/integration/test_threshold_trainer_db.py
git commit -m "moat/threshold_trainer: train_thresholds entrypoint (per-group txn, fail-visible skips)"
```

---

### Task 6: Full-suite green + spec self-review

**Files:**
- No new files. Verification + any fix-ups to the three files from Tasks 1–5.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a passing suite and a spec-coverage confirmation. No new public API.

- [ ] **Step 1: Run the trainer's unit suite (no DB needed)**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_trainer.py -v`
Expected: PASS — 11 passed.

- [ ] **Step 2: Run the trainer's DB suite (local DB)**

Run: `cd /Users/ericchen/Developer/shopify-app && TEST_DATABASE_URL="$(cat tests/engine/.test-db-url 2>/dev/null || echo postgres://postgres:postgres@127.0.0.1:5433/calderyn_test)" python -m pytest tests/engine/integration/test_threshold_trainer_db.py -v`
Expected: PASS — 6 passed.

- [ ] **Step 3: Confirm no regression in the existing moat + acceptance suites**

Run: `cd /Users/ericchen/Developer/shopify-app && python -m pytest tests/engine/moat/test_threshold_updater.py tests/engine/moat/test_rewards.py -v`
Expected: PASS — existing kernel tests unchanged (we imported, did not modify, them).

- [ ] **Step 4: Spec self-review checklist (paste result)**

Verify each spec §7 acceptance criterion maps to a test:
- AC1 convergence → `test_fold_converges_on_50_events_alpha_over_beta`
- AC2 cold-start == p50 → `test_rescale_cold_start_equals_peer_median` + `test_train_moat_proof_cold_start_vs_feedback`
- AC3 confirmed-loss shifts below → `test_rescale_confirmed_loss_loosens_below_consensus` + moat-proof
- AC4 false-positive tightens above → `test_rescale_false_positive_tightens_above_consensus`
- AC5 no baseline → static default → `test_rescale_no_baseline_returns_static_default`
- AC6 A4 pseudonym keying → `test_upsert_writes_pseudonym_keyed_row`
- AC7 idempotent re-run → `test_upsert_is_idempotent_on_conflict` + fold determinism
- AC8 pooler safety → code review of `train_thresholds` per-group `conn.transaction()` (no unit test; confirm by reading the source)

Confirm no placeholders, and that `canonical_key`/`_DETECTOR_THRESHOLDS` usage matches `thresholds.get_threshold`.

- [ ] **Step 5: Commit (only if fix-ups were needed)**

```bash
git add -A
git commit -m "moat/threshold_trainer: full-suite green + spec coverage confirmed"
```

---

## Self-Review

**1. Spec coverage:** Every spec §7 acceptance criterion (1–8) maps to a Task-6 test or a named review item. The moat mechanism (spec §4) is realised by `_seed_prior` (Task 1) + `_rescale` (Task 2); the seam-ins (#2 reward rows, #5 baseline) are the injected `reward_provider`/`segment_resolver` (Task 5); the seam-out (`detection_models` row → `get_threshold`) is `_upsert_model` writing `{canonical_key: number}` (Task 4). Cold-start §5.4 is exercised via the moat-proof test's explicit seed of the no-feedback shop; the production cold-start enumeration is OQ-3 (left to the #4 wiring + #2 contract) and is intentionally NOT hard-coded here.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step is complete and runnable.

**3. Type consistency:** `_seed_prior` → `dict` with `alpha`/`beta`/`seeded_from`/`n_peers`; `_fold_group` adds `n_events`/`last_reward` and returns `(posterior_json, threshold_json)`; `_rescale` returns `{canonical_key: float}`; `_upsert_model` consumes those dicts; `train_thresholds` ties them together. `RewardInput` fields match spec §3.1 and the umbrella's pinned `(shop_id, detector_id, feedback_kind, dollar_impact, days_to_confirm, alert_id)`. `canonical_key`/`default_usd` are sourced from `_DETECTOR_THRESHOLDS` consistently in Tasks 3 and 5.

## Execution Handoff

After saving the plan, offer execution choice:

**Plan complete and saved to `docs/superpowers/plans/2026-06-16-moat-threshold-trainer-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
