# Slice 1: Python Engine on Vercel (one shop, end-to-end) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo's Python detector engine as a Vercel Python Serverless Function that, when POSTed `{shop_id}` with the cron bearer token, runs the full detector pipeline against the existing Supabase DB and upserts alerts — proving the cross-runtime path end-to-end.

**Architecture:** Vendor `calderyn_engine` (from `keyuchen1735-boop/Calderyn-Shopify` `apps/engine`) into `api/engine/`. A thin Vercel handler (`api/engine/run.py`) authenticates with `CRON_SECRET`, parses `{shop_id}`, creates a short-lived asyncpg pool against the Supabase pooler, calls `run_for_shop(shop_id, pool=pool)`, and returns the upserted alert ids. No schema work — the shared DB already has every table, RLS function, and threshold row (verified 2026-06-01).

**Tech Stack:** Python 3.12 (Vercel Fluid Compute), asyncpg, anthropic, pydantic, structlog, python-dotenv; Remix/Vercel for hosting; Supabase Postgres (project `ajgrmnvzxfxxlwrxcgnu`).

**Spec:** `docs/superpowers/specs/2026-06-01-monorepo-parity-on-vercel-design.md`

---

## Preconditions (verified)

- DB already has `alerts`, `alert_context`, `alert_thresholds` (1 row), all fact/dim tables, and RLS functions `current_shop_id()` / `set_current_shop_id()`.
- `moat_keys`/`moat_events` tables do NOT exist → keep `MOAT_PEPPER` unset so `pipeline.py`'s moat emit stays a no-op.
- E2E test shop: `calderyn-shop-tester.myshopify.com` = `159c1a74-f242-4050-96de-53491a797628` (270 orders; already has 12 alerts → a successful run should bump `alerts.last_seen_at`, not necessarily add rows).

## File structure (this slice)

```
api/engine/
  run.py                     # Create: Vercel Python handler (HTTP -> _core)
  _core.py                   # Create: testable handle(body, authorization) -> (status, dict)
  requirements.txt           # Create: asyncpg, anthropic, pydantic, structlog, python-dotenv
  calderyn_engine/           # Create: vendored copy of apps/engine/calderyn_engine (whole package)
tests/engine/
  test_core.py               # Create: unit tests for _core.handle (pipeline mocked)
vercel.json                  # Modify: add Python function maxDuration; keep existing cron
.env.example                 # Modify: add DATABASE_URL, ANTHROPIC_API_KEY, CLAUDE_MODEL
```

> Co-locating `calderyn_engine/` inside `api/engine/` keeps it in the function bundle and on `sys.path` without editable-install gymnastics. `run.py` inserts its own dir on `sys.path` defensively.

---

### Task 1: Vendor the engine package

**Files:**
- Create: `api/engine/calderyn_engine/**` (copied)
- Create: `api/engine/requirements.txt`

- [ ] **Step 1: Copy the package from the monorepo**

From a clone of `keyuchen1735-boop/Calderyn-Shopify` at the repo root (or via `gh repo clone` into a temp dir), copy the whole package:

```bash
# from a sibling checkout of the monorepo
cp -R ../Calderyn-Shopify/apps/engine/calderyn_engine api/engine/calderyn_engine
# remove the dev-only FastAPI surface; Vercel provides the HTTP layer
rm -f api/engine/calderyn_engine/http.py
```

Keep everything else, including `moat/` and `tracing.py` (imported at module load by `pipeline.py`).

- [ ] **Step 2: Pin runtime deps (drop fastapi/uvicorn/psycopg — unused at runtime)**

Create `api/engine/requirements.txt`:

```
asyncpg>=0.29
anthropic>=0.25
pydantic>=2.6
structlog>=24
python-dotenv>=1.0
```

- [ ] **Step 3: Verify the package imports without a DB**

Run:
```bash
cd api/engine && python -c "import calderyn_engine.pipeline as p; print(sorted(__import__('calderyn_engine.detectors', fromlist=['DETECTOR_REGISTRY']).DETECTOR_REGISTRY.keys()))"
```
Expected: a list of 12 detector ids printed, no ImportError. (This confirms `moat/` and `tracing.py` import cleanly with no OTel SDK and no DB.)

- [ ] **Step 4: Commit**

```bash
git add api/engine/calderyn_engine api/engine/requirements.txt
git commit -m "feat(engine): vendor calderyn_engine package for Vercel python fn"
```

---

### Task 2: Testable core handler

**Files:**
- Create: `api/engine/_core.py`
- Test: `tests/engine/test_core.py`

- [ ] **Step 1: Write the failing test**

`tests/engine/test_core.py`:

```python
import asyncio
import pytest
from api.engine import _core


def _run(body, auth, monkeypatch, fake_ids=("a1", "a2"), secret="s3cret"):
    monkeypatch.setenv("CRON_SECRET", secret)
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")

    async def fake_run_for_shop(shop_id, **kwargs):
        fake_run_for_shop.called_with = (shop_id, kwargs)
        return list(fake_ids)

    # pool factory must not touch a real DB in unit tests
    class _FakePool:
        async def close(self):
            pass

    async def fake_make_pool(url, **kwargs):
        return _FakePool()

    monkeypatch.setattr(_core, "run_for_shop", fake_run_for_shop)
    monkeypatch.setattr(_core, "make_pool", fake_make_pool)
    return asyncio.run(_core.handle(body, auth))


def test_rejects_missing_auth(monkeypatch):
    status, payload = _run({"shop_id": "x"}, None, monkeypatch)
    assert status == 401


def test_rejects_wrong_auth(monkeypatch):
    status, payload = _run({"shop_id": "x"}, "Bearer nope", monkeypatch)
    assert status == 401


def test_rejects_missing_shop_id(monkeypatch):
    status, payload = _run({}, "Bearer s3cret", monkeypatch)
    assert status == 400


def test_runs_pipeline_and_returns_ids(monkeypatch):
    status, payload = _run({"shop_id": "shop-1"}, "Bearer s3cret", monkeypatch)
    assert status == 200
    assert payload == {"shop_id": "shop-1", "alert_ids": ["a1", "a2"]}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/engine/test_core.py -v`
Expected: FAIL — `ModuleNotFoundError: api.engine._core` (or `handle` undefined).

- [ ] **Step 3: Write the minimal implementation**

`api/engine/_core.py`:

```python
"""Transport-agnostic core for the engine Vercel function.

Kept separate from run.py so the auth gate + pipeline invocation are unit
testable without spinning up an HTTP server. The handler in run.py is a
thin adapter over handle().
"""
from __future__ import annotations

import os
import sys
from typing import Any

# Ensure the vendored package (sibling dir) is importable when Vercel loads
# this file as a standalone function.
sys.path.insert(0, os.path.dirname(__file__))

from calderyn_engine.config import load_config  # noqa: E402
from calderyn_engine.db import make_pool  # noqa: E402
from calderyn_engine.pipeline import run_for_shop  # noqa: E402


def _authorized(authorization: str | None) -> bool:
    secret = os.environ.get("CRON_SECRET")
    return bool(secret) and authorization == f"Bearer {secret}"


async def handle(
    body: dict[str, Any], authorization: str | None
) -> tuple[int, dict[str, Any]]:
    """Run the detector pipeline for one shop. Returns (status, json-body)."""
    if not _authorized(authorization):
        return 401, {"error": "unauthorized"}

    shop_id = (body or {}).get("shop_id")
    if not shop_id or not isinstance(shop_id, str):
        return 400, {"error": "shop_id is required"}

    cfg = load_config()
    # Fresh pool per invocation: asyncpg pools bind to the event loop, and a
    # serverless invocation gets a fresh loop, so a cached cross-loop pool
    # would error. Short-lived pool, closed in finally.
    pool = await make_pool(cfg.database_url, max_size=4)
    try:
        ids = await run_for_shop(shop_id, cfg=cfg, pool=pool)
    finally:
        await pool.close()
    return 200, {"shop_id": shop_id, "alert_ids": ids}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/engine/test_core.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add api/engine/_core.py tests/engine/test_core.py
git commit -m "feat(engine): testable core handle() with auth gate + per-invocation pool"
```

---

### Task 3: Vercel HTTP handler

**Files:**
- Create: `api/engine/run.py`

- [ ] **Step 1: Write the handler (thin adapter over _core.handle)**

`api/engine/run.py`:

```python
"""Vercel Python Serverless Function: POST /api/engine/run.

Body: {"shop_id": "<uuid>"}; requires `Authorization: Bearer $CRON_SECRET`.
Delegates all logic to _core.handle so it stays unit-testable.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))

from _core import handle  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - Vercel/BaseHTTPRequestHandler API
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return
        authorization = self.headers.get("authorization")
        status, payload = asyncio.run(handle(body, authorization))
        self._send(status, payload)

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
```

- [ ] **Step 2: Verify it imports**

Run: `cd api/engine && python -c "import run; print('ok')"`
Expected: prints `ok` (no import errors).

- [ ] **Step 3: Commit**

```bash
git add api/engine/run.py
git commit -m "feat(engine): /api/engine/run Vercel python handler"
```

---

### Task 4: Local end-to-end against the live Supabase DB

This proves DB connectivity + RLS + detectors + Claude before involving Vercel.

**Files:** none (verification + env).

- [ ] **Step 1: Get the Supabase connection string**

In the Supabase dashboard → Project Settings → Database → Connection string → **Session pooler** (port 5432, supports prepared statements which asyncpg uses). Export locally (do NOT commit):

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
export ANTHROPIC_API_KEY='sk-ant-...'   # real key; Claude layer falls back deterministically if calls fail
# leave MOAT_PEPPER unset
```

- [ ] **Step 2: Run the engine CLI for the test shop**

Run:
```bash
cd api/engine && python -m calderyn_engine run --shop 159c1a74-f242-4050-96de-53491a797628
```
Expected: stderr `upserted N alert(s)`; stdout lists N alert UUIDs; exit 0.

> If this fails with `prepared statement` / `pgbouncer` errors, you're on the transaction pooler (6543). Switch `DATABASE_URL` to the session pooler (5432) as in Step 1. This is the one known cross-runtime gotcha.

- [ ] **Step 3: Confirm the write landed**

Run (via Supabase SQL editor or psql):
```sql
select detector_id, severity, claude_rank, last_seen_at
from alerts
where shop_id = '159c1a74-f242-4050-96de-53491a797628'
order by last_seen_at desc limit 12;
```
Expected: `last_seen_at` timestamps are within the last few minutes (the upsert refreshed them).

- [ ] **Step 4: Update `.env.example`**

Add (no secrets, just keys):
```
# Python detector engine (Vercel python fn /api/engine/run)
DATABASE_URL=
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-opus-4-7
```

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "docs(env): document engine DATABASE_URL/ANTHROPIC_API_KEY/CLAUDE_MODEL"
```

---

### Task 5: Deploy to Vercel and invoke the function

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Give the Python function headroom**

Edit `vercel.json` to add a `functions` block (keep `framework`, `buildCommand`, `installCommand`, `regions`, and the existing `crons` exactly as they are):

```json
{
  "framework": "remix",
  "buildCommand": "npm run build",
  "installCommand": "npm install && npx prisma generate",
  "regions": ["iad1"],
  "functions": {
    "api/engine/run.py": { "maxDuration": 300 }
  },
  "crons": [{ "path": "/cron/ingest", "schedule": "0 6 * * *" }]
}
```

- [ ] **Step 2: Set production env vars on Vercel**

Run (values pulled from Task 4; use the session-pooler URI):
```bash
vercel env add DATABASE_URL production
vercel env add ANTHROPIC_API_KEY production
vercel env add CLAUDE_MODEL production   # optional; defaults in config.py
# CRON_SECRET should already exist; confirm:
vercel env ls | grep -i cron_secret
```

- [ ] **Step 3: Deploy a preview**

Run: `vercel deploy`
Expected: build succeeds; the build log shows `api/engine/run.py` detected as a Python function and `api/engine/requirements.txt` installed.

- [ ] **Step 4: Invoke the deployed function**

Run (substitute the preview URL and the real CRON_SECRET):
```bash
curl -sS -X POST "https://<preview-url>/api/engine/run" \
  -H "authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"shop_id":"159c1a74-f242-4050-96de-53491a797628"}'
```
Expected: HTTP 200 JSON `{"shop_id":"159c1a74-...","alert_ids":[...]}` with a non-empty list.

- [ ] **Step 5: Confirm unauthorized is rejected**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<preview-url>/api/engine/run" -d '{"shop_id":"x"}'
```
Expected: `401`.

- [ ] **Step 6: Confirm the write landed (same query as Task 4 Step 3)** — `last_seen_at` refreshed again.

- [ ] **Step 7: Commit**

```bash
git add vercel.json
git commit -m "chore(vercel): register api/engine/run python function (maxDuration 300)"
```

---

## Definition of done (Slice 1)

- `python -m pytest tests/engine/test_core.py` → all pass.
- Local CLI run against shop `159c1a74-…` upserts alerts (exit 0).
- Deployed `/api/engine/run` returns 200 + alert ids with the bearer token, 401 without.
- `alerts.last_seen_at` for the test shop refreshed by the deployed call.
- `vercel.json`, `.env.example`, vendored package, handler, and tests committed.

## Self-review notes

- **Spec coverage:** implements spec §Architecture (Python fn at `api/engine/run.py`), §"Database is already provisioned" (no migrations), §Config (direct `DATABASE_URL` pooler, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `MOAT_PEPPER` unset), and the first sequencing slice. Decision A (cron→HTTP, no pg-boss) is exercised by the curl invoke; the cron wiring itself is Slice 3.
- **Known risk surfaced, not hidden (rule 12):** asyncpg + Supabase transaction-pooler prepared-statement incompatibility — mitigated by using the session pooler, called out in Task 4 Step 2.
- **Types consistent:** `handle(body, authorization) -> (int, dict)` used identically in `_core.py`, `run.py`, and `test_core.py`; `run_for_shop(shop_id, cfg=, pool=)` matches the vendored `pipeline.run_for_shop` signature.
- **No placeholders:** every step has real commands/code and a concrete test shop id.

## Not in this slice (future plans)

- Slice 2: bring over the engine pytest suite + run all 12 detectors under CI.
- Slice 3: `cron.detect` orchestration (iterate ready shops → POST `/api/engine/run`), delete TS `reorder-timing.server.ts`.
- Slice 4: Google ad-spend ingestion. Slice 5: GDPR + action-retry. Slice 6: env/secrets/CI/docs.
