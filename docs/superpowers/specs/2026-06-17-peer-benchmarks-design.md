# Peer Benchmarks — "your store vs. your niche" (Design Spec)

**Date:** 2026-06-17
**Status:** Approved design (brainstorming). Next: writing-plans → TDD.
**Builds on:** the Plan 05 moat (cross-tenant learning) layer — reuses its
pseudonymization, consent gate, k≥5 floor, and nightly `/cron/moat-train` job.

## 1. Goal

Show a merchant how their store's key business metrics compare to **other stores
in their niche**, using only anonymized, consented, k-anonymous peer data. Ships
on **both surfaces** (Shopify embedded admin `app.*` via Polaris; Calderyn
dashboard `dashboard.*` via its own primitives) — same data contract, native UI.

## 2. Niche (the peer cohort)

A store's niche = its **dominant `sku_dim.category` by trailing-90-day GMV**,
rendered as `segment = "cat:<category>"` (e.g. `cat:electronics` — the shape
already seeded in prod). Derived nightly.

- New resolver (engine, Python), sibling to `gmv_band_for_shop`:
  `async def category_niche_for_shop(conn, shop_id, run_date) -> str` →
  `"cat:<category>"`. Picks the category with the highest summed GMV over
  `[run_date-90d, run_date]` from the store's SKUs (`sku_dim.category` joined to
  sales). Ties broken alphabetically (deterministic — required by the moat's
  re-aggregation/purge paths). No qualifying sales → `"cat:uncategorized"`
  (never contributes to a published baseline because it won't reach k≥5 in a
  meaningful niche, and is excluded from the merchant UI).

This is a **separate** segmentation from the detector-threshold baselines
(`moat.peer_baselines`, which stay on `gmv:<band>` — size-based threshold tuning
is correct by size). Merchant-facing benchmarks use category niche. Two tables,
two purposes; deliberate.

## 3. KPIs (v1)

Four recognizable metrics, each defined by an **existing view** so the nightly
aggregate (Python) and the read-time "your value" (TS) compute the SAME number
(the view is the shared definition):

| `metric_key` | Meaning | Source view | Unit |
|---|---|---|---|
| `aov` | Average order value | `v_sku_sales_30d` / `order_fact` | USD |
| `return_rate` | 30-day return rate | `v_sku_returns_30d` | ratio 0–1 |
| `gross_margin_pct` | Gross margin % | `sku_pnl` | ratio 0–1 |
| `ship_cost_pct` | True ship cost ÷ revenue | `v_order_ship_features` | ratio 0–1 |

Each KPI resolves to one scalar per store per run. Exact SELECT per KPI is pinned
in the implementation plan (one query each, reused by both languages via the view).

## 4. Data model

New table `moat.peer_metric_baselines` — same privacy shape as
`moat.peer_baselines`, keyed by KPI instead of detector:

```
moat.peer_metric_baselines (
  metric_key   text    not null,   -- e.g. 'aov'
  segment      text    not null,   -- e.g. 'cat:electronics'
  p25          numeric not null,
  p50          numeric not null,
  p75          numeric not null,
  n            integer not null,   -- distinct consenting contributors, always >= 5
  computed_at  timestamptz not null default now(),
  primary key (metric_key, segment)
)
```
Migration goes in `supabase/migrations/` (this is a new prod table — unlike the
moat schema, we codify it properly) AND in `tests/engine/schema/migrations/`
(test-DB parity).

## 5. Architecture

**Write path (nightly, Python — reuses the moat machinery).** A new aggregate
module `engine/calderyn_engine/moat/peer_metrics_etl.py`:
- For each **consenting** shop (`peer_data_consent = true`): compute its 4 KPI
  scalars (from the views) + its niche (`category_niche_for_shop`), pseudonymize
  (`pseudonym_for`).
- Aggregate per `(metric_key, segment)`: publish `p25/p50/p75` only when
  `count(distinct pseudonym) >= K_FLOOR (=5)`; **delete** any `(metric_key,
  segment)` row that drops below the floor (same delete-stale rule the GDPR purge
  uses).
- Invoked from the existing nightly job: `run_peer_incident_etl` /
  `/api/engine/moat-train` gains a `run_peer_metrics(conn, run_date)` step so the
  whole thing stays one cron. Consent-purge (`consent_purge.py`) also re-runs this
  aggregate so a withdrawn shop is removed from metric baselines too (GDPR).

**Read path (request time, TS — both surfaces).** New server lib
`app/lib/benchmarks/peer-benchmarks.server.ts`:
`getPeerBenchmarks(shopId) -> { niche, consented, kpis: PeerKpi[] }` where
`PeerKpi = { metric_key, label, unit, your_value, p25, p50, p75, n, percentile, available }`.
- `your_value` = the requesting shop's current KPI (from the same views).
- peer `p25/p50/p75/n` read from `moat.peer_metric_baselines` for the shop's niche.
- `percentile` = the shop's approximate standing within the peer band (piecewise
  from the quartiles).
- `available = consented && n >= 5`; otherwise peer fields are null and the UI
  shows an empty/opt-in state (your_value still shows — it's the shop's own data).

**UI (both surfaces, dashboard parity).** A "Peer Benchmarks" card:
- `app.routes/app.*`: Polaris primitives (`Card`, `ProgressBar`/range marker, `Badge`).
- `app.routes/dashboard.*`: the dashboard's own primitives (match the existing
  metric-card pattern; do NOT port Polaris JSX).
- Each KPI row: the store's value marked against the peer p25–p75 band + percentile.

## 6. Privacy invariants (inherited from the moat — unchanged)

- **A1** — peer aggregation reads only pseudonymized ids, never raw `shop_id`.
- **A2** — only `peer_data_consent = true` stores contribute.
- **A3** — k≥5 distinct contributors per `(metric_key, segment)`; else no row.
- The requesting store's OWN value is its own data (no gate); only the peer
  distribution is gated.

## 7. Empty states (prod ships dormant — 0 consenting shops today)

- **Not consented:** card shows the store's own values + an opt-in prompt
  ("Share anonymized metrics to see how you compare — unlocks at 5 peers").
- **Consented, niche < 5 peers:** "Benchmarks unlock when 5+ <category> stores
  opt in." (your_value still shown.)
- **No niche (uncategorized):** card hidden.

## 8. Build slices (TDD — each red→green, proven vs the test DB)

1. **Migration** — `moat.peer_metric_baselines` (prod + test-schema).
2. **Niche resolver** — `category_niche_for_shop` (pytest: dominant-category,
   tie-break, no-sales fallback).
3. **Metric aggregate** — `peer_metrics_etl` (pytest: k≥5 suppression, consent
   gating, delete-stale, per-(metric,niche) quartiles).
4. **Wire into nightly job + consent-purge** (pytest: one cron runs it; purge
   re-aggregates metrics).
5. **Read API** — `getPeerBenchmarks` (vitest: your_value, available gating,
   percentile, empty states).
6. **`app.*` Polaris card** (RTL/vitest).
7. **`dashboard.*` card** (RTL/vitest).

## 9. Non-goals (YAGNI)

- No new KPIs beyond the four (add later behind the same contract).
- No time-series/trend of the comparison (point-in-time vs current peers only).
- No re-segmenting the existing detector-threshold baselines to category.
- No merchant-tunable cohort (niche is derived, not chosen).
