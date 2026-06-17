# Moat Train Cron — Spec (Slice #4)

> **Status:** Draft spec for slice #4 of the Moat Loop Closure effort.
> Builds against the FIXED umbrella contract:
> `docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md`.
> This slice MUST NOT contradict the umbrella. Any divergence is raised as an
> open question back to the orchestrator (see §9), not unilaterally taken.

**Date:** 2026-06-16
**Slice:** #4 — `train-cron`
**Owns:** `/cron/moat-train` Remix route + its `vercel.json` `crons` entry; nightly
schedule; `CRON_SECRET` auth; overlap/idempotency protection; fail-visible
observability.
**Consumes (seam):** the slice-#3 trainer entrypoint (Python engine).
**Produces (seam):** a scheduled, authed, observable trigger of one full trainer run.

---

## 1. Problem

The moat loop (umbrella §3) is closed only if the **derive → train → write** pass
runs on a schedule. Today there is no scheduler for it: `compute_reward`,
`update_threshold`, `compute_peer_baselines`, and `extract_incident` are pure
kernels called only by tests (umbrella §1, TRAIN bullet). Slice #3 builds the
trainer that wires those kernels into a per-shop run that upserts
`moat.detection_models`. **Slice #4 is the alarm clock for #3** — nothing more.

This slice does NOT define what the trainer does internally. It defines *when* and
*how* the trainer is invoked, *who* is allowed to invoke it (`CRON_SECRET`), what
happens when a run *overlaps* a still-running prior run, and how a trainer failure
is *surfaced* rather than swallowed (repo rule 12 — fail visibly).

## 2. Scope

**In scope**

- A new Remix route `app/routes/cron.moat-train.tsx` exposing a `loader`
  (`GET`) — the convention every existing `/cron/*` route uses (`cron.detect`,
  `cron.autopilot`, `cron.gdpr`, …). Vercel cron issues a `GET` to the path.
- `CRON_SECRET` bearer auth via the shared `isAuthorizedCron` helper
  (`app/lib/cron-auth.server.ts`) — reject (401) any request without the exact
  bearer secret; fail closed when `CRON_SECRET` is unset.
- One nightly `vercel.json` `crons` entry for `/cron/moat-train`.
- Invocation of the slice-#3 trainer over HTTP, using the **same mechanism the
  detect cron uses to reach the Python engine** (umbrella §5 "Cron convention").
- Overlap / idempotency protection so a slow or retried nightly run does not
  double-train (§6).
- Structured logging (per-run + per-shop counts, durations) and fail-visible
  error handling: surface trainer failures in both the JSON response and logs;
  return a **non-200** when the run could not complete or any shop was skipped /
  errored without being trained (§5, §7).

**Out of scope (other slices / explicit non-goals)**

- The trainer's internals — reward grouping, prior seeding, `update_threshold`,
  the `detection_models` upsert. That is **slice #3**. This slice only triggers it.
- The reward-derivation read model (#2), the peer/incident ETL (#5), and the
  detector consume path (#6).
- New moat **table** schema for the model/baseline tables (all exist — umbrella §8).
  This slice MAY add a *minimal* run-row table for overlap protection if the chosen
  lock strategy needs one (§6); that is the only schema this slice may introduce,
  and it codifies a scheduler concern, not a moat-domain concern.
- Dashboard parity: a cron is pure infra/internal plumbing not visible to
  merchants (CLAUDE.md "Dashboard parity" exempts "auth glue, webhook plumbing not
  visible to users"; an unattended nightly job is the same class). **No dashboard
  mirror is required for this slice.** Stated explicitly per the "never silently
  ship single-sided" rule.

## 3. The cron → Python-engine invocation pattern (copied from `cron.detect`)

The detect cron (`app/routes/cron.detect.tsx`) reaches the Python engine like this,
and slice #4 MUST mirror it:

1. **Auth gate first.**
   `if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) return 401`.
2. **Resolve the public origin.**
   `const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;`
   Vercel cron invokes the route on the `*.vercel.app` deployment URL, which
   deployment protection walls off from a self-fetch — so engine calls must go out
   through the **public app origin** (`SHOPIFY_APP_URL`), falling back to the
   request origin in local dev where `SHOPIFY_APP_URL` is unset.
3. **HTTP `fetch` to the engine** with the secret as a bearer:
   ```ts
   const res = await fetch(`${origin}${ENGINE_PATH}`, {
     method: "POST",
     headers: {
       authorization: `Bearer ${process.env.CRON_SECRET}`,
       "content-type": "application/json",
     },
     body: JSON.stringify({ /* trainer payload */ }),
   });
   ```
4. **Check `res.ok`; surface non-OK as an error** rather than swallowing it.

**URL-collision rule (the 501 outage — commit `551dabf`, 2026-06-16).** A Remix
route and a Python serverless function must NEVER share a URL: a Remix route at
`/api/engine/run` compiles to the same Vercel build-output function dir
(`api/engine/run.func`) as the Python function and drops the Node bundle, 501-ing
every route. Therefore:

- The **scheduler** lives at `/cron/moat-train` (a Remix route — distinct from any
  `/api/engine/*` path).
- The **trainer** (#3, Python) is reached at a Python-function path **under
  `/api/engine/`** that the trainer owns exclusively, exactly as `run.py` owns
  `/api/engine/run`. This slice assumes that path is **`/api/engine/moat-train`**
  (§4, §9). The cron route never *is* the Python function; it *calls* it over HTTP.

This is the identical shape the detect cron uses to drive `/api/engine/run` and
`/api/detectors/run`.

## 4. The trainer entrypoint contract this slice ASSUMES from #3 (the seam)

> **This is the integration seam.** Slice #4 does not define the trainer; it
> defines the contract it *expects* so the orchestrator can reconcile it with
> slice #3's actual entrypoint (§9, open question OQ-1).

**Assumed entrypoint:** a Python serverless function reachable at
**`POST /api/engine/moat-train`**, modeled on `api/engine/run.py` + `engine/_core.py`:

- **Auth:** `Authorization: Bearer ${CRON_SECRET}` (same gate as `run.py`'s
  `_core._authorized` — `hmac.compare_digest(authorization, f"Bearer {secret}")`).
  Returns `401 {"error": "unauthorized"}` without it.
- **Request body:** `{}` (empty object) for a full nightly run over all eligible
  shops. The function discovers its own work set (eligible/consenting shops) — the
  cron does NOT enumerate shops. (Rationale: the umbrella's empirical-Bayes seeding
  and k≥5 floor are cross-tenant aggregates the trainer owns; the cron should not
  reach into moat internals to build a shop list. Contrast `cron.detect`, which
  *does* batch per-shop because detection is embarrassingly per-shop; training has
  a cross-tenant prior step that wants the whole cohort in one pass.)
- **Success response (HTTP 200):**
  ```json
  {
    "shops_trained": 0,
    "models_written": 0,
    "errors": []
  }
  ```
  - `shops_trained` (int): shops for which training completed and at least the
    attempt to upsert a model row ran to completion.
  - `models_written` (int): `moat.detection_models` rows upserted this run.
  - `errors` (string[]): one entry per shop (or sub-step) that was **skipped or
    failed** — e.g. `"<shop_id_or_pseudonym>: <reason>"`. **Non-empty `errors`
    means the run was partial** and the cron MUST treat it as a fail-visible
    condition (§7), even if the HTTP status is 200.
- **Failure response:** any non-2xx HTTP status, or a 200 with a non-empty
  `errors[]`. Both are surfaced by the cron (§7).

**If #3's actual entrypoint differs** (different path, a `mode` field on
`/api/engine/run` instead of a dedicated function, or different response keys),
that is the integration seam the orchestrator reconciles. This spec's contract is
the **assumption**, flagged in §9 (OQ-1). The cron's response-shaping logic
(§5) depends only on the three response keys above; if #3 renames them, only the
key references in `cron.moat-train.tsx` change.

## 5. The `/cron/moat-train` route — behavior

```
GET /cron/moat-train
  Authorization: Bearer <CRON_SECRET>      (issued by Vercel cron)
```

1. **Auth.** `isAuthorizedCron(authHeader, CRON_SECRET)` → else `401 "Unauthorized"`.
   (Identical to every existing cron route.)
2. **Overlap guard (§6).** Attempt to acquire the run lock. If a prior run still
   holds it, **do not invoke the trainer**; return `200` with
   `{ ok: true, skipped: "locked", ... }` and log a structured "skipped: already
   running" line. (A skipped-because-locked tick is a *success* for the scheduler —
   it correctly declined to double-train — so it is 200, not an error. This is
   distinct from a trainer *failure*, which is non-200, §7.)
3. **Invoke the trainer** over HTTP per §3 / §4:
   `POST ${origin}/api/engine/moat-train` with `Authorization: Bearer
   ${CRON_SECRET}`, body `{}`.
4. **Shape the response + surface failures (§7).**
   - On non-OK HTTP: log the status + body, release the lock, return a **non-200**
     (`502`) with `{ ok: false, error: "trainer HTTP <status>", ... }`.
   - On OK: parse `{ shops_trained, models_written, errors }`. If `errors` is
     non-empty, return a **non-200** (`207`-style is not used by this codebase;
     use `500`) with the full body so the partial run is visible; else return
     `200` with the body.
5. **Always release the lock** (success or failure) in a `finally`-equivalent so a
   crashed run cannot wedge the lock forever (§6 also specifies a TTL/timeout
   fallback).

**Response body (success):**
```json
{ "ok": true, "shops_trained": 12, "models_written": 31, "errors": [], "duration_ms": 4210 }
```
**Response body (partial / failure):**
```json
{ "ok": false, "shops_trained": 9, "models_written": 20,
  "errors": ["<pseudonym>: peer baseline below k=5"], "duration_ms": 5120 }
```
(HTTP 500 for partial, 502 for transport failure, 401 for auth.)

**Structured logging (stdout — Vercel captures it; matches `console.error`
idiom in `cron.detect`/`cron.autopilot`):**
- One start line: `[cron.moat-train] start origin=<origin>`.
- On lock skip: `[cron.moat-train] skipped: already running`.
- One summary line on completion:
  `[cron.moat-train] done shops_trained=<n> models_written=<n> errors=<n> duration_ms=<n>`.
- One `console.error` per failure path (transport error, partial run), echoing the
  trainer's `errors[]` so per-shop skips appear in logs, not just the response.

## 6. Overlap / idempotency protection

**Requirement:** Vercel cron does not guarantee non-overlap; a slow run plus the
next tick (or a Vercel retry on a timed-out invocation) could start two trainer
passes that both upsert `moat.detection_models`. The trainer's upsert is itself
idempotent by PK `(detector_id, shop_id_pseudonym)` (umbrella §5), so a double run
is *correctness-safe* but wasteful (double DB load, double engine compute) and can
interleave a half-written cohort. We add a **minimal mutual-exclusion lock** so a
second concurrent invocation no-ops cleanly.

**Chosen mechanism: a Postgres advisory lock taken inside the trainer call path,
surfaced to the cron as a `skipped: "locked"` outcome — implemented as a
single-row run-lock table the cron checks/sets, NOT a long-held session lock.**

Rationale and the two candidates considered:

- **(A) `pg_advisory_lock` / `pg_try_advisory_lock`** — classic, zero schema. But
  a Postgres *session* advisory lock is held only for the life of the DB session;
  the cron route and the Python trainer use **different** DB connections (the cron
  has no DB session of its own — it only does HTTP), and serverless pools are
  short-lived, so a session lock taken by the cron would not span the trainer call.
  Rejected for the cron layer.
- **(B) A `moat.train_run` run-row table** with a single logical lock row
  (`lock_key text PK`, `locked_at timestamptz`, `expires_at timestamptz`, plus
  last-result columns). The cron does a conditional `UPDATE … SET locked_at=now(),
  expires_at=now()+interval '20 min' WHERE lock_key='moat-train' AND (locked_at IS
  NULL OR expires_at < now())` and treats **rows-affected = 1** as "acquired",
  **0** as "already running → skip". On completion it clears the lock
  (`locked_at = NULL`) and writes the last result. The `expires_at` TTL is the
  crash-recovery fallback so a died-mid-run process self-heals after 20 min
  (> trainer max duration, which is bounded by the engine function's
  `maxDuration: 300` = 5 min; 20 min is a safe ceiling).

**This slice specifies (B)** — it is the minimal, connection-independent lock that
works across the cron's HTTP boundary and survives a crash. The run-row also gives
free observability (last run's counts/timestamp) for Phase B verification
(umbrella §7).

**Idempotency of the underlying write** is the trainer's responsibility (#3 upserts
by PK). This slice only prevents *concurrent* double-runs; it does not need to make
the trainer itself idempotent.

> **Seam note (OQ-2):** whether the lock lives in the cron (table check) or inside
> the trainer (the trainer takes a `pg_try_advisory_lock` and returns
> `skipped: "locked"` in its response) is an integration choice. This spec puts it
> in the **cron** (run-row table) so it works even if #3's trainer is a black-box
> HTTP endpoint with no lock of its own. If #3 already implements its own
> single-flight guard, the cron's lock becomes a redundant outer guard (harmless)
> or can be dropped — flagged for reconciliation.

## 7. Fail-visible error handling (repo rule 12)

Never report success when shops were skipped. Concretely:

- **Auth failure** → `401`, no trainer call.
- **Transport failure** (trainer endpoint non-OK, network error, timeout) →
  `502`, `{ ok: false, error: "trainer HTTP <status>" | "<message>" }`, a
  `console.error`, and the lock released.
- **Partial run** (trainer 200 but `errors[]` non-empty) → `500` with the full
  body including `errors[]`, plus a `console.error` echoing each error. The
  scheduler is NOT allowed to return 200 here — a partial cohort train is a
  visible failure even though some shops succeeded.
- **Clean run** (`errors[]` empty) → `200` with counts.
- **Locked / skipped** → `200 { ok: true, skipped: "locked" }` (a correct decline,
  not a failure).

The `errors[]` array is passed through verbatim from the trainer so the *reason*
each shop was skipped (e.g. "peer baseline below k=5", "no feedback rows") is
visible in both the HTTP response and the logs.

## 8. The `vercel.json` entry

Add to the `crons` array:

```json
{ "path": "/cron/moat-train", "schedule": "0 3 * * *" }
```

**Schedule rationale (`0 3 * * *` — 03:00 UTC daily):**

- **Nightly**, off-peak (the umbrella calls for a nightly trainer, §3).
- **After ingest + detect have settled.** `cron/ingest` runs `*/30 * * * *` and
  `cron/detect` runs `15,45 * * * *` — both fire within the hour before 03:00, so
  by 03:00 the freshest `alerts` / `alert_feedback` / `action_audit` rows the
  trainer reads (umbrella §3) are in place. Training on the *prior* day's settled
  feedback is the intent.
- **Off the 04:00 cluster.** `cron/gdpr` and `cron/mcp-oauth-cleanup` both run
  `0 4 * * *`; `cron/ingest-quickbooks` runs `0 5 * * *`. Putting moat-train at
  03:00 keeps it clear of that 04:00–05:00 maintenance window and clear of the
  top-of-hour `ingest-ads`/`autopilot` ticks' heaviest overlap.
- **Single daily fire** (not `*/N`) — training is a once-a-day batch; the lock
  (§6) only guards the rare slow-run-meets-retry case, not routine cadence.

(Vercel maps `/cron/<name>` → the Remix route `app/routes/cron.<name>.tsx`, the
same mapping every existing entry uses — confirmed against `cron.detect`,
`cron.github-digest`, etc.)

## 9. Open questions / seams to reconcile with the orchestrator

- **OQ-1 (trainer entrypoint — the primary seam).** This spec assumes #3 exposes
  `POST /api/engine/moat-train` (a Python serverless function mirroring `run.py`,
  body `{}`, returning `{shops_trained, models_written, errors[]}`). #3's plan may
  instead (a) extend `engine/_core.handle` to dispatch on a `mode` field of
  `/api/engine/run`, or (b) name the path / response keys differently. The cron's
  `ENGINE_PATH` constant and the three response-key references are the only things
  that change on reconciliation. **Flagged: confirm #3's real entrypoint path,
  request body, and response shape.**
- **OQ-2 (lock ownership).** §6 puts single-flight in the cron (run-row table). If
  #3's trainer already guards itself (e.g. `pg_try_advisory_lock` returning
  `skipped`), the cron's table-lock is redundant. Decide one owner; this spec
  defaults to the cron so it works against a black-box trainer.
- **OQ-3 (run-row table = the one schema this slice may add).** If a
  `moat.train_run` run-row table is used for the lock (§6, mechanism B), it needs a
  `supabase/migrations/` entry. The umbrella (§8) permits #4 to add migrations that
  *codify already-deployed moat schema* but the run-row is **new**. Confirm the
  orchestrator is OK with this one new scheduler-concern table, or prefer mechanism
  (A)/trainer-owned lock (OQ-2) to avoid new schema entirely.
- **No contradictions with the umbrella's fixed contract were found.** This slice
  touches only the scheduler layer (§5 "Cron convention" of the umbrella) and the
  trainer seam (#3), neither of which redefines a §5 kernel, a table, or an
  anonymization invariant.

## 10. Acceptance criteria

1. `GET /cron/moat-train` without a valid `CRON_SECRET` bearer → **401**, trainer
   not invoked.
2. `GET /cron/moat-train` with a valid bearer, lock free → invokes the trainer
   **exactly once** over HTTP at `${origin}/api/engine/moat-train` with
   `Authorization: Bearer ${CRON_SECRET}`, returns **200** with
   `{ shops_trained, models_written, errors: [] }` echoed.
3. Trainer returns non-OK HTTP → route returns **502**, logs the failure, body
   `{ ok: false, error }`.
4. Trainer returns 200 with non-empty `errors[]` → route returns **500** with the
   `errors[]` surfaced (partial run is a visible failure, never reported as 200).
5. A second concurrent invocation while the lock is held → trainer **not** invoked
   a second time; route returns `200 { ok: true, skipped: "locked" }`.
6. `vercel.json` contains `{ "path": "/cron/moat-train", "schedule": "0 3 * * *" }`.
7. Structured start + summary log lines are emitted; per-shop errors from the
   trainer appear in the logs.
