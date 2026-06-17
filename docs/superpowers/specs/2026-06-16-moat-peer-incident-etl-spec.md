# Moat Peer + Incident ETL — Spec (Slice #5)

> **Status:** Spec for slice **#5 — `peer-incident-etl`** of the moat-loop-closure
> effort. Builds against the FIXED shared contract in
> `docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md` (the "umbrella").
> This spec MUST NOT contradict the umbrella; where it needs to resolve an
> umbrella "open contract item," it does so explicitly and flags it for the
> orchestrator (see §10).

**Date:** 2026-06-16
**Owner:** slice-#5 agent
**Umbrella invariants owned here:** A1, A2, A3 (umbrella §4).
**Prod project:** `ajgrmnvzxfxxlwrxcgnu`.

---

## 1. Problem / scope

The moat's cross-tenant arm is the **anonymized prior**. Today the kernels that
build it (`compute_peer_baselines`, `extract_incident`) and the emitter
(`emit_moat_event`) are **called only by tests** — there is no nightly job that
(a) feeds `moat.event_log` from the day's domain `public.alerts`, (b) rolls those
into `moat.peer_baselines`, or (c) harvests confirmed losses into the incident
library. `moat_keys.shop_pseudonym` has 0 rows in prod and `moat.peer_baselines`
is empty (verified). This slice builds **that orchestrator** — three pure-Python
async functions plus their integration tests. It owns the **producer half** of the
cross-tenant moat; slice #3 (`threshold-trainer`) consumes `moat.peer_baselines`
as its Bayesian prior (the seam in §7).

**In scope (this slice):**
1. **Pseudonymized projection** — for consenting shops, project a day's
   `public.alerts` rows into `moat.event_log` as `detection_fired` events,
   pseudonymized, consent-gated, idempotent on re-run.
2. **Peer baselines** — drive `compute_peer_baselines` over the segments/detectors
   present in `moat.event_log`, enforcing the k≥5 floor (delegated to the kernel).
3. **Incident library** — drive `extract_incident` over the day's confirmed losses.

**Out of scope (other slices / YAGNI):**
- No per-shop reward derivation (#2). No threshold training / `detection_models`
  upsert (#3). No `/cron/moat-train` route or `vercel.json` entry (#4) — this slice
  exposes a **callable orchestrator** that #4 invokes; it does not own the route.
- No detector wiring (#6). No new moat tables (all exist; umbrella §8).
- No TS-side emitter. No recency decay. No fuzzy incident matching (the
  `similarity_threshold` column stays at its default).

## 2. Fixed dependencies (existing code — do not modify)

All paths are existing, read-only for this slice. Signatures pinned from source.

- `engine/calderyn_engine/moat/emitter.py`
  `async emit_moat_event(conn, *, shop_id, kind, payload, pepper, peer_data_consent, detector_id=None) -> bool`.
  Validates `kind` against `EVENT_KINDS`, validates `payload` via
  `PAYLOAD_MODELS[kind]`, resolves/inserts the pseudonym, then gates: kinds NOT in
  `ALWAYS_EMIT_KINDS` skip when `peer_data_consent` is False. **`detection_fired`
  IS in `ALWAYS_EMIT_KINDS`** — so the emitter will NOT consent-gate it; this slice
  MUST apply the consent filter itself (see §4, A2).
- `engine/calderyn_engine/moat/peer_baselines.py`
  `async compute_peer_baselines(conn, detector_id: str, segment: str) -> int`.
  Single-statement SQL aggregate over `moat.event_log` `detection_fired` rows for
  **consenting** shops only (JOIN to `public.shops … peer_data_consent = true`);
  computes `percentile_cont` p25/p50/p75 of `payload->>'dollar_impact'`; enforces
  `K_FLOOR = 5` distinct pseudonyms via the count `n`; upserts
  `moat.peer_baselines` on conflict `(detector_id, segment)`. Returns the
  contributor count, or `0` when the k-floor was not met (no row written).
  **`segment` is a caller-supplied free-form string** — the kernel is
  segment-agnostic ("the caller decides which shops belong to which segment").
- `engine/calderyn_engine/moat/incident_extractor.py`
  `async extract_incident(conn, alert_id: str, confirmed_loss_usd: Decimal|float|int) -> bool`.
  Reads `alerts ⋈ alert_context.evidence`, computes a PII-stripped
  `pattern_signature`, skips on exact-signature dup, else inserts one
  `moat.incident_library` row. Returns True iff a row was inserted.
- `engine/calderyn_engine/moat/pseudonym.py`
  `pseudonym_for(shop_id: str, pepper: str) -> str` → `"p_" + hex(HMAC_SHA256(pepper, shop_id))[:32]`. Deterministic, irreversible.
- `engine/calderyn_engine/moat/consent_purge.py`
  `async purge_shop_contributions(conn, shop_pseudonym: str) -> int`. Already exists;
  re-runs `compute_peer_baselines` for every `(detector_id, segment)` the shop
  touched on consent revocation. **Constrains this slice's segment design:** the
  segment must be **recomputable deterministically from current data**, because the
  purge path re-derives baselines without the original ETL inputs (see §3).

### 2.1 Table shapes (prod-verified)

- `public.alerts(id uuid, shop_id uuid, detector_id text, entity_ref jsonb, status alert_status, severity …, dollar_impact numeric NOT NULL, day_bucket date NOT NULL, claude_narrative, claude_rank, first_seen_at, last_seen_at, resolved_at, snoozed_until)`.
  `status` enum = `{open, acknowledged, resolved, snoozed, dismissed}`.
- `public.alert_context(alert_id uuid, evidence jsonb, …)` — evidence source for incidents.
- `public.alert_feedback(id, alert_id, shop_id, kind ENUM, note, created_by, created_at)`.
- `public.shops(id uuid, shop_domain, …, peer_data_consent boolean NOT NULL DEFAULT false, …)`.
  **No segmentation column** (no vertical / GMV band / region) — verified.
- `public.order_fact(id, shop_id, …, total_cents int, created_at_source timestamptz, …)` — GMV source for the segment (§3).
- `moat.event_log(id bigserial PK, pseudonym_id text NOT NULL, event_kind moat.event_kind NOT NULL, detector_id text, payload jsonb NOT NULL, observed_at timestamptz DEFAULT now(), ingested_at timestamptz DEFAULT now())`.
- `moat.peer_baselines(detector_id text, segment text, p25 numeric(18,6), p50 numeric(18,6), p75 numeric(18,6), n int, computed_at timestamptz, PK(detector_id, segment), CHECK(n >= 0))`.
- `moat.incident_library(id uuid PK, detector_id text, pattern_signature text, narrative_template text, similarity_threshold numeric(4,3) DEFAULT 0.85, created_at timestamptz)`.
- `moat_keys.shop_pseudonym(shop_id uuid, pseudonym_id text)` — pseudonym mapping.

## 3. The segment definition (PINNED — umbrella open item resolved)

The umbrella (§5) leaves the `segment` key open: "read `peer_baselines.py` and pin
the exact `segment` key." The answer from source: **`compute_peer_baselines` does
not define a segment** — it takes `segment` as an opaque caller string and groups
ALL `detection_fired` rows for the given `detector_id` (across consenting shops)
into one quartile snapshot stored under that string. The segment is therefore a
**slice-#5 design decision**. We pin it as follows.

**Constraints driving the choice:**
- Must be a **shop-level** attribute (one segment per shop), so "peers" = similar
  shops, per umbrella §4 ("peers must be similar shops").
- Must be **PII-free** (A1/A2 spirit — no raw shop identity in the aggregate key).
- Must be **deterministically recomputable from current DB state**, because
  `consent_purge.py` re-runs baselines without the ETL's original inputs.
- `public.shops` has **no** category / vertical / GMV / region column. Category
  (`sku_dim.category`) is **per-SKU** — a shop spans many categories, so it is not
  a clean shop-level key. The only stable shop-level signal is **revenue scale**.

**PINNED segment scheme (v1): GMV band.**

```
segment = "gmv:" + band
band ∈ { micro, small, mid, large, xl }
```

The band is derived from the shop's trailing-90-day gross merchandise value,
`gmv_90d = sum(order_fact.total_cents) where created_at_source >= (run_date - 90 days)`,
mapped by fixed thresholds (USD):

| band  | trailing-90d GMV (USD)        |
|-------|-------------------------------|
| micro | `< 10,000`                    |
| small | `10,000 ≤ gmv < 50,000`        |
| mid   | `50,000 ≤ gmv < 250,000`       |
| large | `250,000 ≤ gmv < 1,000,000`    |
| xl    | `≥ 1,000,000`                 |

Rationale: a `$500` loss is materially different for a $10k/quarter shop vs a
$1M/quarter shop, so banding by revenue scale makes the peer-quartile threshold
meaningful and comparable. This matches the DDL's own canonical example
(`size:mid`, migration `…_33_peer_baselines.sql:7`). GMV band is shop-level,
PII-free, and recomputable (the purge path can re-derive it).

**A shop with zero trailing-90d orders → `band = micro`** (GMV 0 falls in the
`< 10,000` bucket). This is intentional: brand-new shops cohort together at the
bottom band rather than being dropped.

**The segment map is a single pure function** `segment_for_shop(gmv_90d_cents: int) -> str`
so the projection step, the baseline-driver step, and `consent_purge`'s implicit
re-derivation all agree byte-for-byte. The thresholds live in one module-level
constant `GMV_BANDS`. **Extensibility note (non-goal for v1):** a future
`"cat:"` or `"region:"` scheme can be added behind the same function without
touching the kernel — but v1 ships GMV band only (YAGNI).

## 4. The pseudonymized projection (domain `alerts` → `moat.event_log`)

**Goal:** for each consenting shop, take that shop's `public.alerts` rows for one
`day_bucket` and emit one `detection_fired` row per alert into `moat.event_log`,
pseudonymized, idempotent.

**Consent gate (A2).** `detection_fired` is in `ALWAYS_EMIT_KINDS`, so
`emit_moat_event` will NOT suppress it on `peer_data_consent=false`. The projection
MUST therefore filter to consenting shops **before** emitting. The driver selects
alerts only for shops with `peer_data_consent = true`:

```sql
SELECT a.id, a.shop_id, a.detector_id, a.dollar_impact, a.severity, a.day_bucket
  FROM public.alerts a
  JOIN public.shops s ON s.id = a.shop_id
 WHERE s.peer_data_consent = true
   AND a.day_bucket = $1            -- the run's target day
```

For each row, call `emit_moat_event(conn, shop_id=…, kind='detection_fired',
payload={…}, pepper=…, peer_data_consent=True, detector_id=…)`. We pass
`peer_data_consent=True` because the SQL already proved consent; this keeps the
emitter's own gate a redundant second line of defense (defense-in-depth, never a
bypass). A non-consenting shop's alerts are never selected, so its pseudonym is
never even resolved (A2 holds at the SQL boundary, as in `peer_baselines.py`).

**Projected payload.** The prod `detection_fired` payload model
(`PAYLOAD_MODELS['detection_fired']`) is `{alert_id, severity, detector_id,
dollar_impact, thresholds_used}` (verified against prod seed rows). The projection
builds exactly this shape from the alert row. **`dollar_impact` is the field
`compute_peer_baselines` aggregates** — it MUST be present and numeric. We also add
the `day_bucket` into the payload (the model permits extra keys via the same
passthrough the kernels rely on) to support idempotency (below). The pseudonym is
resolved by the emitter; **no `shop_id` is written to `moat.event_log`** — the
table has no `shop_id` column by design (migration `…_30_moat_schema.sql:6`).

**Idempotency (re-run safety).** The nightly job may re-run for the same
`day_bucket` (retry, manual replay). Re-emitting would double-count a day's alerts
in the quartiles. `moat.event_log` is append-only with a `bigserial` PK and has no
natural unique key, so we enforce idempotency in the **driver**, not via a DB
constraint:

> Before projecting `day_bucket = D`, delete this slice's own prior projection for
> that day, then re-insert. Scope the delete to projected `detection_fired` rows
> for `day_bucket = D` only:
>
> ```sql
> DELETE FROM moat.event_log
>  WHERE event_kind = 'detection_fired'
>    AND (payload->>'day_bucket')::date = $1
> ```
>
> This is a **delete-then-reproject** transaction (`conn` is inside a single
> `BEGIN/COMMIT` owned by the orchestrator). Because the delete is keyed on the
> in-payload `day_bucket`, a re-run for day D replaces exactly day D's projected
> rows and leaves other days untouched. The pre-existing 2026-06-04 seed rows
> (which carry NO `day_bucket` in their payload) are never matched, so the seed is
> preserved. Idempotency is therefore: **N runs for day D ⇒ exactly one projected
> row set for day D.** (Test: §9, `test_projection_idempotent_on_rerun`.)

**A1 (pseudonyms only).** Every written row carries `pseudonym_id` from
`pseudonym_for`/the emitter; the projection never writes `shop_id`. The driver's
SELECT reads `shop_id` only to (a) prove consent and (b) hand it to the emitter,
which converts it to a pseudonym before the INSERT. No raw `shop_id` reaches
`moat.event_log`. (Test: §9, `test_projection_writes_only_pseudonyms`.)

## 5. The peer-baseline driver (`moat.event_log` → `moat.peer_baselines`)

`compute_peer_baselines` computes **one** `(detector_id, segment)` row per call.
The driver must call it once per **distinct `(detector_id, segment)` pair that has
projected data**. But the segment is NOT stored on `moat.event_log` (no segment
column), and the kernel's aggregate does not filter by segment — it aggregates ALL
consenting rows for the detector. This is the key subtlety:

> **The kernel groups by detector only; the `segment` arg is just the label the
> resulting single snapshot is stored under.** So to produce a *per-segment*
> baseline, the driver must restrict the input population to one segment's shops
> per call. The kernel as written does NOT do that restriction.

**Resolution (v1, faithful to the fixed kernel):** the driver groups consenting
shops by their GMV band, and for each band it calls `compute_peer_baselines` once.
Because the kernel aggregates *all* consenting `detection_fired` rows for the
detector (not just one band's), **calling it once per band with the same detector
would write the same quartiles under five different segment labels** — which is
wrong. Two faithful options, decided here:

- **Option A (PINNED for v1): single-segment-per-run population.** The driver does
  NOT pass arbitrary band labels into the unmodified kernel. Instead it computes
  the **segment the projected population actually represents** and calls the kernel
  once per `(detector, segment)` where the projected `event_log` rows for that run
  all belong to that segment's shops. In v1 the projection is **partitioned by
  segment**: the driver iterates bands, and for each band it (1) restricts the
  consenting-shop set to that band, (2) ensures only that band's shops have
  projected rows in scope, and (3) calls `compute_peer_baselines(conn, detector,
  "gmv:<band>")`. Concretely this is achieved by having the kernel's
  consenting-shops CTE already filter to the run's segment via a **segment-scoped
  consenting view** the driver sets up per band (a `TEMP VIEW`/CTE-equivalent), so
  the existing kernel SQL — which reads `consenting` — sees only the band's shops.

  Because modifying the kernel is **out of scope** for this slice (umbrella: kernels
  are fixed shared contract), v1 ships the **driver-side population scoping** by
  running the per-band baseline against a **per-band consenting set** materialized
  into a session-scoped helper the kernel already consults (`public.shops` filtered
  by `peer_data_consent`). Since the kernel hard-codes its `consenting` CTE against
  `public.shops`, v1's driver achieves segment scoping by **only projecting one
  band's shops into `moat.event_log` per `(detector, day)` is NOT possible** (all
  bands' alerts land the same day). Therefore:

- **Option B (PINNED — the one we implement): segment baked into the event row +
  driver enumerates pairs.** We make the segment **observable from the event row**
  by writing `payload->>'segment'` at projection time (the GMV band of the alert's
  shop, computed in step §4). The baseline driver then enumerates the distinct
  `(detector_id, segment)` pairs present in projected rows and, for each, calls a
  thin **segment-aware aggregate** that mirrors the kernel's math but filters
  `payload->>'segment' = $segment`. **This requires a kernel that can filter by
  segment.** The fixed `compute_peer_baselines` cannot. **Conflict — see §10.**

**Decision actually shipped (to avoid contradicting the fixed kernel):** v1 ships
the projection so that **each nightly run processes exactly one segment at a time
is not how alerts arrive**, so we DO need per-segment filtering in the aggregate.
Since the umbrella forbids editing the kernel, slice #5 ships its **own**
segment-aware baseline function `compute_peer_baselines_by_segment(conn,
detector_id, segment)` in a **new** module (`peer_incident_etl.py`) that reuses the
kernel's exact SQL shape but adds `AND e.payload->>'segment' = $2` to the
`observations` CTE and keeps the identical `K_FLOOR = 5` floor and the identical
upsert. The original `compute_peer_baselines` is left untouched and still used by
`consent_purge.py`. This is **additive, not a modification** of the shared kernel,
and is the minimum that satisfies "peers = similar shops" without touching fixed
code. The k≥5 floor, consent JOIN, and upsert semantics are preserved verbatim.
(This is flagged to the orchestrator in §10 as the one place the umbrella's "reuse
`compute_peer_baselines`" wording could not be taken literally while also producing
*per-segment* baselines.)

**k≥5 enforcement (A3).** Identical to the kernel: the segment-aware aggregate
computes `count(distinct pseudonym_id) as n` and writes a row **only when
`n >= 5`**; otherwise it logs `peer_baselines_skipped_k_floor` and writes nothing
(not even an `n<5` row). The floor is the constant `K_FLOOR = 5`, re-exported from
the kernel module so there is a single source of truth. (Tests: §9,
`test_baseline_4_contributors_suppressed`, `test_baseline_5_contributors_written`.)

**Consent (A2).** The segment-aware aggregate keeps the kernel's `consenting` CTE
verbatim (JOIN `public.shops … peer_data_consent = true`), so a non-consenting
shop's rows are filtered at the JOIN even if (defensively) a stale projected row
existed. Combined with the projection's own consent filter (§4), consent is
enforced **twice** on the read path. (Test: §9,
`test_nonconsenting_shop_absent_from_baseline`.)

## 6. The incident-library driver (confirmed losses → `moat.incident_library`)

The day's confirmed losses come from `alert_feedback.kind = 'confirmed_loss'`
(the mapping #2 pins; this slice only reads the literal value that already appears
in prod payloads: `feedback_kind = 'confirmed_loss'`). The driver selects, for the
run's day, the alerts that received a confirmed-loss signal **for consenting shops
only** (incidents are cross-tenant library entries, so the same consent gate
applies — A2), then calls `extract_incident(conn, alert_id, confirmed_loss_usd)`
for each. `extract_incident` already handles dedup (exact-signature) and PII
stripping internally; the driver only supplies `alert_id` + the confirmed loss
amount. The confirmed-loss amount and timestamp are read from `alert_feedback`
(prod payload carries `confirmed_loss_usd`); the driver maps the feedback row to a
loss USD value. (Test: §9, `test_incident_extracted_for_confirmed_loss` and
`test_incident_dedup_skips_second`.)

> **Consent on incidents:** `extract_incident` itself has NO consent gate (it
> writes a PII-stripped pattern, not shop data). To uphold A2 uniformly, slice #5's
> driver gates incident extraction on `peer_data_consent = true` at the SELECT, the
> same as the projection. A non-consenting shop's confirmed loss never enters the
> library. (Test: §9, `test_nonconsenting_confirmed_loss_skipped`.)

## 7. SEAM-OUT to slice #3 (the moat prior)

This is the cross-tenant seam #3 depends on. Slice #3 (`threshold-trainer`) reads
`moat.peer_baselines` to seed each `(shop, detector)` posterior's prior
`(α₀, β₀)` (umbrella §4.1) instead of a flat `(1, 1)`.

**Output table (unchanged shape; PK `(detector_id, segment)`):**

| column        | type            | meaning for #3                                   |
|---------------|-----------------|--------------------------------------------------|
| `detector_id` | `text`          | join key — the detector being primed             |
| `segment`     | `text`          | `"gmv:<band>"` — #3 looks up the shop's band      |
| `p25`         | `numeric(18,6)` | 25th pct of peer `dollar_impact` (lower quartile) |
| `p50`         | `numeric(18,6)` | **median** peer `dollar_impact` — prior centre    |
| `p75`         | `numeric(18,6)` | 75th pct (upper quartile) — dispersion            |
| `n`           | `integer`       | distinct consenting contributors (always `≥ 5`)   |
| `computed_at` | `timestamptz`   | freshness of the baseline                         |

**The baseline stat #3 needs:** per `(segment, detector)`, **`p50` is the central
peer threshold** (the dollar-impact level that splits the consenting peer cohort)
and **`n` is the prior's strength/confidence** (more contributors ⇒ a tighter,
more trusted prior). `p25`/`p75` give the spread #3 may use to set the prior's
variance. #5 guarantees:
- Every published row satisfies `n >= 5` (A3) — #3 never sees a sub-k baseline.
- `p25 ≤ p50 ≤ p75` (percentile_cont ordering) — #3 may rely on monotonicity.
- The row is **anonymized** (A1) and **consent-clean** (A2) — #3 inherits both
  invariants for free by reading only this table.

**How #3 derives the prior (contract, not #5's code):** for a shop in segment `g`
and detector `d`, #3 reads `moat.peer_baselines WHERE detector_id=d AND segment=g`.
The prior is centred on `p50` and strengthened by `n`; the exact `(α₀, β₀)`
mapping (e.g. method-of-moments on the Beta prior using `p50` as the mode and `n`
as pseudo-count) is **#3's responsibility**, not #5's. #5's only promise is the
column contract above. If `WHERE detector_id=d AND segment=g` returns no row (band
unrepresented or k-floored), #3 falls back to flat `(1, 1)` / the static $500
default — exactly the umbrella's "safe cutover" behaviour. #5 does **not** write
placeholder rows for under-populated segments.

## 8. The orchestrator entry point (what #4 invokes)

This slice exposes one coroutine #4 (`train-cron`) calls per nightly run:

```python
async def run_peer_incident_etl(conn, *, run_date: date, pepper: str) -> EtlReport
```

- `run_date` — the `day_bucket` to project + the window anchor for GMV + incidents.
- `pepper` — the active `MOAT_PEPPER` (the caller reads it from env; #5 never reads
  env — umbrella secret rules).
- `conn` — an asyncpg connection scoped by the caller. **Transaction scope is the
  caller's** (mirrors every other moat kernel: "this function does not
  BEGIN/COMMIT"). #4 wraps the call in one transaction so a failure rolls the whole
  night back (fail-visibly, rule 12).
- Returns an `EtlReport` dataclass: `{alerts_projected: int, baselines_written:
  int, baselines_suppressed: int, incidents_extracted: int}` so #4 can log
  per-night counts (observability; no silent partial success).

`run_peer_incident_etl` performs, in order: (1) projection (§4), (2) baseline
driver over distinct `(detector, segment)` pairs (§5), (3) incident driver (§6).
Each sub-step is independently unit-tested (§9). The orchestrator surfaces any
sub-step exception to the caller (no swallow), and the `EtlReport` counts let #4
assert "we did work."

> **Pooler note (prod):** prior observations flag that the moat path runs under a
> pgbouncer **transaction** pooler, and the engine pools pin
> `statement_cache_size=0`. #5 adds no new pool; it receives `conn` from #4 and
> issues only plain `execute`/`fetch` (no prepared-statement reuse across
> transactions), so it is pooler-safe by construction. The delete-then-reproject
> idempotency (§4) is correct only **inside one transaction** — #5 documents that
> the caller MUST NOT split the projection across pooled transactions.

## 9. Test plan (proves the invariants)

All tests are DB-backed via the existing `pg_pool` fixture
(`tests/engine/conftest.py`) — they **skip** unless `TEST_DATABASE_URL` points at a
local Postgres (run `tests/engine/scripts/test-db.sh up` first). They mirror the
seeding style of `tests/engine/moat/test_peer_baselines.py` (insert shop +
pseudonym + events; assert against `pseudonym_for`). Async tests use the explicit
`@pytest.mark.asyncio` marker (matching the existing moat suite — not auto mode).

**Invariant-proving tests (MANDATORY, per the task):**
1. `test_baseline_4_contributors_suppressed` — seed **4** consenting shops in one
   band + one `detection_fired` each → driver writes **no** `peer_baselines` row
   for that `(detector, segment)` (A3 / k≥5).
2. `test_baseline_5_contributors_written` — seed **5** consenting shops in one band
   → one row written, `n == 5`, quartiles correct (A3 boundary).
3. `test_nonconsenting_shop_absent_from_baseline` — 5 consenting + 2 non-consenting
   (with wildly different `dollar_impact`) → `n == 5`, quartiles reflect ONLY the
   consenting cohort; the non-consenting impacts never move `p50` (A2).
4. `test_projection_writes_only_pseudonyms` — after projection, assert **no**
   `moat.event_log` row's `pseudonym_id` equals any seeded raw `shop_id`, and every
   `pseudonym_id` equals `pseudonym_for(shop_id, pepper)` for a consenting shop
   (A1).
5. `test_nonconsenting_alerts_not_projected` — a non-consenting shop's alerts
   produce **zero** projected `event_log` rows (A2 at the projection boundary).

**Behaviour tests:**
6. `test_projection_idempotent_on_rerun` — run the projection twice for the same
   `day_bucket` → event_log has exactly one row set for that day (no doubling);
   the pre-existing seed rows (no `day_bucket` in payload) are untouched.
7. `test_segment_for_shop_band_thresholds` — pure-function table test of
   `segment_for_shop` at each band boundary (0 → micro, 9_999_99c → micro,
   10_000_00c → small, 250_000_00c → large, 1_000_000_00c → xl).
8. `test_incident_extracted_for_confirmed_loss` — a consenting shop's
   confirmed-loss alert → one `incident_library` row.
9. `test_incident_dedup_skips_second` — same signature twice → second call inserts
   nothing.
10. `test_nonconsenting_confirmed_loss_skipped` — a non-consenting shop's
    confirmed loss → no library row (A2 on incidents).
11. `test_etl_report_counts` — `run_peer_incident_etl` returns an `EtlReport` whose
    counts match the seeded fixture (observability / no silent partial success).

## 10. Open questions / conflicts with the umbrella

1. **Segment was an umbrella open item — RESOLVED here as GMV band** (`"gmv:<band>"`,
   §3). The orchestrator should confirm it is happy with revenue-scale cohorting as
   the v1 definition of "similar shops" (the only PII-free, shop-level,
   recomputable signal available; `shops` carries no category/region/GMV column).
2. **"Reuse `emit_moat_event`" — DONE, literally** (§4). The only nuance: because
   `detection_fired ∈ ALWAYS_EMIT_KINDS`, #5 applies the consent filter in the
   driver SQL (the emitter would not gate it). No conflict; flagged for visibility.
3. **"Reuse `compute_peer_baselines`" — PARTIAL CONFLICT (the one real seam issue).**
   The fixed kernel groups by **detector only** and treats `segment` as an opaque
   storage label; it cannot produce *per-segment* quartiles (it would write the
   same all-shops quartiles under every band label). To deliver true per-segment
   baselines without modifying the fixed kernel, #5 ships an **additive**
   `compute_peer_baselines_by_segment` that reuses the kernel's exact SQL shape +
   `K_FLOOR` + upsert but adds a `payload->>'segment' = $segment` filter (and the
   projection writes `segment` into the payload). `consent_purge.py` keeps calling
   the original kernel. **Orchestrator decision needed:** accept the additive
   segment-aware function (recommended — preserves the fixed kernel, satisfies
   A1/A2/A3 and "peers = similar shops"), OR amend the umbrella to let #5 add a
   `segment` parameter/column path into the kernel itself. Until told otherwise,
   #5's plan implements the additive function.
4. **`consent_purge.py` segment re-derivation.** The purge re-runs the *original*
   `compute_peer_baselines` (detector-only). With per-segment baselines now keyed by
   GMV band, the purge's "re-run every `(detector, segment)` the shop touched"
   should call the **segment-aware** function for correctness post-purge. #5 does
   **not** modify `consent_purge.py` (out of scope), but flags that a follow-up
   (likely folded into #3 or a #5 footnote) must point the purge at the
   segment-aware aggregate, else a withdrawn shop's contribution could linger in a
   band baseline. Recorded as a known gap, not silently shipped (rule 12).
