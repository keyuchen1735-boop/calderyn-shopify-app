# Calderyn Calibration Slice 2: Action Queue (read + Approve) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the "Action Queue" surface (both embedded + dashboard) that presents open alerts as approvable proposals with a live per-pair confidence, and make every merchant Approval bump that pair's confidence (the positive learning signal that raises the calibration %).

**Architecture:** The Queue is a read-only re-presentation of open alerts: for each alert with a real recommended action, show {detector, proposed action, $ impact, confidence, reasoning} + an Approve button. Approve reuses the EXISTING, already-reviewed action executor (no new execution path); after a successful merchant approval, a new `recordApproval` increments the pair's Beta `alpha` counter in `pair_calibration`. The per-pair confidence computation is centralized into the existing `confidence.ts` (single source of truth) and consumed by both the nightly recompute and the Queue.

**Tech Stack:** Remix + TS (strict), Supabase, Vitest, Polaris (embedded) + cd-*/CDIcon (dashboard). Builds on Slice 0-1 (already on this branch): `pair_calibration`, `app/lib/calibration/confidence.ts`, `recompute.server.ts`, the `.calibration` facade.

## Global Constraints

- **Still NO new autonomy.** Nothing auto-executes. Every action in this slice requires an explicit merchant Approve click. (Autonomous execution is Slice 5.)
- **Reuse the existing executor.** Approve MUST go through the existing approve path (`app/routes/app.alerts.$id.tsx` action for embedded; `dashboard.api.alerts.$id.action.tsx` + the dashboard campaign-action route for dashboard). Do NOT write a new executor or duplicate guardrail logic.
- **The confidence formula has ONE implementation** (`app/lib/calibration/confidence.ts`). Slice 2 ADDS a `pairConfidence(...)` function there and refactors `recompute.server.ts` to use it. No second copy.
- **`alpha` bump is atomic + idempotent-safe.** Use a DB-side increment / upsert, never read-modify-write in app code. A bump failure must NOT fail or roll back the (already-succeeded) action — wrap it so the action result is authoritative.
- **The bump fires only on MERCHANT approval, never autopilot.** Autopilot calls `executeAction` directly and must not trigger `recordApproval`. Wire the bump only into the merchant-approve route handlers.
- **`recommendedAction(detectorId, {hasCampaign})`** (in `app/lib/labels.ts`) is the source of the proposed action. Alerts whose recommended action is `null` (snooze-only) are NOT shown in the queue.
- **Confidence shown is RPC-free:** peer baselines are empty, so `pairConfidence` is called with `peerP50 = null` (static seed). No `action_pair_prior` RPC in the queue page (keeps it a single cheap query path).
- **Parity is MANDATORY:** the dashboard gets the same Queue surface against its own primitives (cd-*/CDIcon), same contract.
- **Pre-commit gate per task:** `npm run typecheck` (0), `npm run lint` (0 errors, 0 warnings on touched files), `npm run build` (0), relevant `npx vitest run` green.
- **Worktree:** continue on `worktree-feat+calibration-foundation` (stacked on Slice 0-1).

---

## File Structure

- Modify `app/lib/calibration/confidence.ts` — add `DETECTION_COLD` const (moved from recompute) + `pairConfidence(detectorId, actionKind, ev, peerP50)`.
- Modify `app/lib/calibration/recompute.server.ts` — consume `pairConfidence` (remove the inline duplicate + local `DETECTION_COLD`).
- Create `app/lib/calibration/approval.server.ts` — `recordApproval(shopId, detectorId, actionKind, sb)` atomic alpha/clean_approvals upsert.
- Create `app/lib/calibration/queue.server.ts` — `buildActionQueue(shopId, deps)` → `QueueProposal[]`.
- Modify `app/lib/types.ts` — add `QueueProposal` DTO.
- Modify `app/lib/calderyn.server.ts` — add `queue: { list() }` namespace.
- Modify `app/routes/app.alerts.$id.tsx` — call `recordApproval` after a successful merchant approve.
- Create `app/routes/app.queue.tsx` — embedded Queue page (loader + Approve form reposting to the alerts action).
- Modify `app/routes/app.tsx` — add Queue to the NavMenu.
- Create `app/routes/dashboard.api.queue._index.tsx` — dashboard queue read API.
- Modify `app/routes/dashboard.api.alerts.$id.action.tsx` + the dashboard campaign-action route — call `recordApproval` after a successful approve.
- Create `app/components/dashboard/screens/ActionQueue.tsx` — dashboard Queue screen.
- Modify `app/components/dashboard/context.ts`, `app/components/dashboard/DashboardApp.tsx`, `app/lib/dashboard/client.ts`, `app/components/dashboard/view-models.ts` — register screen, fetch, VM.

---

## Task 1: Centralize per-pair confidence in the math module

**Files:**
- Modify: `app/lib/calibration/confidence.ts`
- Modify: `app/lib/calibration/recompute.server.ts`
- Test: `app/lib/calibration/__tests__/confidence.test.ts` (extend)

**Interfaces:**
- Produces: `export const DETECTION_COLD = 0.6;` and `export function pairConfidence(detectorId: string, actionKind: ActionKind, ev: { alpha: number; beta: number }, peerP50: number | null): number` in `confidence.ts`.

- [ ] **Step 1: Write the failing test** (append to `confidence.test.ts`):

```ts
import { pairConfidence, DETECTION_COLD } from "../confidence";

describe("pairConfidence", () => {
  it("matches the canonical no-brainer at cold start (~74)", () => {
    // sku_stockout_vs_spend:pause_campaign is a NO_BRAINER, reversible, has executor
    expect(pairConfidence("sku_stockout_vs_spend", "pause_campaign", { alpha: 0, beta: 0 }, null)).toBe(74);
  });
  it("is 0 for a no-executor action (guardrail veto)", () => {
    expect(pairConfidence("margin_erosion", "snooze_alert", { alpha: 0, beta: 0 }, null)).toBe(0);
  });
  it("rises as approvals accrue", () => {
    const cold = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 0, beta: 0 }, null);
    const warm = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 10, beta: 0 }, null);
    expect(warm).toBeGreaterThan(cold);
  });
  it("exposes the cold-start detection constant", () => {
    expect(DETECTION_COLD).toBe(0.6);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run app/lib/calibration/__tests__/confidence.test.ts` → fails (pairConfidence/DETECTION_COLD not exported).

- [ ] **Step 3: Implement in `confidence.ts`** — add near the other consts and exports:

```ts
// Cold-start detection factor (capped until per-detector precision history exists).
export const DETECTION_COLD = 0.6;

// Convenience: full per-(detector, action) confidence from the pair's Beta
// counters + optional peer prior. The single entry point used by both the
// nightly recompute and the Action Queue, so the two never diverge.
export function pairConfidence(
  detectorId: string,
  actionKind: ActionKind,
  ev: { alpha: number; beta: number },
  peerP50: number | null,
): number {
  const tier = actionTier(actionKind);
  const veto: 0 | 1 = HAS_EXECUTOR.has(actionKind) ? 1 : 0;
  const prior = pairPrior(tier, NO_BRAINER.has(`${detectorId}:${actionKind}`), peerP50);
  const hist = historical(ev.alpha, ev.beta, prior);
  return confidence({
    guardrailVeto: veto,
    detection: DETECTION_COLD,
    historical: hist,
    reversibility: reversibilityFactor(tier),
  });
}
```

- [ ] **Step 4: Refactor `recompute.server.ts`** to use it. Remove the local `const DETECTION_COLD = 0.6;` and the inline tier/veto/prior/historical/confidence block inside the weights loop; replace with:

```ts
import { pairConfidence, HAS_EXECUTOR, NO_BRAINER } from "./confidence"; // keep existing imports; drop now-unused ones
// ...in the loop, after resolving peerP50:
const conf = pairConfidence(detector, action, { alpha: ev?.alpha ?? 0, beta: ev?.beta ?? 0 }, peerP50);
scored.push({ conf, weight });
```
Remove imports that are no longer referenced (e.g. `actionTier`, `confidence`, `historical`, `pairPrior`, `reversibilityFactor`) if the loop was their only use. Let `npm run typecheck` tell you what's now unused.

- [ ] **Step 5: Run both test files** — `npx vitest run app/lib/calibration/__tests__/confidence.test.ts app/lib/calibration/__tests__/recompute.test.ts` → all pass (the recompute canary still computes the same ~36, since the math is identical — just relocated).

- [ ] **Step 6: Typecheck + commit** — `npm run typecheck`; `git add app/lib/calibration/confidence.ts app/lib/calibration/recompute.server.ts app/lib/calibration/__tests__/confidence.test.ts && git commit -m "lib/calibration: centralize pairConfidence + DETECTION_COLD; recompute reuses it"`

---

## Task 2: `recordApproval` — atomic positive learning signal

**Files:**
- Create: `app/lib/calibration/approval.server.ts`
- Test: `app/lib/calibration/__tests__/approval.test.ts`

**Interfaces:**
- Produces: `export async function recordApproval(shopId: string, detectorId: string, actionKind: ActionKind, sb: SupabaseClient): Promise<void>`

- [ ] **Step 1: Write the failing test**:

```ts
import { describe, it, expect, vi } from "vitest";
import { recordApproval } from "../approval.server";

describe("recordApproval", () => {
  it("upserts an alpha + clean_approvals increment for the pair", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const sb = { rpc } as unknown as import("@supabase/supabase-js").SupabaseClient;
    await recordApproval("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_approval", {
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
    });
  });
  it("does not throw when the RPC errors (action result is authoritative)", async () => {
    const sb = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } as unknown as import("@supabase/supabase-js").SupabaseClient;
    await expect(recordApproval("shop-1", "d", "pause_campaign", sb)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Create the atomic increment via a SQL function (migration), then the wrapper.**

First the migration `supabase/migrations/20260620170000_calibration_record_approval_fn.sql` (apply via supabase MCP `apply_migration`, name `calibration_record_approval_fn`):

```sql
-- Atomic positive learning signal: a merchant approved this (detector, action).
-- Upsert the pair's Beta alpha + clean-approval counters. SECURITY DEFINER so the
-- server (service_role) can write regardless of the request RLS context; shop_id
-- is supplied by the trusted server caller. service_role-only.
create or replace function public.calibration_record_approval(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, alpha, clean_approvals, consecutive_clean_approvals, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, 1, 1, 1, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set alpha = public.pair_calibration.alpha + 1,
        clean_approvals = public.pair_calibration.clean_approvals + 1,
        consecutive_clean_approvals = public.pair_calibration.consecutive_clean_approvals + 1,
        consecutive_undos = 0,
        updated_at = now();
$func$;

revoke all on function public.calibration_record_approval(uuid, text, public.action_kind) from public;
revoke execute on function public.calibration_record_approval(uuid, text, public.action_kind) from anon, authenticated;
grant execute on function public.calibration_record_approval(uuid, text, public.action_kind) to service_role;
```
Apply it, then verify privileges (`service_role` only) via `execute_sql` exactly as in the Slice 0 `action_pair_prior` task. Also add the same file under `tests/engine/schema/migrations/` (mirror, so the RLS/test DB stays schema-complete).

Then `app/lib/calibration/approval.server.ts`:

```ts
// Records a merchant approval as the positive learning signal for a
// (detector, action) pair. Atomic via the calibration_record_approval SQL fn.
// Never throws: the action it follows has already succeeded, so a bump failure
// must not surface as an action failure (it is logged and the next nightly
// recompute self-heals from the append-only audit anyway).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";

export async function recordApproval(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  sb: SupabaseClient,
): Promise<void> {
  try {
    const { error } = await sb.rpc("calibration_record_approval", {
      p_shop_id: shopId,
      p_detector_id: detectorId,
      p_action_kind: actionKind,
    });
    if (error) console.error(`[calibration] recordApproval failed: ${error.message}`);
  } catch (err) {
    console.error(`[calibration] recordApproval threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run the test → pass.** Fix the inline `import("...")` type per lint (top-level `import type { SupabaseClient }` in the test).

- [ ] **Step 5: Typecheck + commit** — include the migration. `git add supabase/migrations tests/engine/schema/migrations app/lib/calibration/approval.server.ts app/lib/calibration/__tests__/approval.test.ts && git commit -m "lib/calibration: recordApproval atomic alpha bump (merchant approval signal)"`

---

## Task 3: Queue builder + facade

**Files:**
- Create: `app/lib/calibration/queue.server.ts`
- Modify: `app/lib/types.ts` (add `QueueProposal`)
- Modify: `app/lib/calderyn.server.ts` (add `queue` namespace)
- Test: `app/lib/calibration/__tests__/queue.test.ts`

**Interfaces:**
- Produces: `interface QueueProposal { alertId: string; detector_id: DetectorId; action_kind: ActionKind; title: string; dollar_impact: number; confidence: number; reasoning: string; }` and `client.queue.list(signal?): Promise<QueueProposal[]>`.

- [ ] **Step 1: Write the failing test** for `buildActionQueue` — given a list of open alerts + a pair-row map, it (a) drops alerts whose `recommendedAction` is null, (b) sets `action_kind` to the recommended action, (c) computes `confidence` via `pairConfidence` with the pair's alpha/beta (peerP50 null), (d) carries dollar_impact + a one-line reasoning.

```ts
import { describe, it, expect } from "vitest";
import { buildActionQueue } from "../queue.server";

const alert = (over = {}) => ({
  id: "a1", detector_id: "campaign_below_breakeven", severity: "high", status: "open",
  dollar_impact: 12000, claude_rank: 1, created_at: "2026-06-20T00:00:00Z",
  title: "Campaign losing money", narrative: "ROAS 0.7", campaign: "Camp A",
  campaign_id: "c1", campaign_external_id: null, sku: null, evidence: { campaign_id: "c1" }, ...over,
});

describe("buildActionQueue", () => {
  it("turns open alerts with a real recommended action into proposals with confidence", () => {
    const q = buildActionQueue([alert()] as never, new Map());
    expect(q).toHaveLength(1);
    expect(q[0].action_kind).toBe("pause_campaign");
    expect(q[0].confidence).toBeGreaterThan(0);
    expect(q[0].dollar_impact).toBe(12000);
  });
  it("skips alerts whose only action is snooze (recommended null)", () => {
    // an alert whose detector maps only to snooze -> recommendedAction null
    const q = buildActionQueue([alert({ detector_id: "free_ship_margin_leak", campaign_id: null, evidence: {} })] as never, new Map());
    // if free_ship_margin_leak has a non-campaign real action this stays; assert no campaign-only proposal leaks without a campaign
    expect(q.every((p) => p.action_kind !== "pause_campaign")).toBe(true);
  });
});
```
(Adjust the second case to a detector that truly resolves to null given `hasCampaign:false`, using the real `DETECTOR_TO_ACTIONS`.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `queue.server.ts`:**

```ts
import type { Alert, QueueProposal } from "../types";
import { recommendedAction, DETECTOR_LABELS, ACTION_VERBS } from "../labels"; // confirm ACTION_VERBS export name
import { pairConfidence } from "./confidence";

export function buildActionQueue(
  alerts: Alert[],
  pairRows: Map<string, { alpha: number; beta: number }>,
): QueueProposal[] {
  const out: QueueProposal[] = [];
  for (const a of alerts) {
    const hasCampaign = Boolean(a.campaign_id);
    const action = recommendedAction(a.detector_id, { hasCampaign });
    if (!action) continue;
    const ev = pairRows.get(`${a.detector_id}:${action}`) ?? { alpha: 0, beta: 0 };
    out.push({
      alertId: a.id,
      detector_id: a.detector_id,
      action_kind: action,
      title: a.title,
      dollar_impact: a.dollar_impact,
      confidence: pairConfidence(a.detector_id, action, ev, null),
      reasoning: a.narrative,
    });
  }
  return out;
}
```

Add `QueueProposal` to `types.ts`. Add the `queue` namespace to `calderynClient` (mirror `guardrails`): load open alerts (`this`-scope `supabase` -> `v_alerts_view` like `alerts.list({status:"open"})`) + the shop's `pair_calibration` rows, then `buildActionQueue`. Keep it within the existing facade patterns.

```ts
    queue: {
      async list(signal?: AbortSignal): Promise<QueueProposal[]> {
        try {
          const shopId = await shopIdP;
          const alerts = await client_alerts_list_open(shopId); // reuse the same query alerts.list({status:"open"}) uses
          const { data: pairs, error } = await supabase
            .from("pair_calibration").select("detector_id, action_kind, alpha, beta").eq("shop_id", shopId);
          if (error) throw error;
          const map = new Map((pairs ?? []).map((r) => [`${r.detector_id}:${r.action_kind}`, { alpha: Number(r.alpha), beta: Number(r.beta) }]));
          return buildActionQueue(alerts, map);
        } catch (err) { rethrow("queue.list", err); }
      },
    },
```
(Reuse the existing open-alerts query rather than duplicating SQL — call the same internal the `alerts.list` namespace uses. If `alerts.list` is the only entry, call `this.alerts.list({status:"open"})` is not available inside the object literal; instead extract the open-alerts query into a local helper and call it from both, OR call the existing `alerts` namespace via a captured reference. Pick the cleanest within the file's structure.)

- [ ] **Step 4: Run tests → pass. Typecheck.**

- [ ] **Step 5: Commit** — `git add app/lib/calibration/queue.server.ts app/lib/types.ts app/lib/calderyn.server.ts app/lib/calibration/__tests__/queue.test.ts && git commit -m "lib/calibration: action queue builder + queue.list facade"`

---

## Task 4: Embedded Action Queue page + wire the approval signal

**Files:**
- Create: `app/routes/app.queue.tsx`
- Modify: `app/routes/app.alerts.$id.tsx` (call `recordApproval` after a successful merchant approve)
- Modify: `app/routes/app.tsx` (NavMenu link)
- Test: `app/routes/__tests__/app-queue-loader.test.ts` (+ a focused test that the alerts action calls recordApproval on success)

**Interfaces:** consumes `client.queue.list()`, `recordApproval`.

- [ ] **Step 1: Wire `recordApproval` into the existing approve action.** In `app/routes/app.alerts.$id.tsx` `action()`, AFTER the executor returns success (and you have the trusted `alert` + the executed `kind`), add:

```ts
// Positive calibration signal — merchant approved this (detector, action).
// Never blocks the action result.
await recordApproval(shopIdResolved, alert.detector_id, kind, sb);
```
Use the shop id + `sb` the handler already has (or resolve them the same way the executor does). Place it only on the success path, only for real executed kinds (not the deep-link/400 cases). Import `recordApproval`.

- [ ] **Step 2: Test that approval triggers the bump.** Add a focused test mocking the executor to succeed and asserting `recordApproval` (mock the module) is called with the alert's detector + kind. Run → pass.

- [ ] **Step 3: Build the Queue page** `app/routes/app.queue.tsx`. Loader: `authenticate.admin` → `calderynClient(shop).queue.list(request.signal)` → `json({ proposals })`. Mirror `app.alerts._index.tsx` structure. Each proposal row (reuse the alerts row styling) shows: detector label (`alertDetectorLabel`), proposed action verb (`ACTION_LABELS[action_kind]`), `$ impact`, a confidence bar ("62% confident"), the reasoning line, and an **Approve** button. Approve is a Polaris form that POSTs to the existing alerts action route: `<Form method="post" action={`/app/alerts/${p.alertId}`}>` with hidden `kind`, `alertId`, `idempotencyKey` (generate one) — reusing the reviewed executor. Empty state: "Nothing waiting — Calderyn will queue suggestions here." Add a `calibration`-style confidence indicator (reuse the embedded `CalibrationHeader`'s progress idiom or a Polaris `Badge`).

- [ ] **Step 4: Loader test** `app-queue-loader.test.ts` — mock `calderynClient` so `queue.list` returns a proposal; assert the loader returns it; include calibration mock so it doesn't throw. Run → pass.

- [ ] **Step 5: NavMenu** — in `app/routes/app.tsx`, add `<Link to="/app/queue">Action Queue</Link>` (or the repo's NavMenu idiom) next to the existing links.

- [ ] **Step 6: Gate + commit** — `npm run typecheck && npm run lint && npm run build && npx vitest run app/routes/__tests__/app-queue-loader.test.ts`; `git add app/routes/app.queue.tsx app/routes/app.alerts.$id.tsx app/routes/app.tsx app/routes/__tests__/ && git commit -m "routes/app.queue: Action Queue page; approve bumps pair confidence (embedded)"`

---

## Task 5: Dashboard Action Queue (parity) + approval signal

**Files:**
- Create: `app/routes/dashboard.api.queue._index.tsx`
- Create: `app/components/dashboard/screens/ActionQueue.tsx`
- Modify: `app/lib/dashboard/client.ts` (`fetchActionQueue`), `app/components/dashboard/view-models.ts` (`QueueProposalVM`), `app/components/dashboard/context.ts` (Screen union + ctx field), `app/components/dashboard/DashboardApp.tsx` (NAV_ITEMS, SCREENS, load), and the dashboard approve routes (`dashboard.api.alerts.$id.action.tsx` + the dashboard campaign-action route) to call `recordApproval` after success.

**Interfaces:** mirrors Task 3-4 against the dashboard's own stack.

- [ ] **Step 1: Read API route** `dashboard.api.queue._index.tsx` — mirror `dashboard.api.calibration._index.tsx` (Slice 1) for auth/shop resolution; return `client.queue.list(request.signal)` as JSON.

- [ ] **Step 2: Wire `recordApproval` into the dashboard approve paths.** In `dashboard.api.alerts.$id.action.tsx` (inventory/snooze) and the dashboard campaign-action route, after a successful execute, call `recordApproval(shopId, detectorId, kind, sb)`. The detector id comes from the trusted alert (load it if the route doesn't already have it). Snooze is not an approval of a real action — only bump for non-snooze kinds.

- [ ] **Step 3: Screen + registration** — create `screens/ActionQueue.tsx` (copy the `Alerts.tsx`/`Audit.tsx` row pattern; show detector, proposed verb, $ impact, a `Meter`/bar for confidence, Approve button calling `app.executeAction(proposalAsAlert, action_kind)` — reuse the existing `executeAction`). Register: add `"action-queue"` to the `Screen` union (`context.ts`), to `NAV_ITEMS` + `SCREENS` (`DashboardApp.tsx`, icon e.g. `bolt`/`zap` — add to CD_ICONS if needed), and add `actionQueue` to the ctx + `load()` Promise.all via `client.fetchActionQueue()`.

- [ ] **Step 4: client + VM** — `fetchActionQueue()` in `client.ts` (mirror `fetchAudit`); `QueueProposalVM` in `view-models.ts`. Patch any DashboardCtx-constructing test fixtures for the new required ctx field (as Slice 1 did).

- [ ] **Step 5: Gate + commit** — `npm run typecheck && npm run lint && npm run build && npm run test` (full suite, to catch fixture/loader regressions like Slice 1 had); `git add ... && git commit -m "dashboard: Action Queue screen + approve bumps confidence (parity)"`

---

## Task 6: Whole-slice verification

- [ ] **Step 1: Full gate** — `npm run typecheck && npm run lint && npm run build && npm run test` all green.
- [ ] **Step 2: Sanity** — confirm via the diff that autopilot's `executeAction` path does NOT call `recordApproval` (bump is merchant-only), and that Approve reuses the existing executor (no new execution/guardrail code).
- [ ] **Step 3:** (post-deploy, like Slice 1) the live approve→bump→% climb is verified on a real shop after deploy; note it.

## Self-Review

- **Spec coverage:** Action Queue surface (spec §5) → Tasks 3-5. Approve reuses executor (§5) → Tasks 4-5. Positive learning signal / alpha (spec §7 approve row) → Tasks 2,4,5. Confidence per pair (spec §2) → Task 1. Parity (§10) → Task 5.
- **Deferred to later slices (by design):** Reject + reason taxonomy + Learned rules (Slice 3, spec §5/§7); Agent Activity + undo (Slice 4, §6); graduation/autonomy (Slice 5, §3/§9). The queue shows ALL proposals (no graduated pairs exist yet).
- **Placeholder scan:** none. **Type consistency:** `QueueProposal {alertId, detector_id, action_kind, title, dollar_impact, confidence, reasoning}` used identically across Tasks 3-5; `recordApproval(shopId, detectorId, actionKind, sb)` identical in Tasks 2,4,5; `pairConfidence(detectorId, actionKind, ev, peerP50)` identical Tasks 1,3.
