# Product-Economics Remediation — Phase 4 (Autopilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When autopilot is on, have it consume the *same* `RemediationPlan` the dashboard and embedded app already read — pick the top-ranked **eligible, executable** move (`plan.recommended`), run it within the existing guardrails/caps through the existing executor seams, and write a **deterministic** reasoning string + the ranked $ numbers to `action_audit.trigger_reason`. Advisory / null-executor / cap-blocked recommendations are surfaced as skips, never acted on (rule 12).

**Architecture:** Phase 4 adds a remediation branch to the existing `runAutopilotForShop` loop (`app/lib/actions/autopilot.server.ts`). The deterministic decision is *not* re-derived here — it is the `RemediationPlan` produced by the pure engine (`app/lib/remediation/rank.ts`, Phase 1), then run through the **same** Phase-3 async resolver `enrichRemediation(alert, plan, sb, shopId)` the merchant detail paths call (so autopilot and the UI agree on the executable `target`/`executor`; Phase 4 never re-derives the winner or campaign). Phase 4 reads `plan.recommended`, finds that move in `plan.moves`, maps its enriched `executor` to the right seam — the Phase-2 gateway `executeDiscontinueAlertAction(opts)` (`alert-action.server.ts`) for `discontinue_sku`, the Phase-3 gateway `executeReallocateSpendSku(opts)` (`reallocate-sku.server.ts`) for `reallocate_spend_sku`, and the existing campaign seam `executeAction(shopId, input, sb)` for `pause_campaign`/`reduce_campaign_budget` — guards it, executes it, and persists a reasoning string built **purely from the plan** (no model call). The candidate view (`v_autopilot_candidates`) is extended to surface the data the engine needs (detector, evidence, sku) for SKU-scoped economics alerts that today have no campaign row and are filtered out. Reuses Phase 2's `discontinue_sku` and Phase 3's `reallocate_spend_sku` / `pause_campaign` / `reduce_campaign_budget` executors.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Supabase Postgres (views/migrations), the existing autopilot cron (`app/routes/cron.autopilot.tsx`). No new dependencies.

---

## Scope & deliberate simplifications (read first)

Phase 4 is the final vertical slice of the 4-phase spec (`docs/superpowers/specs/2026-06-20-product-economics-remediation-design.md`, §"Phases" item 4). It is the *only* phase that lets autopilot act on product-economics remediation. Deliberate trims and hard dependencies (rule 12 — stated, not hidden):

- **Depends on Phase 1, 2, and 3 having landed.** This plan reads `alert.remediation` (Phase 1 engine + `attachRemediation`), and routes `recommended.executor` to **`discontinue_sku`** (Phase 2) and **`reallocate_spend_sku`** (Phase 3, which also reuses `pause_campaign` / `reduce_campaign_budget`). Those executors and the widened `StrategicMove.executor` union (`"snooze_alert" | "discontinue_sku" | "reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget" | null`) and the widened `ActionKind` (`discontinue_sku`, `reallocate_spend_sku`) **must exist before Task 3 here**. If Phase 2/3 have not merged, Tasks 3–5 will not typecheck. See the **⚠️ DECISION REQUIRED** callout below for the one cross-phase test collision this introduces.
- **Guardrails/caps behave EXACTLY as they do today — no bypass, no immediate-execute special-casing.** I read `autopilot.server.ts`, `guardrails.server.ts`, and `guardrails.ts` in this worktree: there is **no** `autopilot_bypass_guardrails` flag, **no** "execute immediately when capacity exists / no 30-min wait" path, and **no** separate remediation cap. Every autopilot action — including the new remediation moves — flows through `checkGuardrails` → `evaluateGuardrails`, which enforces `autopilot_daily_action_cap`, `autopilot_min_spend_cents`, `dollar_impact_cap_without_2fa`, `cooldown_minutes_per_campaign`, and `business_hours_only`. Phase 4 conforms to that; it does not add or weaken any guardrail. (The brief's "bypass / immediate execution" description does not match this branch's code; the plan reflects the code, per the brief's own "verify in the actual code — do not assume.")
- **SKU-scoped guarding reuses the cap + dollar-cap only.** The campaign-centric guardrail facts (`cooldown_minutes_per_campaign`, `min_spend_cents`, budget-cut %) are campaign-budget concepts. For a SKU move (`discontinue_sku`) there is no campaign budget to cut and no `campaign_id` for the cooldown filter, so Phase 4 applies a **SKU-scoped guard** (`checkSkuGuardrails`, Task 2) that reuses the *shared* config — `autopilot_enabled`, `autopilot_daily_action_cap` (counting the same `action_audit` autopilot rows), `dollar_impact_cap_without_2fa`, and `business_hours_only` — and skips the campaign-budget-only rules. Campaign-routed remediation moves (`reallocate_spend_sku` cutting a Meta campaign, `pause_campaign`, `reduce_campaign_budget`) keep using the existing campaign `checkGuardrails`.
- **No new detectors, no new ranking.** The decision is the stored `RemediationPlan`. Phase 4 never calls `rankMoves` itself in the act loop — it reads `alert.remediation.recommended`.
- **`negative_unit_economics` and `ad_tax_overload` stay in the candidate allow-list** (verified in `20260616132100_autopilot_candidates_add_scale.sql`). Phase 4 does **not** re-add them; it extends the view to also surface the *evidence + sku + remediation-relevant columns* for them (and to stop dropping the SKU-scoped ones that have no campaign), and routes them through remediation when the alert carries a `recommended` executable move.
- **The audit reasoning is deterministic, not model-written.** Built by `remediationReason()` (Task 1) from the plan numbers — honoring the spec's "deterministic reasoning + ranked numbers to the audit log." No assistant/prose call at execution time.

Detectors in scope (the 5 product-economics): `negative_unit_economics`, `ad_tax_overload`, `return_rate_hidden_loss`, `margin_erosion`, `cogs_drift`. Only those with a **non-null executable `recommended` move** are acted on; the rest fall through to existing behavior (campaign pause/reduce/scale) or are counted as skipped.

## ⚠️ DECISION REQUIRED — `v_autopilot_candidates` / `ad_tax_overload` fixture reroute (executor/human to decide; do NOT auto-resolve)

Extending `v_autopilot_candidates` (Task 3) + adding the remediation branch (Task 4) changes how the **existing** `ad_tax_overload` autopilot test fixtures route. Today those fixtures (`{ ...candidate, detector_id: "ad_tax_overload" }`, `campaign_id: "camp-uuid"`, **no** `evidence`) flow through the legacy reduce/reallocate path. After Phase 4, `ad_tax_overload` is a product-economics detector: `tryRemediation` runs the Phase-1 engine on empty/legacy evidence, which (per Phase 1) yields `structurallyDead=false` → `recommended: "reallocate_to_winner"` (executor flips to `"reallocate_spend_sku"` once enriched). Those fixtures would then route through the **remediation branch**, not the legacy reduce/reallocate path — so the existing assertions break. This is a real cross-phase collision (rule 7 — surfaced, not silently averaged), and per rule 12 the plan must NOT quietly rewrite the assertions. **Two resolution options — the executor/human picks one; this plan does not:**

- **Option A — rewrite the affected `ad_tax_overload` assertions to expect the remediation branch.** Accept that `ad_tax_overload` now routes through remediation and re-point each existing `ad_tax_overload` fixture's assertions at `executeReallocateSpendSku` / the enriched-move path (or give them evidence + a `sku_id` so the engine's eligibility is deterministic). Pro: the test reflects the new, intended product behavior. Con: a behavior change to existing green tests, so each rewrite must be justified in review, not blanket-applied.
- **Option B — gate the remediation branch so legacy fixtures keep their old routing.** Require `tryRemediation` to only engage when the candidate carries the remediation-relevant columns the new view adds (e.g. a non-null `evidence` and/or `sku_id`), so a legacy `ad_tax_overload` fixture with empty evidence falls through to the unchanged legacy path. Pro: zero change to existing tests; the new branch is opt-in on enriched candidates. Con: adds a gate condition that diverges autopilot from the merchant path for sparse-evidence alerts, which must be documented so it isn't mistaken for a bug.

Until this is decided, Task 5 Step 3 leaves the existing `ad_tax_overload` assertions untouched and flags the failure rather than rewriting it.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `app/lib/actions/remediation-reason.ts` | Pure `remediationReason(plan, recommended, detectorId) → string` — the deterministic audit sentence | 1 |
| `app/lib/actions/__tests__/remediation-reason.test.ts` | Reasoning-builder tests | 1 |
| `app/lib/actions/remediation-guard.server.ts` | `checkSkuGuardrails(shopId, input, sb)` — SKU-scoped guard reusing shared config | 2 |
| `app/lib/actions/__tests__/remediation-guard.test.ts` | SKU guard tests | 2 |
| `supabase/migrations/<ts>_autopilot_candidates_remediation.sql` | Extend `v_autopilot_candidates`: carry `evidence`, `sku`, `sku_id`; LEFT JOIN campaign so SKU-only economics alerts surface | 3 |
| `app/lib/actions/autopilot.server.ts` | New remediation branch: read `plan.recommended`, route executor, guard, execute, write deterministic reason; skip advisory/null/cap-blocked | 4, 5 |
| `app/lib/actions/__tests__/autopilot.test.ts` | End-to-end act test + skip test (append) | 4, 5 |

---

## Task 1: Deterministic audit-reasoning builder

The audit sentence is computed from the plan, never from the model (spec §"Decisions" item 2 + §"Data flow" autopilot row). It names the recommended move, the structurally-dead verdict, the recommended move's projected $ and the runner-up's $ ("vs cut_ads $Y").

**Files:**
- Create: `app/lib/actions/remediation-reason.ts`
- Test: `app/lib/actions/__tests__/remediation-reason.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/actions/__tests__/remediation-reason.test.ts
import { describe, it, expect } from "vitest";
import { remediationReason } from "../remediation-reason";
import type { RemediationPlan } from "../../remediation/types";

function plan(p: Partial<RemediationPlan>): RemediationPlan {
  return {
    moves: [
      { kind: "discontinue", dollarImpactCents: 400000, executor: "discontinue_sku", label: "Stop reordering this product" },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "discontinue",
    structurallyDead: true,
    ...p,
  };
}

describe("remediationReason", () => {
  it("names the recommended move, the structural verdict, and the projected dollars", () => {
    const s = remediationReason(plan({}), "discontinue", "negative_unit_economics");
    expect(s.toLowerCase()).toContain("discontinue");
    expect(s.toLowerCase()).toContain("structurally dead");
    expect(s).toContain("$4,000"); // 400000 cents → dollars
  });

  it("names the runner-up move and its dollars when one exists (ranked comparison)", () => {
    const s = remediationReason(
      plan({
        moves: [
          { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: "reallocate_spend_sku", label: "Move ad budget to a higher-margin product" },
          { kind: "cut_ads", dollarImpactCents: 420000, executor: "pause_campaign", label: "Cut the ad spend driving the loss" },
          { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
        ],
        recommended: "reallocate_to_winner",
        structurallyDead: false,
      }),
      "reallocate_to_winner",
      "negative_unit_economics",
    );
    expect(s.toLowerCase()).toContain("reallocate_to_winner");
    expect(s).toContain("$5,304"); // recommended 530449c
    expect(s).toContain("cut_ads");
    expect(s).toContain("$4,200"); // runner-up 420000c
  });

  it("omits the comparison clause when the only other move is snooze", () => {
    const s = remediationReason(plan({}), "discontinue", "negative_unit_economics");
    expect(s).not.toContain(" vs snooze");
  });

  it("is a non-empty single line (no newlines) for the audit column", () => {
    const s = remediationReason(plan({}), "discontinue", "cogs_drift");
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/actions/__tests__/remediation-reason.test.ts`
Expected: FAIL — `Failed to resolve import "../remediation-reason"`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/actions/remediation-reason.ts
// Deterministic audit reasoning for an autopilot remediation action. Built
// ENTIRELY from the stored RemediationPlan + detector — no model call at
// execution time (spec §"Decisions" item 2). The string is persisted to
// action_audit.trigger_reason so the merchant sees why autopilot acted and how
// the recommended move ranked against the runner-up.
import type { DetectorId } from "../types";
import type { MoveKind, RemediationPlan } from "../remediation/types";

function usd(cents: number): string {
  const dollars = Math.round(cents / 100);
  return "$" + Math.abs(dollars).toLocaleString("en-US");
}

/** One plain-language line: which move, why (structural verdict), projected 30d
 *  dollars, and the next-best alternative's dollars when one exists (so the
 *  ranking is legible in the log). Never empty, never multi-line. */
export function remediationReason(
  plan: RemediationPlan,
  recommended: MoveKind,
  detectorId: DetectorId,
): string {
  const rec = plan.moves.find((m) => m.kind === recommended);
  const recCents = rec?.dollarImpactCents ?? 0;

  const verdict = plan.structurallyDead
    ? "structurally dead (loses money at zero ad spend)"
    : "viable product, ad/return-driven loss";

  // Runner-up = the highest-$ move that is neither the recommendation nor snooze.
  const runnerUp = plan.moves.find(
    (m) => m.kind !== recommended && m.kind !== "snooze",
  );

  const head =
    `Autopilot recommended ${recommended} for ${detectorId} ` +
    `(${verdict}); projected 30d recovery ${usd(recCents)}`;

  const tail = runnerUp
    ? ` vs ${runnerUp.kind} ${usd(runnerUp.dollarImpactCents)}.`
    : ".";

  return head + tail;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/remediation-reason.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/remediation-reason.ts app/lib/actions/__tests__/remediation-reason.test.ts
git commit -m "actions/remediation-reason: deterministic autopilot audit sentence"
```

---

## Task 2: SKU-scoped guardrail check

`checkGuardrails` (campaign path) needs a `campaignId` (it interpolates it into a PostgREST `.or()` cooldown filter and reads campaign-budget facts). A SKU move (`discontinue_sku`) has no campaign and no budget to cut, so it cannot use that path. This task adds `checkSkuGuardrails`, which reuses the **shared** config rows the campaign guard already loads (`autopilot_enabled`, `autopilot_daily_action_cap`, `dollar_impact_cap_without_2fa`, `business_hours_only`) and the same `succeeded`-autopilot-row count, but skips the campaign-budget-only rules.

**Files:**
- Create: `app/lib/actions/remediation-guard.server.ts`
- Test: `app/lib/actions/__tests__/remediation-guard.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/actions/__tests__/remediation-guard.test.ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSkuGuardrails } from "../remediation-guard.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

// Minimal supabase double: guardrail_config.maybeSingle() returns the config
// row; action_audit count head-select returns `todayCount`.
function fakeSb(opts: { config: Record<string, unknown> | null; todayCount: number }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: opts.config, error: null }));
    // count head-select resolves via the awaited builder itself.
    chain.then = (resolve: (r: { count: number; error: null }) => unknown) =>
      resolve({ count: table === "action_audit" ? opts.todayCount : 0, error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const config = {
  autopilot_enabled: true,
  autopilot_daily_action_cap: 5,
  dollar_impact_cap_without_2fa: 100, // dollars → 10000 cents
  business_hours_only: false,
  business_hours_start_utc: 0,
  business_hours_end_utc: 0,
};

describe("checkSkuGuardrails", () => {
  it("allows a SKU move within cap and under the dollar cap", async () => {
    const sb = fakeSb({ config, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v.allowed).toBe(true);
  });

  it("blocks when autopilot is disabled", async () => {
    const sb = fakeSb({ config: { ...config, autopilot_enabled: false }, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v).toEqual({ allowed: false, reason: "auto-pilot disabled" });
  });

  it("blocks when the daily action cap is reached", async () => {
    const sb = fakeSb({ config, todayCount: 5 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 5000 }, sb);
    expect(v).toEqual({ allowed: false, reason: "daily action cap reached" });
  });

  it("blocks when the projected impact exceeds the dollar cap", async () => {
    const sb = fakeSb({ config, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 20000 }, sb); // > 10000c cap
    expect(v).toEqual({ allowed: false, reason: "dollar impact exceeds cap" });
  });

  it("blocks when there is no guardrail config", async () => {
    const sb = fakeSb({ config: null, todayCount: 0 });
    const v = await checkSkuGuardrails(SHOP, { dollarImpactCents: 1 }, sb);
    expect(v).toEqual({ allowed: false, reason: "no guardrail config" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/actions/__tests__/remediation-guard.test.ts`
Expected: FAIL — cannot resolve `../remediation-guard.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/actions/remediation-guard.server.ts
// SKU-scoped guardrail check for autopilot remediation moves that act on a
// product rather than a campaign (e.g. discontinue_sku). The campaign guard
// (guardrails.server.ts) needs a campaignId for its cooldown .or() filter and
// reads campaign-budget facts; a SKU move has neither. This reuses the SHARED
// config + the same autopilot-action-cap count so a SKU action and a campaign
// action draw from one budget, but applies only the kind-agnostic rules:
// enabled, daily action cap, dollar cap, business hours. No new guardrail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { withinBusinessHours, type GuardrailResult } from "./guardrails";

function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export interface SkuCheckInput {
  /** Projected 30d recovery in cents — checked against the per-action dollar cap. */
  dollarImpactCents: number;
}

export async function checkSkuGuardrails(
  shopId: string,
  input: SkuCheckInput,
  sb: SupabaseClient,
): Promise<GuardrailResult> {
  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_daily_action_cap, dollar_impact_cap_without_2fa, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  if (!row.autopilot_enabled) return { allowed: false, reason: "auto-pilot disabled" };

  const dailyActionCap = Number(row.autopilot_daily_action_cap ?? 0);
  const dollarCapCents = Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100);

  // Same cap accounting as the campaign guard: only landed (`succeeded`)
  // autopilot actions for today (UTC) consume the cap.
  const { count } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("outcome", "succeeded")
    .gte("created_at", startOfUtcDayIso());
  if ((count ?? 0) >= dailyActionCap) return { allowed: false, reason: "daily action cap reached" };

  if (input.dollarImpactCents > dollarCapCents) {
    return { allowed: false, reason: "dollar impact exceeds cap" };
  }

  if (
    row.business_hours_only &&
    !withinBusinessHours(
      Number(row.business_hours_start_utc ?? 0),
      Number(row.business_hours_end_utc ?? 0),
      new Date().getUTCHours(),
    )
  ) {
    return { allowed: false, reason: "outside business hours" };
  }

  return { allowed: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/remediation-guard.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/remediation-guard.server.ts app/lib/actions/__tests__/remediation-guard.test.ts
git commit -m "actions/remediation-guard: SKU-scoped autopilot guard (shared cap + dollar cap)"
```

---

## Task 3: Extend `v_autopilot_candidates` to feed remediation

Today the candidate view (`20260606150000` / `20260616132100`) **inner-joins** `ad_campaign_dim` on `entity_ref->>'campaign_id'` and selects only campaign columns + 7d spend. A SKU-scoped economics alert (no `campaign_id`) is therefore dropped, and the view carries no `evidence` for the engine to rank from. To act on `plan.recommended` autopilot needs the same `RemediationPlan` `attachRemediation()` computes — which needs `detector_id`, `dollar_impact`, and `evidence` (and `sku`/`sku_id` for SKU targeting). Extend the view to carry those and switch the campaign join to LEFT so SKU-only economics alerts surface.

**Files:**
- Create: `supabase/migrations/<timestamp>_autopilot_candidates_remediation.sql` (use `prisma migrate dev` / the repo's Supabase migration tooling to generate the file — do not hand-name; `<timestamp>` per convention)

- [ ] **Step 1: Write the migration**

```sql
-- Phase 4 (product-economics remediation): autopilot must act on the stored
-- RemediationPlan, which is computed from detector + dollar_impact + evidence,
-- targeting a SKU (discontinue_sku) or a campaign (reallocate_spend_sku / cut).
-- The prior view inner-joined ad_campaign_dim, so SKU-only economics alerts
-- (no entity_ref.campaign_id) were dropped and no evidence was carried. This
-- revision: (1) LEFT JOINs the campaign so SKU-only rows survive, (2) carries
-- evidence + sku + sku_id, (3) keeps the existing detector allow-list and the
-- campaign-spend column (now null-safe for SKU-only rows). security_invoker so
-- per-shop RLS still applies. Body otherwise mirrors 20260616132100.
create or replace view public.v_autopilot_candidates
with (security_invoker = true) as
select
  a.id            as alert_id,
  a.shop_id       as shop_id,
  a.detector_id   as detector_id,
  a.dollar_impact as dollar_impact,
  c.id            as campaign_id,
  coalesce(c.daily_budget_cents, 0) as daily_budget_cents,
  coalesce((
    select sum(s.spend_cents) from public.ad_spend_fact s
    where s.campaign_id = c.id and s.day >= (current_date - 7)
  ), 0) as campaign_spend_cents,
  -- New for remediation: the engine ranks from evidence; SKU moves target sku/sku_id.
  coalesce(ac.evidence, '{}'::jsonb) as evidence,
  coalesce(a.entity_ref ->> 'sku', sku.sku) as sku,
  a.entity_ref ->> 'sku_id' as sku_id
from public.alerts a
  left join public.ad_campaign_dim c on c.id = (a.entity_ref ->> 'campaign_id')::uuid
  left join public.alert_context ac  on ac.alert_id = a.id
  left join public.sku_dim sku       on sku.id::text = a.entity_ref ->> 'sku_id'
where a.status = 'open'
  and a.detector_id in (
    'campaign_below_breakeven',
    'negative_unit_economics',
    'ad_tax_overload',
    'campaign_scaling_opportunity'
  );
```

- [ ] **Step 2: Validate the migration**

Run: `npx prisma migrate diff --exit-code` (or the repo's Supabase migration check). Confirm the view compiles against the schema: `alert_context.evidence`, `sku_dim.sku`, and `alerts.entity_ref` all exist (verified against `20260613160000_alerts_snoozed_until_and_view.sql`, which uses the same joins).
Expected: migration applies cleanly; existing campaign-routed candidates are unchanged (still have a non-null `campaign_id`, `daily_budget_cents`, `campaign_spend_cents`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/*_autopilot_candidates_remediation.sql
git commit -m "supabase/v_autopilot_candidates: carry evidence + sku for remediation; LEFT JOIN campaign"
```

---

## Task 4: Autopilot remediation branch — act on `plan.recommended`

Add a remediation branch to `runAutopilotForShop`. For a product-economics candidate, build the plan from the row (reusing the Phase-1 `rankMoves`), then run it through the Phase-3 `enrichRemediation` resolver — the SAME one the merchant detail paths call, so the executable `target`/`executor` is filled identically (autopilot does NOT re-derive the winner/campaign). Read `plan.recommended`, find that move, and — if it has a non-null executable executor and passes the right guard — execute it through the matching seam (Phase-2 `executeDiscontinueAlertAction` / Phase-3 `executeReallocateSpendSku` / existing `executeAction`) with the deterministic reason. The existing campaign pause/reduce/scale logic stays for non-remediation candidates and as the fallback when a product-economics alert has no executable recommendation.

**Files:**
- Modify: `app/lib/actions/autopilot.server.ts`
- Test: `app/lib/actions/__tests__/autopilot.test.ts` (append in Task 5)

- [ ] **Step 1: Widen the `Candidate` shape + imports**

At the top of `app/lib/actions/autopilot.server.ts`, add the remediation imports beside the existing ones:

```typescript
import { rankMoves, toNumericEvidence } from "../remediation/rank";
import { enrichRemediation } from "../remediation/enrich.server"; // Phase 3 resolver
import type { MoveKind, StrategicMove } from "../remediation/types";
import { remediationReason } from "./remediation-reason";
import { checkSkuGuardrails } from "./remediation-guard.server";
import { executeDiscontinueAlertAction } from "./alert-action.server"; // Phase 2 gateway
import { executeReallocateSpendSku } from "./reallocate-sku.server"; // Phase 3 gateway
import { calderynClient } from "../calderyn.server";
import type { Alert, DetectorId } from "../types";
```

> The executor seams are the REAL Phase 2/3 gateways, NOT standalone `executeDiscontinueSku`/`executeReallocateSpendSku(shopId, input, sb)` functions (those never existed — that was Phase 4's guess). Phase 2 ships **`executeDiscontinueAlertAction(opts)`** in `alert-action.server.ts` (modeled on `executeInventoryAlertAction`); Phase 3 ships **`executeReallocateSpendSku(opts)`** in `reallocate-sku.server.ts` (which itself delegates to the shipped `executeReallocation`). Both take a single `opts` object with a `client` (a slice of `calderynClient(shop)`), and Phase 2 additionally needs a Shopify `admin` client; both re-derive their trust-boundary inputs from the alert record — autopilot passes the alert id + idempotency key + `triggerReason`, never campaign/sku ids it resolved itself. `pause_campaign` / `reduce_campaign_budget` keep using the existing positional campaign seam `executeAction(shopId, input, sb)`. Do not invent a new executor here.

Extend the `Candidate` interface (after `daily_budget_cents`):

```typescript
interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number; // dollars
  campaign_id: string | null; // now nullable: SKU-only economics alerts have none
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
  // New (Task 3 view): for the remediation plan + SKU targeting.
  evidence: Record<string, unknown> | null;
  sku: string | null;
  sku_id: string | null;
}
```

Update the candidate `.select(...)` string to pull the new columns:

```typescript
    .select(
      "alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents, evidence, sku, sku_id",
    )
```

- [ ] **Step 2: Add the set of remediation detectors + the branch helper**

Add near the other detector sets at the top of the file:

```typescript
const PRODUCT_ECON_DETECTORS = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

// Maps a plan move's executor to a guarded execution. Returns "acted" |
// "blocked" | "skipped" | "fell_through". "fell_through" means "not an
// executable remediation move — let the legacy campaign logic handle it".
type RemediationOutcome = "acted" | "blocked" | "skipped" | "fell_through";
```

Add the branch function (place it above `runAutopilotForShop`):

```typescript
/** Try to act on the candidate's stored remediation recommendation. Returns
 *  whether it acted/blocked/skipped, or "fell_through" to defer to the legacy
 *  campaign logic. The decision is the Phase-1 plan + the Phase-3 enrichment —
 *  we never re-rank or re-resolve the winner/campaign here (re-deriving would
 *  drift from the merchant path, which routes the *same* enriched move). */
async function tryRemediation(
  shopId: string,
  c: Candidate,
  sb: SupabaseClient,
): Promise<RemediationOutcome> {
  if (!PRODUCT_ECON_DETECTORS.has(c.detector_id as DetectorId)) return "fell_through";

  // Reuse the Phase-1 engine on the candidate's own evidence — identical input
  // to attachRemediation(), so autopilot and the UI agree on the recommendation.
  const dollarImpactCentsAlert = Math.round(Number(c.dollar_impact) * 100);
  const basePlan = rankMoves({
    detectorId: c.detector_id as DetectorId,
    dollarImpactCents: dollarImpactCentsAlert,
    evidence: toNumericEvidence(c.evidence ?? {}),
  });

  // Phase-3 enrichment fills the executable target + flips executor null →
  // "reallocate_spend_sku"/cut kinds. Phase 4 calls the SAME resolver the
  // merchant detail paths call — it does NOT re-derive the winner/campaign
  // itself (re-deriving here would drift from the merchant path). enrich takes
  // an Alert-shaped object; the candidate row carries everything it reads
  // (id, detector_id, dollar_impact, evidence with sku_id).
  const alertForEnrich = {
    id: c.alert_id,
    detector_id: c.detector_id as DetectorId,
    dollar_impact: dollarImpactCentsAlert,
    evidence: { ...(c.evidence ?? {}), sku_id: c.sku_id ?? undefined },
  } as unknown as Alert;
  const plan = await enrichRemediation(alertForEnrich, basePlan, sb, shopId);

  const recommended = plan.recommended;
  if (!recommended) {
    // Only snooze applies → nothing to automate. Surface, don't drop (rule 12).
    console.info(`[autopilot] remediation skip on alert ${c.alert_id}: no recommended move`);
    return "skipped";
  }
  const move: StrategicMove | undefined = plan.moves.find((m) => m.kind === recommended);

  // Advisory / not-yet-executable recommendation (executor null, or snooze):
  // autopilot does not auto-snooze and does not act on advisory moves. This
  // includes a reallocate_to_winner that enrichRemediation left advisory
  // (no dedicated campaign / no winner → executor stayed null). Fall through so
  // the legacy campaign logic can still pause/reduce if applicable.
  if (!move || move.executor == null || move.executor === "snooze_alert") {
    console.info(
      `[autopilot] remediation skip on alert ${c.alert_id}: recommended ${recommended} is advisory/non-executable`,
    );
    return "fell_through";
  }

  const dollarImpactCents = move.dollarImpactCents;
  const reason = remediationReason(plan, recommended, c.detector_id as DetectorId);
  const idempotencyKey = `autopilot:${c.alert_id}:${move.executor}`;

  // SKU-scoped move (discontinue_sku): SKU guard, no campaign needed. The Phase-2
  // gateway takes a single opts object with a `client` (slice of calderynClient)
  // and a Shopify `admin` client; it re-derives the product GID from the alert's
  // own SKU record (never request input). Autopilot passes the alert id + reason.
  if (move.executor === "discontinue_sku") {
    if (!c.sku_id) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: discontinue_sku has no sku_id`);
      return "blocked";
    }
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    const client = calderynClient(shopId);
    const { admin } = await (await import("~/shopify.server")).unauthenticated.admin(shopId);
    await executeDiscontinueAlertAction({
      client,
      admin,
      sb,
      shopId,
      alertId: c.alert_id,
      kind: "discontinue_sku",
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    return "acted";
  }

  // Campaign-scoped remediation moves: reallocate_spend_sku, or a plain cut via
  // pause/reduce. These need a campaign; without one, block (rule 12 — the
  // engine should not have offered an executable campaign move with no campaign).
  if (!c.campaign_id) {
    console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${move.executor} needs a campaign`);
    return "blocked";
  }

  // SKU budget shift: route to the Phase-3 SKU gateway. It re-runs
  // enrichRemediation server-side to re-resolve the loser→winner pair from the
  // trusted alert (it does NOT trust client-supplied campaign ids), then
  // delegates to the shipped executeReallocation. Autopilot passes only the
  // alert id + idempotency key + reason; the enriched `target` we read above is
  // used solely to confirm executor === "reallocate_spend_sku" before routing.
  if (move.executor === "reallocate_spend_sku") {
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    const client = calderynClient(shopId);
    await executeReallocateSpendSku({
      client,
      sb,
      shopId,
      alertId: c.alert_id,
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    return "acted";
  }

  // Plain cut: pause_campaign / reduce_campaign_budget through the existing
  // campaign executor seam executeAction(shopId, ExecuteInput, sb) + the
  // campaign guard. triggerReason flows through ExecuteInput.triggerReason.
  if (move.executor === "pause_campaign" || move.executor === "reduce_campaign_budget") {
    const currentBudgetCents = c.daily_budget_cents ?? null;
    const newBudgetCents =
      move.executor === "reduce_campaign_budget" && currentBudgetCents != null
        ? Math.round(currentBudgetCents * 0.5) // mirror DEFAULT_MAX_CUT_PCT (guard enforces the live value)
        : undefined;
    if (move.executor === "reduce_campaign_budget" && !newBudgetCents) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: no current budget to cut`);
      return "blocked";
    }
    const verdict = await checkGuardrails(
      shopId,
      {
        kind: move.executor,
        campaignId: c.campaign_id,
        dollarImpactCents,
        campaignSpendCents: c.campaign_spend_cents,
        currentBudgetCents: currentBudgetCents ?? undefined,
        newBudgetCents,
      },
      sb,
    );
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    await executeAction(
      shopId,
      {
        alertId: c.alert_id,
        kind: move.executor,
        campaignId: c.campaign_id,
        idempotencyKey,
        dailyBudgetCents: newBudgetCents,
        actor: "autopilot",
        triggerReason: reason,
      },
      sb,
    );
    return "acted";
  }

  // Unknown executor union member — fail visibly rather than silently dropping.
  console.warn(`[autopilot] remediation skip on alert ${c.alert_id}: unhandled executor ${move.executor}`);
  return "skipped";
}
```

> The `MoveKind` import is used for the `recommended`/`move.kind` typing through `StrategicMove`. The executor literals (`"discontinue_sku"`, `"reallocate_spend_sku"`, `"pause_campaign"`, `"reduce_campaign_budget"`, `"snooze_alert"`, `null`) are the Phase-2/3-widened `StrategicMove.executor` union — spelled identically here and in `remediation/types.ts`.

- [ ] **Step 3: Call the branch first inside the candidate loop**

Inside the `for (const c of ordered)` loop, at the very top of the `try { ... }`, call `tryRemediation` before the existing `kind` selection. When it acts/blocks/skips, account for it and `continue`; only `"fell_through"` proceeds to the legacy `kind` logic:

```typescript
    try {
      const rem = await tryRemediation(shopId, c, sb);
      if (rem === "acted") { acted += 1; continue; }
      if (rem === "blocked") { blocked += 1; continue; }
      if (rem === "skipped") { skipped += 1; continue; }
      // rem === "fell_through": legacy campaign logic below.

      let kind: ExecutableKind | null = null;
      // ... existing pause/reduce/scale logic unchanged ...
```

Add a `skipped` counter beside `acted`/`blocked`/`failed`, add `skipped` to `AutopilotSummary`, and include it in the returned object:

```typescript
export interface AutopilotSummary {
  skipped: boolean; // (existing) whole-run skip when autopilot disabled
  acted: number;
  blocked: number;
  /** Remediation recommendations that were advisory/non-executable and not acted
   *  on (distinct from `blocked`, which is a guardrail/cap/precondition refusal). */
  skippedMoves: number;
  failed: number;
}
```

> Note the existing `AutopilotSummary.skipped: boolean` is the *whole-run* skip (autopilot off). Use a separate field name `skippedMoves: number` for per-candidate advisory skips to avoid colliding with it. Update the early-return `return { skipped: true, acted: 0, blocked: 0, skippedMoves: 0, failed: 0 }` and the final `return { skipped: false, acted, blocked, skippedMoves, failed }`. Update `cron.autopilot.tsx`'s summary aggregation to add `skippedMoves` (and the `cron.autopilot.test.ts` expectations) — small, mechanical.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. This **requires** Phase 2/3 to have widened `StrategicMove.executor` (+ added `target`), shipped `executeDiscontinueAlertAction` (`alert-action.server.ts`) and `executeReallocateSpendSku` (`reallocate-sku.server.ts`) and `enrichRemediation` (`enrich.server.ts`), and added `discontinue_sku` / `reallocate_spend_sku` to `ActionKind`. If those are absent, stop and confirm Phase 2/3 are merged before continuing (Scope dependency).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/autopilot.server.ts app/routes/cron.autopilot.tsx app/routes/__tests__/cron.autopilot.test.ts
git commit -m "actions/autopilot: act on stored remediation recommendation within guardrails"
```

---

## Task 5: End-to-end act test + advisory-skip test

Mirror the existing `autopilot.test.ts` mocking style (`vi.hoisted` + `vi.mock` per executor module; the `fakeSb` builder whose `.then` returns `v_autopilot_candidates` rows). Add a mock for the new modules and assert: (a) a `recommended` executable move executes via the right seam with the deterministic `trigger_reason`, respecting the cap; (b) an advisory/null `recommended` is not acted on and is surfaced as a skip.

**Files:**
- Modify: `app/lib/actions/__tests__/autopilot.test.ts` (append; extend the mock block)

- [ ] **Step 1: Extend the mock block (top of file)**

Add the new executor + guard mocks to the existing `vi.hoisted` / `vi.mock` set:

```typescript
const {
  checkGuardrails, executeAction, executeReallocation,
  loadReallocationCandidates, pickReallocation,
  checkSkuGuardrails, executeDiscontinueAlertAction, executeReallocateSpendSku,
  enrichRemediation, calderynClient, unauthenticatedAdmin,
} = vi.hoisted(() => ({
  checkGuardrails: vi.fn(),
  executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })),
  executeReallocation: vi.fn(async () => ({ id: "aud2", outcome: "succeeded" })),
  loadReallocationCandidates: vi.fn(async () => []),
  pickReallocation: vi.fn(() => ({ source: null, dest: null })),
  checkSkuGuardrails: vi.fn(async () => ({ allowed: true })),
  // Both gateways take a single opts object and return { auditId, outcome, acknowledged }.
  executeDiscontinueAlertAction: vi.fn(async () => ({ auditId: "aud3", outcome: "succeeded", acknowledged: true })),
  executeReallocateSpendSku: vi.fn(async () => ({ auditId: "aud4", outcome: "succeeded", acknowledged: true })),
  // Phase-3 resolver is mocked here to isolate routing from the DB read; it is
  // exercised for-real in its own enrich.test.ts (Phase 3). Default = identity.
  enrichRemediation: vi.fn(async (_alert: unknown, plan: unknown) => plan),
  calderynClient: vi.fn(() => ({})),
  unauthenticatedAdmin: vi.fn(async () => ({ admin: {} })),
}));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));
vi.mock("../reallocate.server", () => ({ executeReallocation }));
vi.mock("../reallocation-suggest.server", () => ({ loadReallocationCandidates, pickReallocation }));
vi.mock("../remediation-guard.server", () => ({ checkSkuGuardrails }));
vi.mock("../remediation/enrich.server", () => ({ enrichRemediation }));
vi.mock("../alert-action.server", () => ({ executeDiscontinueAlertAction }));
vi.mock("../reallocate-sku.server", () => ({ executeReallocateSpendSku }));
vi.mock("../calderyn.server", () => ({ calderynClient }));
vi.mock("~/shopify.server", () => ({ unauthenticated: { admin: unauthenticatedAdmin } }));
```

> `rankMoves` / `toNumericEvidence` / `remediationReason` are **pure** and intentionally NOT mocked — the test exercises the real ranking + real reasoning string end-to-end (rule 9: the test checks behavior, not a stub). `enrichRemediation` IS mocked (identity by default) so this suite tests routing, not the SKU→campaign DB resolution (which Phase 3's `enrich.test.ts` owns); for the reallocate test, set `enrichRemediation.mockResolvedValueOnce` to a plan whose `reallocate_to_winner` move has `executor: "reallocate_spend_sku"` so the branch routes.

- [ ] **Step 2: Add the act + skip tests (append to the describe block)**

```typescript
  // Structurally-dead SKU economics alert (no campaign): plan.recommended ==
  // "discontinue", executor "discontinue_sku" → executes via the SKU seam.
  const deadSku = {
    alert_id: "al-dead", detector_id: "negative_unit_economics", dollar_impact: 4000,
    campaign_id: null, campaign_spend_cents: 0, daily_budget_cents: null,
    evidence: { gross_unit_margin_usd: -4, net_per_unit_usd: -34 }, sku: "Dead Tee — M", sku_id: "sku-1",
  };

  it("acts on a discontinue recommendation via the SKU seam with a deterministic reason", async () => {
    checkSkuGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [deadSku] });
    const r = await runAutopilotForShop(SHOP, sb);
    // The Phase-2 gateway takes a SINGLE opts object (client + admin + sb + ids).
    expect(executeDiscontinueAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP,
        alertId: "al-dead",
        kind: "discontinue_sku",
        actor: "autopilot",
        idempotencyKey: "autopilot:al-dead:discontinue_sku",
        sb,
      }),
    );
    const [opts] = executeDiscontinueAlertAction.mock.calls[0] as unknown as [{ triggerReason: string }];
    expect(opts.triggerReason).toContain("discontinue");
    expect(opts.triggerReason).toContain("structurally dead");
    expect(opts.triggerReason).toContain("$4,000");
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(1);
  });

  it("respects the daily action cap on a remediation move (blocked, no execution)", async () => {
    checkSkuGuardrails.mockResolvedValue({ allowed: false, reason: "daily action cap reached" });
    const sb = fakeSb({ enabled: true, alerts: [deadSku] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
    expect(r.acted).toBe(0);
  });

  // Viable margin-erosion alert: plan.recommended == "review_pricing", which is
  // advisory (executor null) → autopilot does NOT act; it surfaces a skip.
  it("does NOT act on an advisory recommendation and surfaces it as a skip", async () => {
    const advisory = {
      alert_id: "al-adv", detector_id: "margin_erosion", dollar_impact: 200,
      campaign_id: null, campaign_spend_cents: 0, daily_budget_cents: null,
      evidence: { baseline_unit_margin_usd: 18, current_unit_margin_usd: 7, drop_pct: 61 },
      sku: "Slim Margin Tee", sku_id: "sku-2",
    };
    const sb = fakeSb({ enabled: true, alerts: [advisory] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeDiscontinueAlertAction).not.toHaveBeenCalled();
    expect(executeReallocateSpendSku).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.acted).toBe(0);
    // review_pricing is advisory → "fell_through" to legacy logic, which has no
    // campaign action for a SKU-only margin_erosion alert, so nothing is done.
    expect(r.skippedMoves + r.blocked).toBe(0);
  });
```

> If Phase 1 ranks a SKU-only `margin_erosion` to `review_pricing` (advisory, executor null), `tryRemediation` returns `"fell_through"`; the legacy logic then finds no `kind` for `margin_erosion` (not in `PAUSE_DETECTORS`/`BUDGET_DETECTORS`/`SCALE_DETECTORS`) and `continue`s without counting — so `acted/blocked/skippedMoves` stay 0. Confirm against Phase 1's actual `rankMoves` output (the imported real engine); if it instead returns `null` recommended, `tryRemediation` returns `"skipped"` and `r.skippedMoves === 1` — adjust the final assertion to match the real engine, do not change the engine.

- [ ] **Step 3: Run the autopilot suite**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS — all existing tests plus the 3 new ones. Existing tests still green because non-product-economics candidates (`campaign_below_breakeven`, `campaign_scaling_opportunity`) return `"fell_through"` from `tryRemediation` and hit the unchanged legacy path; their candidate rows now also carry the new (ignored-by-legacy) columns.

> **This is the cross-phase collision flagged in the ⚠️ DECISION REQUIRED callout (Scope section) — do not resolve it inside this step.** The existing `ad_tax_overload` fixtures (`{ ...candidate, detector_id: "ad_tax_overload" }`, `campaign_id: "camp-uuid"`, no `evidence`) now route through the remediation branch instead of the legacy reduce/reallocate path (`tryRemediation` runs the real engine on `{}` evidence → `structurallyDead=false` → `reallocate_to_winner` → enriched executor `reallocate_spend_sku`), so their assertions break. Per rule 12 / rule 7, leave those existing assertions **untouched** and let the run fail visibly; the executor/human chooses Option A (rewrite the assertions to expect the remediation branch) or Option B (gate the branch so legacy fixtures keep their old routing) per the callout. Do not blanket-rewrite here.

- [ ] **Step 4: Commit**

```bash
git add app/lib/actions/__tests__/autopilot.test.ts
git commit -m "actions/autopilot: end-to-end remediation act + advisory-skip tests"
```

---

## Task 6: Full gate + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the touched suites**

Run: `npx vitest run app/lib/actions/__tests__/remediation-reason.test.ts app/lib/actions/__tests__/remediation-guard.test.ts app/lib/actions/__tests__/autopilot.test.ts app/routes/__tests__/cron.autopilot.test.ts`
Expected: all PASS.

- [ ] **Step 2: Run the repo pre-commit gate (per CLAUDE.md)**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: each exits 0. If a migration changed, also `npx prisma migrate diff --exit-code`. Fix root causes; do not `--no-verify`, disable lint, or narrow types to silence `tsc`.

- [ ] **Step 3: Patch sanity**

Run: `git diff --check` and `git log --oneline -10`
Expected: no whitespace errors; no stray `console.log` beyond the intentional `console.info`/`console.warn` skip-surfacing (rule 12), no `.only`, no commented-out blocks.

- [ ] **Step 4: `/code-review` the branch and resolve blockers**

Run the `/code-review` slash command on the working tree; resolve every blocker, downgrade nits with a one-line justification.

---

## Self-review (against the spec)

- **Spec §"Phases" item 4 ("Autopilot picks the top-ranked move within guardrails/caps, executes, writes deterministic reasoning + ranked numbers"):** Task 4 reads `plan.recommended`, routes the executor, guards (Tasks 2 + existing `checkGuardrails`), executes; Task 1 builds the deterministic reasoning with ranked numbers. ✓
- **Spec §"Decisions" item 2 ("deterministic pick + AI prose; autopilot uses the same ranking"):** Task 4 reuses the Phase-1 `rankMoves` on the candidate's own evidence (same input as `attachRemediation`), then the **same** Phase-3 `enrichRemediation(alert, plan, sb, shopId)` the merchant detail paths call — autopilot never re-derives the winner/campaign (re-deriving would drift from the merchant path); Task 1's reasoning is template, not model. ✓
- **Spec §"Data flow" (autopilot row: reads plan.recommended → guardrail/cap check → execute → audit reasoning + ranked numbers):** matched exactly by `tryRemediation`. ✓
- **Spec §"Components" / "Autopilot (P4)" (`v_autopilot_candidates` + `autopilot.server.ts` consume `plan.recommended`):** Task 3 (view) + Task 4 (loop). ✓
- **Spec §"Failure visibility" (rule 12):** every non-act path is logged and counted — advisory/null `recommended` → `console.info` + `skipped`/`fell_through`; guardrail/cap refusal → `console.info` + `blocked`; missing `sku_id`/`campaign_id` → `blocked`; unknown executor → `console.warn` + `skipped`. Nothing silently dropped. ✓
- **CROSS-PHASE CONTRACT (advisory/null/guardrail-fail → no act, fall through):** Task 4 returns `"fell_through"` for advisory/snooze recommendations so legacy behavior is preserved; cap-blocked → `"blocked"`, no execution. Task 5 asserts both the act and the skip. ✓
- **Allow-list (`negative_unit_economics`/`ad_tax_overload` already present):** Task 3 keeps the existing `detector_id in (...)` list; it does not re-add them, only widens columns + the campaign join. ✓
- **Guardrails behavior (no bypass / no immediate-execute):** Scope note + Task 2 + Task 4 all conform to the *actual* `checkGuardrails`/`evaluateGuardrails` (cap, dollar cap, cooldown, business hours). No bypass introduced. ✓

**Type-consistency check (spelled identically everywhere — matched to the REAL Phase 2/3 signatures):**
- `MoveKind` = `"discontinue" | "cut_ads" | "reallocate_to_winner" | "fix_returns" | "review_pricing" | "snooze"` — `remediation/types.ts` (source of truth), read in `remediation-reason.ts` and `autopilot.server.ts`.
- `StrategicMove.executor` (Phase-2/3-widened) = `"snooze_alert" | "discontinue_sku" | "reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget" | null` — declared once in `remediation/types.ts` (Phase 2 added `"discontinue_sku"`, Phase 3 added the rest additively), switched on identically in `tryRemediation`.
- `StrategicMove.target` (Phase-3-added, filled by `enrichRemediation`) = `{ skuId?: string; loserCampaignId?: string; winnerSkuId?: string; winnerCampaignId?: string; winnerLabel?: string; amountCents?: number }` — read (not constructed) by Phase 4 only to confirm `executor === "reallocate_spend_sku"` before routing; the Phase-3 gateway re-derives the concrete refs itself.
- `ActionKind` gains `"discontinue_sku"`, `"reallocate_spend_sku"` in Phase 2/3 (`app/lib/types.ts`); used in the audit `action_kind` written by those executors.
- **Phase-2 executor seam (`discontinue_sku`)** — the REAL gateway, single `opts` object: **`executeDiscontinueAlertAction(opts: { client: AlertActionClient; admin: AdminGraphqlClient; sb: SupabaseClient; shopId: string; alertId: string; kind: "discontinue_sku"; idempotencyKey: string; actor?: string; triggerReason?: string | null; signal?: AbortSignal }): Promise<{ auditId: string; outcome: string; acknowledged: boolean }>`** in `app/lib/actions/alert-action.server.ts`. It derives the product GID from the alert's own SKU — autopilot passes no `skuId`. (NOT a standalone `executeDiscontinueSku(shopId, input, sb)` — that signature was Phase 4's guess and does not exist.)
- **Phase-3 executor seam (`reallocate_spend_sku`)** — the REAL gateway, single `opts` object: **`executeReallocateSpendSku(opts: { client: ReallocateSkuClient; sb: SupabaseClient; shopId: string; alertId: string; idempotencyKey: string; actor?: string; triggerReason?: string; signal?: AbortSignal }): Promise<{ auditId: string; outcome: string; acknowledged: boolean }>`** in `app/lib/actions/reallocate-sku.server.ts`. It re-runs `enrichRemediation` + delegates to `executeReallocation` — autopilot passes no `sourceCampaignId`/`loserSkuId`. (NOT a standalone `executeReallocateSpendSku(shopId, input, sb)`.)
- **Phase-3 enrichment resolver:** **`enrichRemediation(alert: Alert, plan: RemediationPlan, sb: SupabaseClient, shopId: string): Promise<RemediationPlan>`** in `app/lib/remediation/enrich.server.ts` — returns a NEW plan (no mutation), filling `executor`/`target`/`ineligibleReason` on the `reallocate_to_winner` move. Phase 4 calls it on the alert+plan **before** reading `recommended`'s executor/target; it does NOT re-resolve the winner.
- **Existing campaign seam (`pause_campaign`/`reduce_campaign_budget`):** **`executeAction(shopId: string, input: ExecuteInput, sb: SupabaseClient)`** in `execute.server.ts`; the deterministic reason flows through `ExecuteInput.triggerReason?: string`.
- Reasoning-builder signature, spelled identically in the impl, its test, and the call site: **`remediationReason(plan: RemediationPlan, recommended: MoveKind, detectorId: DetectorId): string`**.
- SKU guard signature: **`checkSkuGuardrails(shopId: string, input: { dollarImpactCents: number }, sb: SupabaseClient): Promise<GuardrailResult>`** — `GuardrailResult` reused from `guardrails.ts`.
- `RemediationPlan` / `RemediationInput` imported from `app/lib/remediation/types.ts`; `rankMoves` / `toNumericEvidence` from `app/lib/remediation/rank.ts`; `enrichRemediation` from `app/lib/remediation/enrich.server.ts`.

**Open decision (surfaced, not resolved):** the `v_autopilot_candidates` / `ad_tax_overload` fixture reroute — see the **⚠️ DECISION REQUIRED** callout in the Scope section. Option A (rewrite the assertions) vs Option B (gate the branch) is left to the executor/human; Task 5 Step 3 fails visibly rather than picking one (rule 7 / rule 12).

**No placeholders:** every code step is complete (the reasoning builder, the SKU guard, the migration, the autopilot branch, and the tests are all full).
