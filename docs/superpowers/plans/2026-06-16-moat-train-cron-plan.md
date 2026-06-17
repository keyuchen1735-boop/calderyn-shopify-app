# Moat Train Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly `/cron/moat-train` Remix route (plus its `vercel.json` entry) that authenticates with `CRON_SECRET`, invokes the slice-#3 Python trainer once over HTTP, guards against overlapping runs, and surfaces trainer failures fail-visibly.

**Architecture:** A Remix `loader` at `app/routes/cron.moat-train.tsx` mirrors the existing `cron.detect` route: `isAuthorizedCron` gate → resolve public origin (`SHOPIFY_APP_URL || request origin`) → `fetch` the Python engine endpoint with a `Bearer ${CRON_SECRET}` header. A single-flight lock lives behind an injectable `app/lib/moat/train-lock.server.ts` helper so the route stays testable and the lock owner can be swapped at integration time. Vercel cron fires it nightly at `0 3 * * *`, after ingest/detect have settled and clear of the 04:00 maintenance cluster.

**Tech Stack:** Remix (Vite) loaders, `@remix-run/node` `json`, Node `fetch`, `app/lib/cron-auth.server.ts` (`isAuthorizedCron`, constant-time bearer), vitest (`vi.mock`, `vi.hoisted`, `vi.stubEnv`, `vi.stubGlobal`). No new top-level dependencies.

## Global Constraints

- **TypeScript only**, ES modules, strict. No `any` without written justification. `tsc --noEmit` is authoritative.
- **Server-only files** end `.server.ts`; never imported from a client module.
- **Cron convention (umbrella §5):** copy `cron.detect` — `CRON_SECRET` bearer via `isAuthorizedCron`; engine reached over HTTP at the public origin; fail-visible per-error surfacing (repo rule 12).
- **URL-collision rule (commit `551dabf`, 2026-06-16 501 outage):** a Remix route and a Python serverless function must NEVER share a URL. The scheduler is `/cron/moat-train` (Remix); the trainer is reached at a Python-function path under `/api/engine/*` — assumed `/api/engine/moat-train` (slice #3 seam, OQ-1).
- **Origin resolution:** `const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;` — Vercel deployment protection walls off the self-fetch on the `*.vercel.app` URL, so engine calls go through the public origin; fall back to request origin in local dev.
- **Trainer entrypoint ASSUMED from #3 (seam — OQ-1):** `POST /api/engine/moat-train`, `Authorization: Bearer ${CRON_SECRET}`, request body `{}`, success `200 { shops_trained: number, models_written: number, errors: string[] }`. Non-empty `errors[]` = partial run = fail-visible (non-200) even on HTTP 200.
- **Schedule:** `{ "path": "/cron/moat-train", "schedule": "0 3 * * *" }` — nightly 03:00 UTC, after ingest (`*/30`)/detect (`15,45`) settle, clear of the 04:00 gdpr/oauth-cleanup and 05:00 quickbooks cluster.
- **Lint:** `--max-warnings=0` on new code. **No dashboard parity** required (infra-only cron; stated explicitly).
- **Test command for this slice:** `npx vitest run app/routes/__tests__/cron.moat-train.test.ts app/lib/moat/__tests__/train-lock.test.ts`. Vitest `include` is `app/**/*.test.ts` (see `vitest.config.ts`), so both paths are picked up by `npm run test`.

---

## File Structure

- **Create** `app/lib/moat/train-lock.server.ts` — single-flight lock helper. Exposes `acquireTrainLock(sb)` → `Promise<boolean>` (true = acquired, false = already running) and `releaseTrainLock(sb)` → `Promise<void>`. Kept separate from the route so (a) the route test mocks it trivially and (b) the lock owner is swappable at integration time (OQ-2). In this plan it is a **no-op stub that always acquires** (returns `true`) and never blocks, with the real run-row implementation deferred to integration (a documented TODO referencing OQ-3); this lets the cron ship and be tested without committing to new schema before the #3 seam is reconciled.
- **Create** `app/lib/moat/__tests__/train-lock.test.ts` — proves the stub's contract (acquire returns true, release resolves) so a later real implementation has a behavior anchor.
- **Create** `app/routes/cron.moat-train.tsx` — the cron `loader`: auth → lock → invoke trainer → shape response → release lock. Mirrors `cron.detect.tsx`.
- **Create** `app/routes/__tests__/cron.moat-train.test.ts` — vitest suite: rejects bad `CRON_SECRET`; invokes the trainer exactly once on the happy path; surfaces a transport failure as non-200; surfaces a partial run (`errors[]` non-empty) as non-200; skips when the lock is held.
- **Modify** `vercel.json` — add the `crons` entry.

No other files change. (The real run-row lock table + its `supabase/migrations/` entry is intentionally deferred — see OQ-3 in the spec; this plan ships the cron against a no-op lock so it is not blocked on the new-schema decision.)

---

### Task 1: Train-lock helper (single-flight seam, no-op stub)

**Files:**
- Create: `app/lib/moat/train-lock.server.ts`
- Test: `app/lib/moat/__tests__/train-lock.test.ts`

**Interfaces:**
- Consumes: a Supabase client instance (`ReturnType<typeof getSupabase>` from `~/lib/supabase.server`), passed in — the helper does not import the client itself, so the route owns the client and tests inject a fake.
- Produces: `acquireTrainLock(sb: SupabaseLike): Promise<boolean>` (true = caller may run, false = a run is already in progress) and `releaseTrainLock(sb: SupabaseLike): Promise<void>`. The route (Task 3) calls `acquireTrainLock` before invoking the trainer and `releaseTrainLock` in a `finally`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/moat/__tests__/train-lock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { acquireTrainLock, releaseTrainLock } from "../train-lock.server";

// The lock is a swappable seam (spec OQ-2/OQ-3). The shipped stub never blocks:
// acquire always grants, release always resolves. These tests pin that contract
// so a later run-row implementation has a behavior anchor to replace it against.
describe("train-lock (no-op stub)", () => {
  const sb = {} as never;

  it("acquire grants the lock (returns true)", async () => {
    await expect(acquireTrainLock(sb)).resolves.toBe(true);
  });

  it("release resolves without throwing", async () => {
    await expect(releaseTrainLock(sb)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/moat/__tests__/train-lock.test.ts`
Expected: FAIL — cannot resolve `../train-lock.server` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/moat/train-lock.server.ts`:

```ts
// Single-flight guard for the nightly moat trainer (cron.moat-train).
//
// SEAM (spec OQ-2/OQ-3): this is the swappable lock owner. The shipped version
// is a NO-OP that always grants — the trainer's upsert is idempotent by PK
// (detector_id, shop_id_pseudonym), so a concurrent run is correctness-safe; the
// real run-row lock (a `moat.train_run` row with an expires_at TTL, per the spec
// §6 mechanism B) is deferred until the #3 trainer entrypoint is reconciled, to
// avoid committing new schema before the seam is settled. Swap the bodies here —
// the route already calls acquire/release around the trainer invocation, so the
// route does not change when the real lock lands.
//
// TODO(moat OQ-3): replace with a conditional UPDATE on a `moat.train_run`
// single-row lock (locked_at/expires_at) once OQ-2 (lock ownership) is decided.

// Minimal structural type so this helper does not couple to the concrete
// Supabase client shape; the route passes its real client, tests pass {}.
type SupabaseLike = Record<string, unknown>;

export async function acquireTrainLock(_sb: SupabaseLike): Promise<boolean> {
  // No-op: always grant. (Real impl: rows-affected === 1 on the conditional
  // UPDATE means acquired; 0 means a run is already in progress -> return false.)
  return true;
}

export async function releaseTrainLock(_sb: SupabaseLike): Promise<void> {
  // No-op: nothing to release. (Real impl: clear locked_at on the lock row.)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/moat/__tests__/train-lock.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add app/lib/moat/train-lock.server.ts app/lib/moat/__tests__/train-lock.test.ts
git commit -m "lib/moat/train-lock: single-flight seam for the trainer cron (no-op stub)"
```

---

### Task 2: The `/cron/moat-train` route — auth + happy path (invoke trainer once)

**Files:**
- Create: `app/routes/cron.moat-train.tsx`
- Test: `app/routes/__tests__/cron.moat-train.test.ts`

**Interfaces:**
- Consumes: `isAuthorizedCron(authHeader, secret)` from `~/lib/cron-auth.server`; `getSupabase()` from `~/lib/supabase.server`; `acquireTrainLock`/`releaseTrainLock` from `~/lib/moat/train-lock.server` (Task 1); global `fetch`.
- Produces: `export const loader = async ({ request }: LoaderFunctionArgs) => Response`. Vercel cron issues a `GET`. On the happy path it does exactly one `fetch` to `${origin}/api/engine/moat-train` and returns `json({ ok: true, shops_trained, models_written, errors: [], duration_ms })`.

- [ ] **Step 1: Write the failing test (auth reject + happy path)**

Create `app/routes/__tests__/cron.moat-train.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.moat-train";

const { getSupabase } = vi.hoisted(() => ({
  getSupabase: vi.fn(() => ({})),
}));
const { acquireTrainLock, releaseTrainLock } = vi.hoisted(() => ({
  acquireTrainLock: vi.fn(() => Promise.resolve(true)),
  releaseTrainLock: vi.fn(() => Promise.resolve()),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("~/lib/moat/train-lock.server", () => ({ acquireTrainLock, releaseTrainLock }));

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://deployment-url.vercel.app/cron/moat-train", { headers });
}

describe("cron.moat-train loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.CRON_SECRET = "s3cret";
    acquireTrainLock.mockResolvedValue(true);
  });

  it("rejects an unauthorized request and never invokes the trainer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer wrong") } as never);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invokes the trainer exactly once at the public origin and echoes its counts", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ shops_trained: 12, models_written: 31, errors: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example.com/api/engine/moat-train",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer s3cret" }),
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.shops_trained).toBe(12);
    expect(body.models_written).toBe(31);
    expect(body.errors).toEqual([]);
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the request origin when SHOPIFY_APP_URL is unset", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ shops_trained: 0, models_written: 0, errors: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loader({ request: req("Bearer s3cret") } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://deployment-url.vercel.app/api/engine/moat-train",
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.moat-train.test.ts`
Expected: FAIL — cannot resolve `../cron.moat-train` (route does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `app/routes/cron.moat-train.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { acquireTrainLock, releaseTrainLock } from "~/lib/moat/train-lock.server";

// Nightly wrapper that drives the slice-#3 moat trainer (Python engine). Mirrors
// cron.detect: CRON_SECRET bearer auth, then reach the engine over HTTP at the
// PUBLIC app origin (Vercel deployment protection walls off the self-fetch on the
// *.vercel.app URL). The trainer is a Python serverless function and MUST stay on
// its own /api/engine/* path — a Remix route sharing that URL collides at the
// build-output function dir and 501s every route (2026-06-16 outage, commit 551dabf).
//
// SEAM (spec OQ-1): the trainer entrypoint is ASSUMED to be POST /api/engine/moat-train,
// body {}, returning { shops_trained, models_written, errors[] }. If #3's real
// entrypoint differs, only ENGINE_PATH and the three response keys below change.
const ENGINE_PATH = "/api/engine/moat-train";

type TrainerResult = {
  shops_trained: number;
  models_written: number;
  errors: string[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const startedAt = Date.now();

  // Single-flight: a slow run + the next tick (or a Vercel retry) must not start a
  // second trainer pass. A skipped-because-locked tick is a SUCCESS for the
  // scheduler (it correctly declined to double-train), so it is 200, not an error.
  const acquired = await acquireTrainLock(sb);
  if (!acquired) {
    console.warn("[cron.moat-train] skipped: already running");
    return json({ ok: true, skipped: "locked" as const });
  }

  console.log(`[cron.moat-train] start origin=${origin}`);
  try {
    const res = await fetch(`${origin}${ENGINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      // Transport-level failure: surface it (rule 12), do not report success.
      console.error(`[cron.moat-train] trainer HTTP ${res.status}`);
      return json({ ok: false, error: `trainer HTTP ${res.status}` }, { status: 502 });
    }

    const result = (await res.json()) as TrainerResult;
    const durationMs = Date.now() - startedAt;
    const errors = result.errors ?? [];

    console.log(
      `[cron.moat-train] done shops_trained=${result.shops_trained} ` +
        `models_written=${result.models_written} errors=${errors.length} ` +
        `duration_ms=${durationMs}`,
    );

    if (errors.length > 0) {
      // Partial cohort train is a VISIBLE failure even though some shops succeeded:
      // never 200 here (rule 12). Echo errors[] in both the body and the logs.
      console.error(`[cron.moat-train] partial run: ${errors.join("; ")}`);
      return json(
        {
          ok: false,
          shops_trained: result.shops_trained,
          models_written: result.models_written,
          errors,
          duration_ms: durationMs,
        },
        { status: 500 },
      );
    }

    return json({
      ok: true,
      shops_trained: result.shops_trained,
      models_written: result.models_written,
      errors,
      duration_ms: durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron.moat-train] trainer invocation failed", err);
    return json({ ok: false, error: message }, { status: 502 });
  } finally {
    // Always release so a crashed run cannot wedge the lock for the next night.
    await releaseTrainLock(sb);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/cron.moat-train.test.ts`
Expected: PASS (3 passed — unauthorized, happy path, origin fallback).

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.moat-train.tsx app/routes/__tests__/cron.moat-train.test.ts
git commit -m "routes/cron.moat-train: nightly trainer wrapper (auth + invoke once)"
```

---

### Task 3: Fail-visible paths — transport failure, partial run, lock skip

**Files:**
- Modify: `app/routes/__tests__/cron.moat-train.test.ts` (add three tests; route already handles these from Task 2 — this task proves it)

**Interfaces:**
- Consumes: same as Task 2. No new exports.
- Produces: no new code — this task is the behavior gate proving the route's fail-visible branches (502 on transport failure, 500 on partial run with `errors[]` echoed, 200 `skipped` when the lock is held). If any test fails, fix the route from Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `app/routes/__tests__/cron.moat-train.test.ts`, inside the `describe` block, after the existing tests:

```ts
  it("surfaces a trainer transport failure as 502 and does not report success", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Internal Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("500");
    // Lock is always released even on failure, so the next night can run.
    expect(releaseTrainLock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a partial run (non-empty errors[]) as 500 with errors echoed", async () => {
    // Trainer returns HTTP 200 but reports per-shop skips. A partial cohort train
    // is a visible failure (rule 12): the route must NOT return 200 here.
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          shops_trained: 9,
          models_written: 20,
          errors: ["pseudo-xyz: peer baseline below k=5"],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.shops_trained).toBe(9);
    expect(body.errors).toEqual(["pseudo-xyz: peer baseline below k=5"]);
  });

  it("skips (200, no trainer call) when the lock is already held", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
    acquireTrainLock.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe("locked");
    expect(fetchMock).not.toHaveBeenCalled();
    // We declined to run, so there is nothing to release.
    expect(releaseTrainLock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they pass (route already handles these)**

Run: `npx vitest run app/routes/__tests__/cron.moat-train.test.ts`
Expected: PASS (6 passed). If the transport/partial/skip tests FAIL, the Task 2 route is wrong — fix `cron.moat-train.tsx` (the 502/500/skip branches) until green; do not weaken the tests.

- [ ] **Step 3: Commit**

```bash
git add app/routes/__tests__/cron.moat-train.test.ts
git commit -m "routes/cron.moat-train: prove fail-visible paths (502 transport, 500 partial, lock skip)"
```

---

### Task 4: Register the nightly schedule in `vercel.json`

**Files:**
- Modify: `vercel.json` — add to the `crons` array.

**Interfaces:**
- Consumes: nothing (config).
- Produces: a Vercel cron that issues `GET /cron/moat-train` nightly at 03:00 UTC, which Vercel maps to `app/routes/cron.moat-train.tsx` (the `/cron/<name>` → `cron.<name>.tsx` mapping every existing entry uses).

- [ ] **Step 1: Add the cron entry**

Edit `vercel.json`. Add this object to the `crons` array (placement: after the `github-digest` entry is fine — order is not significant):

```json
{ "path": "/cron/moat-train", "schedule": "0 3 * * *" }
```

The resulting `crons` array:

```json
"crons": [
  { "path": "/cron/ingest", "schedule": "*/30 * * * *" },
  { "path": "/cron/detect", "schedule": "15,45 * * * *" },
  { "path": "/cron/ingest-ads", "schedule": "0 * * * *" },
  { "path": "/cron/gdpr", "schedule": "0 4 * * *" },
  { "path": "/cron/action-retry", "schedule": "*/15 * * * *" },
  { "path": "/cron/autopilot", "schedule": "0,30 * * * *" },
  { "path": "/cron/ingest-quickbooks", "schedule": "0 5 * * *" },
  { "path": "/cron/mcp-oauth-cleanup", "schedule": "0 4 * * *" },
  { "path": "/cron/github-digest", "schedule": "0 14 * * *" },
  { "path": "/cron/moat-train", "schedule": "0 3 * * *" }
]
```

(Rationale, per spec §8: nightly, after ingest `*/30`/detect `15,45` settle, clear of the 04:00 gdpr/oauth-cleanup and 05:00 quickbooks cluster.)

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json valid')"`
Expected: prints `vercel.json valid` (non-zero exit if the JSON is malformed).

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "vercel: nightly /cron/moat-train at 03:00 UTC (after ingest/detect, off the 04:00 cluster)"
```

---

### Task 5: Pre-commit gate — full eval pipeline green

**Files:** none (verification only).

**Interfaces:** none. This task runs the repo's mandatory pre-commit gate (CLAUDE.md) over the slice and proves each step green before the work is considered done.

- [ ] **Step 1: Run the full slice test suite**

Run: `npx vitest run app/routes/__tests__/cron.moat-train.test.ts app/lib/moat/__tests__/train-lock.test.ts`
Expected: PASS (8 passed total — 6 route + 2 lock).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Lint the touched files (no warnings on new code)**

Run: `npx eslint --max-warnings=0 app/routes/cron.moat-train.tsx app/lib/moat/train-lock.server.ts app/routes/__tests__/cron.moat-train.test.ts app/lib/moat/__tests__/train-lock.test.ts`
Expected: exit 0, no output.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0 — Remix + Vite build completes.

- [ ] **Step 5: Patch sanity**

Run: `git diff --check`
Expected: no output (no whitespace errors / conflict markers). Confirm by eye that no stray `console.log` debug lines, `.only`, `TODO(me)`, or commented-out blocks were introduced beyond the intentional `TODO(moat OQ-3)` seam marker in `train-lock.server.ts`.

- [ ] **Step 6: Final confirmation**

All of Steps 1–5 exit 0 / show the expected output. If any step fails, stop and fix the root cause — do not `--no-verify`, do not `// eslint-disable`, do not narrow types to silence `tsc` (CLAUDE.md pre-commit gate, repo rule 12). The slice is complete only when every step above is green.

---

## Self-Review

**1. Spec coverage:**
- Auth gate (spec §5.1, AC-1) → Task 2 (unauthorized test + `isAuthorizedCron` gate).
- Invoke trainer once at public origin (spec §3, §5.3, AC-2) → Task 2 (happy-path test asserts one `fetch` to `${origin}/api/engine/moat-train` with the bearer).
- Origin fallback (spec §3.2, constraint) → Task 2 (third test).
- Transport failure → 502 (spec §7, AC-3) → Task 3.
- Partial run → 500 with `errors[]` (spec §7, AC-4) → Task 3.
- Overlap/idempotency lock skip (spec §6, AC-5) → Task 1 (helper) + Task 3 (skip test).
- `vercel.json` entry `0 3 * * *` (spec §8, AC-6) → Task 4.
- Structured logging (spec §5, AC-7) → Task 2 route (`console.log` start/done lines, `console.error` per failure). No gaps.

**2. Placeholder scan:** No "TBD/TODO-implement-later" in steps. The one `TODO(moat OQ-3)` marker is an intentional, spec-referenced seam comment in `train-lock.server.ts` (documented in File Structure + Task 1), not a plan placeholder; it is explicitly excused in Task 5 Step 5's stray-marker check.

**3. Type consistency:** `acquireTrainLock(sb) → Promise<boolean>` / `releaseTrainLock(sb) → Promise<void>` are used identically in Task 1 (definition) and Task 2/3 (route + tests). `TrainerResult = { shops_trained, models_written, errors[] }` matches the spec §4 contract and the test fixtures' keys exactly. `ENGINE_PATH = "/api/engine/moat-train"` is the single point of change for the OQ-1 seam.

**Known deferred (not a gap — flagged seams):** the real run-row lock (spec OQ-2/OQ-3) ships as a no-op stub; if the orchestrator reconciles OQ-1/OQ-2 to a trainer-owned lock or a `moat.train_run` table, only `train-lock.server.ts` (and possibly a new migration) changes — the route and `vercel.json` are stable.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-16-moat-train-cron-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
