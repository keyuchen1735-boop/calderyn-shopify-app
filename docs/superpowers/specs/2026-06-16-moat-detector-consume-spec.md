# Moat Slice #6 — Detector Consume (Spec)

> **Status:** Draft for orchestrator review. Builds against the FIXED shared
> contract in `docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md`.
> This slice does NOT redefine any shared interface. Where reality contradicts
> the umbrella, it is flagged in §8 (Open Questions) — not silently diverged.

**Date:** 2026-06-16
**Slice:** #6 `detector-consume` — the CONSUME arc that closes the loop.
**Owner:** parallel agent (this session).
**Plan 05** — moat (cross-tenant learning) layer.

---

## 1. Problem

`get_threshold(conn, shop_id, detector_id, *, pepper=None)` already exists in
`engine/calderyn_engine/thresholds.py:68` with a full 3-tier lookup
(`moat.detection_models` → `alert_thresholds` → module default → `0`). It is
**never called** — all 12 detectors in `engine/calderyn_engine/detectors/` read
a static module-level constant (`DEFAULT_THRESHOLD_USD = Decimal("500")` or an
analogue) for their dollar gate. The learning loop's CONSUME edge is therefore
dead: a trained `moat.detection_models` row would never reach detection.

This slice threads `get_threshold` into every detector that has a dollar gate so
detection reads the learned, peer-informed threshold. Per the umbrella (§5, §3),
this is a **safe cutover**: `get_threshold` falls through to the module default
when there is no pepper / no model row / no schema, so live detection behavior is
unchanged until slices #1 (`alert_thresholds` writes) and #3 (`detection_models`
writes) land. This spec makes that "unchanged" claim **precise and testable**,
including the one place where the existing registry default does NOT match the
detector's own constant (§5, §8 Q1).

## 2. Goal & non-goals

**Goal.** Each detector with a dollar threshold reads it from
`await get_threshold(conn, shop_id, DETECTOR_ID, pepper=<MOAT_PEPPER>)` instead of
its static constant, preserving the exact canonical key/units the detector
expects, with zero behavior change while the moat is offline (no pepper / no
override row).

**Non-goals (YAGNI — umbrella §8).**
- No new detector logic. We only swap the *source* of the dollar gate.
- No change to ratio/days/percentage thresholds (`AD_TAX_THRESHOLD`,
  `DAYS_OF_COVER_THRESHOLD`, `MIN_DROP_PCT`, `STOCK_CONCENTRATION`, etc.). Only
  the single dollar gate registered in `_DETECTOR_THRESHOLDS` is threaded.
- No change to `get_threshold` itself, to `_DETECTOR_THRESHOLDS`, or to any moat
  kernel. (The one place the registry default disagrees with a detector constant
  is surfaced as Open Question Q1 for the orchestrator — this slice does not
  unilaterally edit the shared registry.)
- No dashboard-parity work. This is engine-internal detection plumbing not
  visible to merchants as a new surface (CLAUDE.md "Feature isolation" /
  dashboard-parity carve-out for internal edits). The threshold *value* a
  merchant sees is already surfaced through the existing alert path; the source
  swap is invisible. No mirror required; noted explicitly.

## 3. The seam (fixed contract — do not redefine)

```
moat.detection_models (written by #3) ──┐
alert_thresholds      (written by #1) ──┤
                                        ▼
                          get_threshold(conn, shop_id, detector_id, *, pepper)
                                        │  → Decimal (canonical_key value, or default, or 0)
                                        ▼
(#6 this slice)   detector.detect(shop_id, conn, now) reads it as its dollar gate
```

`get_threshold` is **async** and needs a live `asyncpg.Connection`. Every
detector's `detect(shop_id, conn, now)` already receives `conn` and is already a
coroutine (verified: all 12 are `@register(...) async def detect(...)`), so the
call is in-scope with no signature change. See §6 for why `pipeline.py` needs no
change.

## 4. Canonical key + default registry (verbatim from `thresholds.py:52`)

`_DETECTOR_THRESHOLDS` maps each detector to `(canonical_key, default)`. The
detector MUST pass its own `DETECTOR_ID` to `get_threshold`; `get_threshold`
internally resolves the canonical key from this table. The detector therefore
never names the key itself — it only consumes the returned `Decimal`.

| detector_id | canonical_key (registry) | registry default |
|---|---|---|
| `sku_stockout_vs_spend` | `min_spend_usd` | `Decimal("500")` |
| `campaign_below_breakeven` | `min_loss_usd` | `Decimal("500")` |
| `regional_spend_starved_stock` | `min_spend_usd` | `Decimal("500")` |
| `scaling_sku_fulfillment_risk` | `min_impact_usd` | `Decimal("500")` |
| `return_rate_hidden_loss` | `min_impact_usd` | `Decimal("500")` |
| `margin_erosion` | `min_impact_usd` | `Decimal("500")` |
| `cogs_drift` | `min_impact_usd` | `Decimal("500")` |
| `ad_tax_overload` | `min_impact_usd` | `Decimal("500")` |
| `negative_unit_economics` | `min_impact_usd` | `Decimal("500")` |
| `reorder_timing` | `min_impact_usd` | `Decimal("500")` |
| `wrong_location_concentration` | `min_impact_usd` | `Decimal("500")` |
| `regional_shortage_risk` | `min_impact_usd` | `Decimal("500")` |

## 5. Current detector reality (the EXACT pattern each one uses today)

Read from source. Four shapes exist; the per-detector edit differs by shape.

### 5a. Shape A — SQL-param dollar gate (threshold flows into the query)

The threshold is passed as a bind param and compared inside SQL as cents
(`>= ($N * 100)`). Swapping it means computing the threshold **before**
`conn.fetch(...)` and binding the fetched value.

| detector | constant today | bind site | SQL compare |
|---|---|---|---|
| `sku_stockout_vs_spend` | `DEFAULT_THRESHOLD_USD = Decimal("500")` | `conn.fetch(_QUERY, shop_id, DEFAULT_THRESHOLD_USD)` (`:126`) | `WHERE sp.spend_cents >= ($2 * 100)` (`:102`) |
| `regional_spend_starved_stock` | `DEFAULT_SPEND_THRESHOLD = Decimal("500")` | `conn.fetch(_QUERY, shop_id, DEFAULT_SPEND_THRESHOLD)` (`:167`) | `WHERE rs.spend_cents >= ($2 * 100)` (`:146`) |

`sku_stockout_vs_spend` ALSO uses the constant a second time for severity:
`severity = "critical" if spend_dollars >= DEFAULT_THRESHOLD_USD * 5 else "high"`
(`:140`). That second read must use the **same fetched threshold value** so the
severity boundary tracks the gate (preserves today's behavior exactly when
threshold == 500).

### 5b. Shape B — Python post-filter dollar gate (`impact < CONST` after fetch)

The query returns candidates; Python drops rows whose `impact` is below the
constant. Swapping means fetching the threshold once at the top of `detect` and
comparing against it. `campaign_below_breakeven` additionally uses it for
severity (`× 4`).

| detector | constant today | gate site | extra use |
|---|---|---|---|
| `campaign_below_breakeven` | `DEFAULT_THRESHOLD_USD = Decimal("500")` | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:92`) | severity `>= ×4` (`:95`) |
| `margin_erosion` | `DEFAULT_THRESHOLD_USD = Decimal("500")` | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:101`) | — |
| `cogs_drift` | `DEFAULT_THRESHOLD_USD = Decimal("500")` | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:76`) | — |
| `negative_unit_economics` | `DEFAULT_THRESHOLD_USD = Decimal("500")` | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:117`) | — |
| `return_rate_hidden_loss` | `DEFAULT_THRESHOLD_USD = Decimal("200")` ⚠ | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:93`) | — |
| `reorder_timing` | `DEFAULT_THRESHOLD_USD = Decimal("200")` ⚠ | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:100`) | — |
| `wrong_location_concentration` | `DEFAULT_THRESHOLD_USD = Decimal("200")` ⚠ | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:110`) | — |
| `regional_shortage_risk` | `DEFAULT_THRESHOLD_USD = Decimal("200")` ⚠ | `if impact < DEFAULT_THRESHOLD_USD: continue` (`:103`) | — |

⚠ **Default mismatch (the load-bearing finding).** These four detectors use a
`$200` module constant, but `_DETECTOR_THRESHOLDS` registers `$500` for all four.
`get_threshold` returns `$500` for them when there is no override row. Naively
replacing `DEFAULT_THRESHOLD_USD` with `get_threshold(...)` would **raise the gate
from $200 → $500** for these four detectors when the moat is offline — a silent
behavior change that violates the umbrella's "zero-behavior-change cutover"
guarantee (§3, §5). See §8 Q1 for the resolution this spec adopts.

### 5c. Shape C — no dollar gate at all (NOT threaded by this slice)

Two detectors have **no `$500`/`$200` dollar comparison** in their code. Their
registry entry (`min_impact_usd:$500`) has nothing to bind to. They gate on
ratios / days / a hardcoded `MIN_SPEND_CENTS`:

| detector | dollar gate present? | what it gates on |
|---|---|---|
| `ad_tax_overload` | **No** | `AD_TAX_THRESHOLD = 0.40` ratio + `MIN_SPEND_CENTS = 100_000` |
| `scaling_sku_fulfillment_risk` | **No** | `DAYS_OF_COVER_THRESHOLD = 5`, `SPEND_TREND_THRESHOLD = 1.5` |

These are **out of scope for the swap** — there is no dollar threshold to thread.
This slice leaves them byte-for-byte unchanged and records the decision (§8 Q2)
so the orchestrator knows the registry over-claims coverage for these two.

### 5d. Net scope

- **Threaded (10 detectors):** the 8 in Shape B + the 2 in Shape A.
- **NOT threaded (2 detectors):** `ad_tax_overload`, `scaling_sku_fulfillment_risk`
  (Shape C — no dollar gate).
- The umbrella says "thread `get_threshold` into all 12 detectors." Reality is
  **10 of 12** have a dollar gate. Flagged as Q2; this spec implements the 10 and
  documents the 2 as no-ops with rationale rather than inventing a gate.

## 6. Why `pipeline.py` needs no change (async + pepper plumbing)

- **Async:** `_run_detectors_in_scope` (`pipeline.py:295`) already
  `await detector(shop_id, conn, now)` inside `with_shop_context`. Detectors are
  already coroutines holding `conn`. Adding an inner `await get_threshold(...)`
  does not change the detector's signature or the pipeline call site. No change
  to `run_for_shop` or `_run_detectors_in_scope`.
- **Pepper:** `get_threshold` reads `MOAT_PEPPER` itself when `pepper is None`
  (`thresholds.py:108`: `pepper if pepper is not None else os.environ.get("MOAT_PEPPER")`).
  The detector therefore calls `get_threshold(conn, shop_id, DETECTOR_ID)` with
  **no pepper argument**, and the helper picks up the env var. This is the
  minimal plumbing — **no new parameter is threaded through the registry or the
  pipeline.** Tests inject a pepper explicitly via the same env var the helper
  reads (`monkeypatch.setenv("MOAT_PEPPER", ...)`), matching how
  `pipeline.py:134` and the moat tests already source it.

  Rationale for env-read over param-plumbing: threading a `pepper` kwarg into
  `detect` would change the `Detector` protocol (`detectors/base.py:44`) and the
  registry call signature in `pipeline.py:315` — a cross-cutting refactor the
  umbrella explicitly warns against ("propose the minimal plumbing; do not
  over-refactor"). The env-read keeps the change inside each detector body.

## 7. Cutover safety (the testable invariant)

For every threaded detector D with registry default `D_def`:

1. **Moat offline, no override** (`MOAT_PEPPER` unset, no `alert_thresholds`
   row, no `moat.detection_models` row): `get_threshold` returns `D_def`.
   Detection MUST be identical to the pre-change behavior **at threshold ==
   `D_def`**. For the 6 detectors whose constant already equals their registry
   default ($500), this is byte-identical to today. For the 4 `$200` detectors,
   see Q1 — this spec pins the gate to the **detector's historical $200** so
   offline behavior is preserved, not the registry's $500.
2. **Override present** (`moat.detection_models` row for the pseudonym, or an
   `alert_thresholds` row): `get_threshold` returns the learned value and the
   detector gates on it. This is the new, desired behavior — proven by the tracer
   test seeding a model row and asserting the gate moved.

The proof obligation is discharged by two tests on the tracer detector
(`sku_stockout_vs_spend`): one with no model row (asserts gate == 500), one with
a `moat.detection_models` row at a different value (asserts gate moved). The plan
then repeats the no-row safety test for each remaining threaded detector at its
own correct default.

## 8. Open questions / contradictions with the umbrella

**Q1 — `$200` default mismatch (BLOCKING for 4 detectors).**
`return_rate_hidden_loss`, `reorder_timing`, `wrong_location_concentration`,
`regional_shortage_risk` use `DEFAULT_THRESHOLD_USD = Decimal("200")`, but
`_DETECTOR_THRESHOLDS` (the shared registry, owned by the umbrella) registers
`$500`. The umbrella's safe-cutover guarantee says offline behavior is unchanged,
but `get_threshold` would return `$500` for these — raising their gate.
**This spec's adopted resolution (the minimal, non-shared-interface-breaking
one):** each threaded detector keeps its existing module constant as the
**fallback floor it passes to detection**, i.e. the detector computes
`threshold = await get_threshold(...)` and the *only* observable change when
offline is that an override row, if present, wins. To guarantee no offline
change for the 4 `$200` detectors WITHOUT editing the shared registry, the plan
binds the gate to `get_threshold`'s return **only when an override actually
exists**, otherwise falls back to the detector's own constant. Concretely the
detector reads `learned = await get_threshold(...)` and uses
`learned if learned != REGISTRY_DEFAULT else DEFAULT_THRESHOLD_USD` — see plan
Task 13 for the exact, simpler formulation that avoids equality-on-Decimal
fragility (it passes the detector's own constant as the floor and treats the
registry default as "no signal"). **Orchestrator decision needed:** the clean
long-term fix is to correct `_DETECTOR_THRESHOLDS` to `$200` for these four (a
one-line-each edit to the shared file). That edit belongs to whoever owns the
registry, not this slice. If the orchestrator approves the registry edit, the
detector code simplifies to the unconditional swap and the per-detector fallback
disappears. Until then, the plan ships the conditional-fallback form so the
cutover is provably zero-change.

**Q2 — "all 12 detectors" over-claims.** Only **10 of 12** have a dollar gate.
`ad_tax_overload` and `scaling_sku_fulfillment_risk` gate on ratios/days and have
no `$` threshold to thread. The registry lists `min_impact_usd:$500` for both,
but no code reads it. This slice does **not** invent a dollar gate for them
(that would be new detector logic, a non-goal). Flagged so the orchestrator can
decide whether a future slice adds an impact floor to these two; for #6 they are
intentional no-ops.

**Q3 — severity boundaries.** `sku_stockout_vs_spend` (`× 5`) and
`campaign_below_breakeven` (`× 4`) derive severity from the same constant. The
plan threads the fetched threshold into those multipliers so severity tracks the
learned gate. This is a behavior change *only when an override moves the
threshold* — which is the whole point of the loop — and is byte-identical when
offline. Confirm this is acceptable (it is the natural reading of "read the
learned threshold"); flagged for visibility, not blocking.

## 9. Acceptance criteria (definition of done)

1. Each of the 10 threaded detectors calls `await get_threshold(conn, shop_id,
   DETECTOR_ID)` once at the top of `detect` and uses the returned `Decimal` as
   its dollar gate (and severity boundary where one exists).
2. With `MOAT_PEPPER` unset and no override rows, each threaded detector fires
   on **exactly the same inputs** as before this slice (proven per-detector by a
   no-row test at the detector's correct historical default).
3. With a `moat.detection_models` row present for the shop's pseudonym, the
   tracer detector (`sku_stockout_vs_spend`) gates on the learned value (proven
   by the cutover test).
4. `ad_tax_overload` and `scaling_sku_fulfillment_risk` are unchanged (Shape C).
5. No change to `thresholds.py`, `_DETECTOR_THRESHOLDS`, `pipeline.py`,
   `detectors/base.py`, or any moat kernel.
6. Pre-commit gate green: `npm run typecheck`/`lint`/`build` are TS-only and
   unaffected; the engine gate is `ruff` + `pytest tests/engine` (DB-free tier
   always; DB-backed tier when `TEST_DATABASE_URL` is set). All detector tests
   pass.
