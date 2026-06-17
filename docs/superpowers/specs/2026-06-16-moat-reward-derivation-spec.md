# Moat Reward Derivation — Slice #2 Spec

> **Status:** Spec for slice #2 of the Moat Loop Closure effort. Builds against
> the FIXED umbrella contract
> (`docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md`). This spec
> MUST NOT contradict the umbrella; where it pins an "open contract item" the
> umbrella delegated to #2, that pin becomes part of the shared contract.

**Date:** 2026-06-16
**Owner:** slice #2 agent
**Slice:** `reward-derivation` — the **producer** of per-`(shop, detector)` reward
inputs that feed the existing pure kernel `compute_reward`.

---

## 1. Problem & scope

The reward kernels (`compute_reward`, `update_threshold`) are pure functions
called only by tests; **nothing produces the rows they consume**. Under the
approved **Fork A** decision (umbrella §2), the reward signal is NOT a new
click-time event stream — it **already exists in raw domain tables**. This slice
defines a **read layer** over those tables that yields one reward-input row per
fed-back alert, in the exact shape the trainer (slice #3) will iterate and pass
into `compute_reward`.

**In scope**
- One new async function — `derive_reward_inputs(conn, shop_id, *, since=None)` —
  in a new module `engine/calderyn_engine/moat/reward_inputs.py`.
- The join `alerts ⋈ alert_feedback (⋈ action_audit)` → reward-input rows.
- One typed row dataclass — `RewardInput` — that is **the seam to slice #3**.
- Pinning the `alert_feedback.kind → compute_reward feedback_kind` mapping
  (the umbrella's open contract item for #2).
- The `days_to_confirm` derivation.
- The decision on whether `action_audit` is a v1 signal or reserved.

**Explicitly NOT in scope** (owned elsewhere / YAGNI per umbrella §8)
- No grouping/aggregation of rewards, no Beta-posterior math, no
  `detection_models` upsert — that is slice #3.
- No call to `compute_reward` itself — this slice **produces its inputs**; #3
  calls the kernel. (One test asserts the seam composes with `compute_reward`,
  but the production code in this module does not import it.)
- No cron route, no scheduling, no locking — slice #4.
- No pseudonymization, no consent gate, no k-floor — that is the **cross-tenant**
  path (slice #5). Per **invariant A5**, per-shop training MAY read the shop's
  own raw data; this slice is the per-shop path and therefore **does not**
  pseudonymize, consult `peer_data_consent`, or touch `moat.*`.
- No TS/dashboard parity — umbrella §8 ("no dashboard-parity work for the
  producer"); this is an internal engine read layer with no merchant-facing
  surface.

## 2. Invariant compliance (umbrella §4)

| # | Invariant | This slice |
|---|---|---|
| A1 | cross-tenant reads pseudonymized ids only | N/A — this is the per-shop path; reads raw `shop_id` (allowed by A5). |
| A2 | only consenting shops in peer aggregates / `event_log` | N/A — writes nothing to any peer aggregate or `event_log`. |
| A3 | k≥5 floor before a baseline | N/A — produces no baseline. |
| A4 | `detection_models` keyed by pseudonym | N/A — writes no model. |
| **A5** | per-shop training MAY use own raw data | **This slice IS the A5 path.** Reads `public.alerts ⋈ public.alert_feedback (⋈ public.action_audit)` scoped to one `shop_id`; emits raw `shop_id` on the reward-input row for the trainer to pseudonymize at write time. **Does not anonymize.** |

The row this slice produces carries a **raw** `shop_id`. That is correct and
intentional: the trainer (#3) is the component that calls `pseudonym_for(...)`
when it writes `moat.detection_models` (A4). Pushing pseudonymization into #2
would force this read layer to know the pepper for no reason — keep the seam raw.

## 3. The mapping (THE CRUX — pinned)

**Introspected from prod DB `ajgrmnvzxfxxlwrxcgnu` and confirmed in the local test
schema (`tests/engine/schema/migrations/20260430000020_alerts_and_context.sql:43`):**

```sql
create type feedback_kind as enum ('confirmed_loss', 'false_positive', 'already_handled');
```

`compute_reward` (`engine/calderyn_engine/moat/rewards.py:41`) expects
`feedback_kind ∈ {'confirmed_loss', 'false_positive', 'already_handled'}`.

**The two vocabularies are identical. The mapping is the IDENTITY function:**

| `alert_feedback.kind` (DB enum) | `compute_reward` `feedback_kind` arg | Reward semantics (from `rewards.py`) |
|---|---|---|
| `confirmed_loss`   | `'confirmed_loss'`   | `+dollar_impact` (clamped ≥ 0) |
| `false_positive`   | `'false_positive'`   | `FALSE_POSITIVE_PENALTY` = `Decimal('-10')` |
| `already_handled`  | `'already_handled'`  | `Decimal('0')` |

**Design consequence — pass the enum label through verbatim.** The reward-input
row's `feedback_kind` field is the raw enum string read straight from
`alert_feedback.kind`. There is **no translation table, no `match`, no remap** in
this slice. This is asserted by a test that pins the three enum labels equal to
the three strings `compute_reward` branches on, so a future enum drift (a 4th
label, or a rename) trips a red test rather than silently producing `0` reward.

> **Robustness note.** `compute_reward` already degrades an unknown kind to
> `Decimal('0')` ("no signal", `rewards.py:89-94`) rather than raising. This
> slice mirrors that posture: it does **not** validate `kind` against an
> allow-list in production code (the DB enum already constrains it). The pin
> lives in a **test**, not a runtime guard — adding a runtime guard would
> duplicate the enum constraint and the kernel's own fallback.

## 4. The join & row derivation

### 4.1 Confirmed columns (prod + test schema)

```
public.alerts          (id uuid, shop_id uuid, detector_id text,
                        dollar_impact numeric(12,2), first_seen_at timestamptz,
                        status alert_status, severity alert_severity, …)
public.alert_feedback  (id uuid, alert_id uuid → alerts(id), shop_id uuid,
                        kind feedback_kind, note text, created_by text,
                        created_at timestamptz)
public.action_audit    (id uuid, shop_id uuid, alert_id uuid → alerts(id),
                        action_kind action_kind, outcome action_outcome,
                        undo_of uuid, dollar_impact_at_exec numeric(12,2),
                        created_at timestamptz, completed_at timestamptz, …)
```

### 4.2 Grain & join

**One reward-input row per `alert_feedback` row** (the feedback IS the reward
signal). Inner-join feedback to its alert to pick up `detector_id`,
`dollar_impact`, and `first_seen_at`:

```sql
select
  af.id            as feedback_id,    -- row identity / debugging
  a.id             as alert_id,       -- seam field
  a.shop_id        as shop_id,        -- raw (A5); trainer pseudonymizes
  a.detector_id    as detector_id,    -- groups rewards in #3
  a.dollar_impact  as dollar_impact,  -- fed to compute_reward
  af.kind::text    as feedback_kind,  -- IDENTITY-mapped enum label
  af.created_at    as feedback_at,    -- for days_to_confirm
  a.first_seen_at  as alert_first_seen_at
from public.alert_feedback af
join public.alerts a on a.id = af.alert_id
where a.shop_id = $1::uuid
  and ($2::timestamptz is null or af.created_at >= $2::timestamptz)
order by af.created_at asc;
```

Notes:
- `af.kind::text` casts the enum to its label string so asyncpg returns a plain
  `str` (not an asyncpg enum object) — the field the seam exposes.
- `where a.shop_id = $1` is the per-shop scope. **Filtering on the alert's
  `shop_id` (not the feedback's) is deliberate** — they are equal by the app's
  write path, but the alert is the source of truth for the tenant that owns the
  detection. (The function does **not** rely on RLS / `with_shop_context`; it
  filters explicitly so the trainer can run it per-shop on a plain pooled
  connection, matching how `compute_peer_baselines` takes a bare `conn`.)
- `since` (`$2`) is an optional incremental-cutoff so the nightly trainer can
  process only feedback created since the last run; `None` ⇒ full history. This
  is a convenience for #4/#3, not a correctness requirement.
- **`INNER` join, not `LEFT`:** feedback with no parent alert cannot occur
  (`alert_feedback.alert_id` is `NOT NULL` with an FK + `ON DELETE CASCADE`), so
  an inner join can never silently drop a real reward signal.

### 4.3 `days_to_confirm`

```
days_to_confirm = whole days between alerts.first_seen_at and alert_feedback.created_at
                = (af.created_at - a.first_seen_at) truncated toward zero to whole days
```

Computed in **Python** (not SQL) so the arithmetic is identical to the test
fixtures and free of Postgres `interval`/`extract` rounding surprises:

```python
delta = feedback_at - alert_first_seen_at          # datetime.timedelta
days_to_confirm = max(int(delta.total_seconds() // 86400), 0)
```

- `int(... // 86400)` floors to **whole days** (e.g. 47 h → 1 day).
- `max(..., 0)` clamps the pathological case where feedback predates the alert
  (clock skew / backfill) to `0`, so the trainer never sees a negative age.
- **`days_to_confirm` is reserved in v1** — `compute_reward` accepts it but does
  not use it (`rewards.py:57-60`, umbrella §8 "no recency decay"). We compute and
  surface it anyway because it is part of the seam #3 reads, and computing it now
  means adding recency decay later touches only the kernel, not this producer.

## 5. `action_audit` decision — **RESERVED (documented secondary), NOT a v1 signal**

**v1 primary signal = `alert_feedback` only.** `action_audit` is a documented
reserved secondary signal that this slice **does not read**.

**Rationale:**
1. **`alert_feedback` is the direct, unambiguous reward.** Its `kind` maps 1:1
   onto `compute_reward`'s three branches (§3). `action_audit.outcome`
   (`succeeded|failed|pending|retrying`) is about whether the *remediation
   mechanics* worked, not whether the *alert was correct* — a different
   question. A `succeeded` pause of a campaign says nothing about whether the
   detector should have fired; conflating the two would teach the trainer the
   wrong thing.
2. **Reconciling `undo_of` is real complexity for ~zero v1 value.** An honest
   `action_audit` reward would have to net out undone actions (`undo_of` chains)
   and dedupe retries (`attempts`, `retrying`) before `dollar_impact_at_exec`
   means anything. That is a join and a window function for a signal we have no
   evidence we need yet (prod has 0 `alert_feedback` rows and 97 `action_audit`
   rows, but the loop has never run). **YAGNI** (umbrella §8).
3. **The seam already carries the hook.** The reward-input row includes
   `alert_id`, so a future slice can join `action_audit` back on `alert_id`
   without changing this producer's signature — the reserved path is cheap to
   add later precisely because we pin the seam now.

**What "reserved" means concretely:** the `RewardInput` row does **not** include
any `action_audit`-derived field in v1. When/if an `action_audit` secondary
signal is introduced, it SHOULD be an **additive, optional** field on
`RewardInput` (e.g. `action_outcome: str | None = None`) so #3 can opt in without
a breaking change. This spec does not add that field now.

## 6. THE SEAM (output contract to slice #3) — unambiguous

A frozen dataclass `RewardInput` in
`engine/calderyn_engine/moat/reward_inputs.py`:

```python
from __future__ import annotations
from dataclasses import dataclass
from decimal import Decimal

@dataclass(frozen=True)
class RewardInput:
    """One reward signal: a single alert_feedback row joined to its alert.

    Field-for-field this is exactly what slice #3 needs to call
    ``compute_reward(feedback_kind, dollar_impact, days_to_confirm)`` and then
    pseudonymize ``shop_id`` for the ``moat.detection_models`` write.
    """
    shop_id: str        # raw tenant uuid (A5); #3 pseudonymizes at write time
    detector_id: str    # e.g. "sku_stockout_vs_spend" — #3 groups by this
    feedback_kind: str  # raw enum label, ∈ {confirmed_loss,false_positive,already_handled}
    dollar_impact: Decimal   # alerts.dollar_impact (numeric → Decimal)
    days_to_confirm: int     # whole days, ≥ 0; reserved (compute_reward ignores in v1)
    alert_id: str       # alerts.id — join key for a future action_audit secondary signal
```

```python
async def derive_reward_inputs(
    conn,                       # asyncpg connection; caller owns tx scope
    shop_id: str,
    *,
    since: "datetime | None" = None,
) -> list[RewardInput]: ...
```

**Seam guarantees #3 may rely on:**
- One `RewardInput` per `alert_feedback` row for `shop_id` (optionally filtered
  by `since`), ordered by feedback time ascending.
- `feedback_kind` is always one of the three enum labels (DB enum-constrained)
  and is safe to pass straight into `compute_reward` (identity mapping, §3).
- `dollar_impact` is a `Decimal` (asyncpg returns `numeric` as `Decimal`) —
  directly accepted by `compute_reward`'s `dollar_impact` param.
- `days_to_confirm` is a non-negative `int`.
- `shop_id` and `alert_id` are `str` (uuid text form), matching the rest of the
  engine which passes shop ids as strings (e.g. `pipeline.run_for_shop`).

**Reduced seam type (for reference — not a separate object):** the exact tuple
the umbrella asked #2 to pin is
`(shop_id: uuid(str), detector_id: text, feedback_kind: str, dollar_impact: Decimal, days_to_confirm: int, alert_id: uuid(str))`,
which is `RewardInput`'s field order minus the internal join columns.

## 7. Module shape & conventions

Mirror the canonical sibling `engine/calderyn_engine/moat/peer_baselines.py`:
- One module, one public async function + one dataclass.
- Takes a bare `conn`; **does not** open a transaction or call
  `with_shop_context` (caller owns scope; the function is a pure read).
- A single SQL `fetch`, then a Python comprehension to build the rows (the only
  Python-side computation is `days_to_confirm` and the `Decimal` pass-through).
- `from __future__ import annotations`; `structlog` logger named per module if a
  log line is warranted (an empty result is logged at `info`, mirroring
  `peer_baselines`' observability posture). No new third-party deps.

## 8. Test strategy

Two test files under `tests/engine/moat/` (the established location; inherits the
`pg_pool` fixture and `TEST_DATABASE_URL`-gated skip from
`tests/engine/conftest.py`):

1. **`test_reward_inputs_mapping.py`** — **pure, no DB.** Pins the crux: the three
   `feedback_kind` enum labels equal the three strings `compute_reward` branches
   on, and that feeding a `RewardInput.feedback_kind` + `.dollar_impact` +
   `.days_to_confirm` into `compute_reward` yields the documented reward. This is
   the regression guard for enum drift. Decimal fixtures, matching
   `test_rewards.py` conventions.

2. **`test_reward_inputs_derive.py`** — **DB-backed** via `pg_pool` (skips unless
   a local `TEST_DATABASE_URL` is set, exactly like `test_peer_baselines.py`).
   Seeds `shops` → `alerts` → `alert_feedback` directly and asserts:
   - one `RewardInput` per feedback row, with `detector_id` / `dollar_impact` /
     `feedback_kind` / `alert_id` carried from the join;
   - `days_to_confirm` = whole-day floor of `(feedback.created_at −
     alert.first_seen_at)`, and clamps to `0` for feedback older than its alert;
   - per-shop scoping: a second shop's feedback never leaks into shop A's rows;
   - the `since` cutoff filters out older feedback.

Run command (matches `tests/engine/scripts/test-db.sh` header):

```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_mapping.py \
  tests/engine/moat/test_reward_inputs_derive.py -v
```

The pure mapping test runs without a DB (no skip); the derive test skips cleanly
when `TEST_DATABASE_URL` is unset.

## 9. Open questions / contradictions with the umbrella

**None.** The umbrella delegated exactly one open contract item to #2 — pin the
`alert_feedback.kind` mapping — and it resolved to the identity function (§3),
which is the cleanest possible outcome and contradicts nothing. The
`action_audit` decision (reserved, §5) is consistent with umbrella §8's YAGNI
stance ("no recency decay", "no parallel click-time stream"). The raw `shop_id`
on the seam is explicitly sanctioned by invariant A5 and is consumed by #3's
pseudonymization step (A4), so no anonymization invariant is at risk in this
slice.
