# Design: Full Calderyn parity on Vercel with the new UI

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Repo:** `keyuchen1735-boop/calderyn-shopify-app` (this repo)

## Goal

Run the **full functionality** of the canonical monorepo
(`keyuchen1735-boop/Calderyn-Shopify`) on **Vercel**, surfaced through **this
repo's new Polaris UI**. Today this repo ships only the embedded UI, the TS
ingestion pipeline (backfill/transform), and a single TS detector
(`reorder_timing`). The monorepo additionally has a Python detector engine (12
detectors + a Claude ranking/narrative layer), three background workers
(Google ad-spend ingestion, GDPR sweep, action-retry), and a pg-boss queue —
all of which must come over.

## Locked decisions

1. **Scope:** full parity — all 12 detectors + Claude layer + Google ad-spend
   ingestion + GDPR sweep + action-retry.
2. **Engine runtime:** keep the **Python** engine, deployed as a Vercel Python
   Serverless Function (Fluid Compute). Reuse `apps/engine` near-verbatim
   rather than porting detector math to TS.
3. **Vercel plan:** **Pro** (multiple crons, sub-daily schedules, longer
   function durations).
4. **Repo home:** grow **this repo** (`calderyn-shopify-app`); retire the
   monorepo as the deployment source.

## Architecture

One repo, one Vercel Pro project, **two runtimes**:

- **Remix (TS)** — embedded Shopify UI, webhooks, auth, ingestion
  (backfill/transform), and all cron *orchestration*. (exists)
- **Python engine** — the 12 detectors + `claude_layer`, deployed as a Vercel
  Python Serverless Function at `api/engine/run.py`
  (`POST {shop_id}` → run pipeline → write alerts to Supabase → return alert
  IDs). The `calderyn_engine` package is copied in from `apps/engine`.

### Repo layout (target)

```
calderyn-shopify-app/
  app/                        # new UI + routes (keep)
  api/engine/run.py           # NEW Vercel Python fn  -> /api/engine/run
  api/requirements.txt        # NEW: anthropic, pydantic, structlog, psycopg/supabase
  engine/calderyn_engine/     # NEW: detectors, pipeline, runner, claude_layer,
                              #      alerts_repo, schemas, thresholds, config, db
  app/lib/ingest/...          # existing TS ingestion (backfill, transform)
  app/routes/
    cron.ingest.tsx           # exists: backfill + transform
    cron.detect.tsx           # NEW: drive engine per ready shop
    cron.google.tsx           # NEW: Google ad-spend ingestion
    cron.gdpr.tsx             # NEW: GDPR sweep
    cron.action-retry.tsx     # NEW: drain action retry table
  prisma/, supabase/          # keep
  vercel.json                 # crons + python function config
```

### Decision A — drop pg-boss and the `engine-shim` worker

In the monorepo the queue + shim existed only to bridge "web (Fly) → engine
(Fly)" across processes. On Vercel the cron *is* the trigger: `cron.detect`
iterates ready shops and directly `fetch()`es `/api/engine/run` per shop,
bounded per tick (the existing `MAX_BACKFILL_SHOPS` pattern in
`cron.ingest.tsx`). `engine-shim` is deleted; no separate queue for the
detection path.

### Decision B — the "queue" becomes Supabase tables drained by cron

Action-retry and GDPR work that needs durability uses Supabase tables
(`action_queue`, `gdpr_queue`) drained by their respective crons, **not**
Vercel Queues (still beta). The monorepo's queue was Postgres-backed anyway,
so this keeps a single datastore and avoids a beta dependency.

## Components & data flow

1. Shopify webhooks → `webhooks/*` → raw rows in Supabase. *(exists)*
2. `cron.ingest` → backfill shops + transform queued webhooks → facts.
   *(exists, TS)*
3. `cron.google` → pull Google Ads spend → facts. *(NEW, TS — port of
   `workers/google`)*
4. `cron.detect` → for each ready shop, `POST /api/engine/run` → Python loads
   facts from Supabase, runs 12 detectors, Claude re-ranks + narrates, writes
   alerts → Supabase. *(NEW orchestration + reused engine)*
5. New UI reads alerts/audit/campaigns/skus from Supabase. *(exists)*
6. Failed merchant actions → `action_queue` table → `cron.action-retry`
   drains. *(NEW, TS — port of `workers/action-retry`)*
7. GDPR webhooks → `gdpr_queue` table → `cron.gdpr` processes. *(NEW, TS —
   port of `workers/gdpr-sweep`)*

The 12 detectors: `ad_tax_overload`, `campaign_below_breakeven`, `cogs_drift`,
`margin_erosion`, `negative_unit_economics`, `regional_shortage_risk`,
`regional_spend_starved_stock`, `reorder_timing`, `return_rate_hidden_loss`,
`scaling_sku_fulfillment_risk`, `sku_stockout_vs_spend`,
`wrong_location_concentration`.

## Conflict resolved (rule 7)

`reorder_timing` exists in **both** TS
(`app/lib/ingest/detectors/reorder-timing.server.ts`) and Python
(`reorder_timing.py`). Once the Python engine is the detector home, the **TS
version and its test are deleted** so detectors have a single source of truth
and cannot double-write alerts. The TS *ingestion* (backfill/transform) stays
in Remix.

## Error handling & testing

- Per-shop and per-phase isolation (existing `cron.ingest` pattern) applies to
  `cron.detect`: one shop's detector failure must not deny other shops their
  alerts; failures land in the DLQ / run summary, never silently passing
  (rule 12).
- **Python:** bring over the engine's pytest suite (detectors + `claude_layer`
  output contract). **TS:** existing vitest for ingestion + new cron-handler
  tests (google mapper, retry drain, gdpr).
- Pre-commit gate gains a `pytest` step.
- **Add a GitHub Actions workflow** running both runtimes' tests on PRs — two
  languages make manual-only too fragile, and this closes the existing no-CI
  gap.

## Database is already provisioned

The shared Supabase project (`ajgrmnvzxfxxlwrxcgnu`) **already carries the full
engine schema**, applied from the monorepo side: `alerts`, `alert_context`,
`alert_thresholds`, all fact/dim tables (`order_fact`, `order_line_fact`,
`inventory_level_fact`, `ad_spend_fact`, `cogs_fact`, `sku_dim`, `sku_pnl`,
`sku_velocity`, `location_dim`, `stockout_forecast`, …), the action layer
(`action_audit`, `undo_token`, `action_idempotency`, `guardrail_config`,
`purchase_order_draft`), RLS enabled on every table, and the RLS helper
functions `current_shop_id()` / `set_current_shop_id()`. The `alerts` table
already holds output from all 12 detectors — the monorepo engine has run
against this DB. Therefore **no schema migration is needed**; the work is
compute (run the engine on Vercel), trigger (crons), and ingestion (workers).

The `moat_keys` / `moat_events` tables do **not** exist. `pipeline.py` imports
`calderyn_engine.moat.emitter` at load time, so the `moat/` sub-package and
`tracing.py` must be copied along, but they stay no-ops as long as
`MOAT_PEPPER` and OTel are unset.

## Config

The Python engine connects via a **direct Postgres connection** (asyncpg) using
`DATABASE_URL` set to the **Supabase connection-pooler URI** — it relies on RLS
(`set_config('app.shop_id', …)`), not the PostgREST service-role client the TS
side uses.

New env vars: `DATABASE_URL` (Supabase pooler, for the Python fn);
`ANTHROPIC_API_KEY` (Claude layer); `CLAUDE_MODEL` (optional, defaults in
`config.py`); `GOOGLE_ADS_*` (OAuth refresh token + developer token) for
ad-spend ingestion. `CRON_SECRET` already exists and guards every cron route.
Leave `MOAT_PEPPER` unset (moat stays a no-op). Update `.env.example` for each
new key.

`vercel.json` gains the Python function config and ~5 cron entries:

| Cron | Suggested schedule |
|---|---|
| `/cron/ingest` | every 30 min |
| `/cron/detect` | every 30 min (offset) |
| `/cron/google` | hourly |
| `/cron/action-retry` | every 15 min |
| `/cron/gdpr` | daily |

## Sequencing (slices)

1. Stand up the Python engine as a Vercel function with **one** detector
   end-to-end (proves cross-runtime path + Supabase write + Claude call).
2. Bring over the remaining 11 detectors + thresholds + the engine pytest suite.
3. `cron.detect` orchestration; delete the TS `reorder_timing` detector + test.
4. Google ad-spend ingestion (`cron.google`).
5. GDPR sweep + action-retry (`cron.gdpr`, `cron.action-retry`, queue tables).
6. Env/secrets, `vercel.json` crons, GitHub Actions CI, docs.

Each slice is independently shippable and testable.

## Out of scope

- Migrating the monorepo's `packages/` shared libs wholesale (only what the
  ported code needs comes over).
- Fly.io / Docker hosting (replaced by Vercel functions + crons).
- Changing the new UI's screens (they already cover alerts/audit/campaigns/
  skus/settings/onboarding).
