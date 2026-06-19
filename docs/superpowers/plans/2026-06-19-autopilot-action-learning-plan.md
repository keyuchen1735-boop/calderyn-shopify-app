# Autopilot Action-Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make autopilot learn its action policy — a per-`(shop, detector, action)` aggressiveness dial `μ∈[0,1]` seeded from anonymized peer outcomes and updated nightly from its own action results — and add deterministic targeting so shop/SKU-scoped problems can finally pause/reallocate.

**Architecture:** Hybrid, mirroring the existing moat threshold-trainer. TRAIN is Python (reuses `update_threshold`, `pseudonym_for`, `gmv_band_for_shop`, the cohort-runner shape) reading `action_audit ⋈ ad_spend_fact`. CONSUME is TypeScript inside `runAutopilotForShop`, reading new `moat.action_models` via the `moat_keys.shop_pseudonym` mapping. The merchant guardrail is always the hard ceiling; `μ` only scales *within* it. Falls through to today's full-cap behavior until a model row exists.

**Tech Stack:** TypeScript (Remix, Vitest, `@supabase/supabase-js`); Python 3.13 (`asyncpg`, `pytest`, `structlog`); Supabase Postgres (`moat` schema); Vercel cron + Python serverless function.

**Source of truth:** `docs/superpowers/specs/2026-06-19-autopilot-action-learning-design.md`. Slice IDs (D1–D6) and invariants A1–A5 refer to that spec.

**Ship order:** Part 1 (D6 targeting) is independent, deterministic, and delivers user-visible value (reduce/reallocate finally fire) — ship it first. Part 0 (migration) + Part 2 (D1–D5 learning loop) follow; the loop is correct-but-dormant until autopilot accrues actions and a GMV segment reaches k≥5.

**Rebase note:** these branches assume `feat/autopilot-observability` (stream A) is merged first — it widens `AutopilotSummary` with `decisions[]`. Part 1/Part 2 build on that shape; do not revert it.

---

## File structure

| File | Responsibility | Part |
|---|---|---|
| `app/lib/actions/autopilot-targeting.server.ts` (create) | Resolve a campaign target for shop/SKU-scoped detectors → synthetic `Candidate[]` | 1 (D6) |
| `app/lib/actions/autopilot.server.ts` (modify) | Merge scoped candidates into the loop; apply learned `μ` to cut/scale magnitude | 1, 2 |
| `supabase/migrations/20260619140000_autopilot_action_models.sql` (create) | `moat.action_models` + `moat.action_baselines` tables | 0 |
| `engine/calderyn_engine/moat/action_rewards.py` (create) | Pure `compute_action_reward` kernel | 2 (D1) |
| `engine/calderyn_engine/moat/action_reward_inputs.py` (create) | `derive_action_reward_inputs` (action_audit ⋈ ad_spend_fact, ±14d) | 2 (D1) |
| `engine/calderyn_engine/moat/action_peer_etl.py` (create) | `run_action_peer_etl` → `moat.action_baselines` (consent + k≥5) | 2 (D2) |
| `engine/calderyn_engine/moat/action_trainer.py` (create) | `train_action_policies` (seed→fold→rescale→upsert) | 2 (D3) |
| `engine/_autopilot_train_core.py` (create) | `handle(body, authorization)` — auth, run ETL + trainer | 2 (D3) |
| `api/engine/autopilot_train.py` (create) | Vercel function `POST /api/engine/autopilot-train` | 2 (D3) |
| `app/routes/cron.autopilot-train.tsx` (create) | Nightly TS cron driving the Python entrypoint | 2 (D4) |
| `vercel.json` (modify) | Add the `/cron/autopilot-train` schedule | 2 (D4) |
| `app/lib/actions/action-policy.server.ts` (create) | `getActionPolicy` — read `μ` via pseudonym mapping | 2 (D5) |
| tests alongside each (`__tests__/` for TS, `tests/engine/moat/` for Python) | behavior tests | all |

**Shared contract (use these exact names/shapes in every task):**

```ts
// autopilot.server.ts already defines this Candidate shape — reuse it verbatim:
interface Candidate {
  alert_id: string; detector_id: string; dollar_impact: number;
  campaign_id: string; campaign_spend_cents: number; daily_budget_cents: number | null;
}
```

```python
# action_rewards.py
def compute_action_reward(
    action_kind: str,            # 'pause_campaign'|'reduce_campaign_budget'|'increase_campaign_budget'|'reallocate_budget'
    pre_roas: Decimal, post_roas: Decimal,
    pre_profit_cents: int, post_profit_cents: int,
    break_even_roas: Decimal,
    undone: bool,
) -> Decimal: ...
```

```
moat.action_models(detector_id text, action_kind text, shop_id_pseudonym text,
                   policy_json jsonb, posterior_json jsonb, updated_at timestamptz,
                   PRIMARY KEY (detector_id, action_kind, shop_id_pseudonym))
moat.action_baselines(segment text, detector_id text, action_kind text,
                      p25 numeric, p50 numeric, p75 numeric, n int, updated_at timestamptz,
                      PRIMARY KEY (segment, detector_id, action_kind))
policy_json = {"mu": <0..1>}
posterior_json = {"alpha","beta","n_events","last_reward","n_peers","seeded_from"}
```

---

# Part 1 — D6 Targeting (deterministic, ship first)

Branch: `feat/autopilot-targeting`.

## Task 1: Resolve a campaign for shop-scoped `ad_tax_overload`

**Files:**
- Create: `app/lib/actions/autopilot-targeting.server.ts`
- Test: `app/lib/actions/__tests__/autopilot-targeting.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveScopedCandidates } from "../autopilot-targeting.server";
import type { ReallocationCandidate } from "../reallocation-suggest.server";

const graded: ReallocationCandidate[] = [
  { campaignId: "c-poor", externalId: "x1", platform: "meta", name: "P", dailyBudgetCents: 5000, grade: "poor", roas: 0.4 },
  { campaignId: "c-win",  externalId: "x2", platform: "google", name: "W", dailyBudgetCents: 9000, grade: "winning", roas: 3.1 },
];

describe("resolveScopedCandidates", () => {
  it("maps a shop-scoped ad_tax_overload alert to the worst-graded source campaign", async () => {
    const alerts = [{ id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: { scope: "shop" } }];
    const sb = { from: vi.fn() } as never; // not used: spend comes from graded pool here
    const out = await resolveScopedCandidates("shop1", alerts as never, graded, sb);
    expect(out).toEqual([
      {
        alert_id: "a1",
        detector_id: "ad_tax_overload",
        dollar_impact: 120,
        campaign_id: "c-poor",
        campaign_spend_cents: 5000, // source's live daily budget stands in for "has spend" gate
        daily_budget_cents: 5000,
      },
    ]);
  });

  it("drops an alert when the pool has no eligible (non-winning) source", async () => {
    const onlyWinner = [graded[1]];
    const alerts = [{ id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: { scope: "shop" } }];
    const out = await resolveScopedCandidates("shop1", alerts as never, onlyWinner, {} as never);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/autopilot-targeting.test.ts`
Expected: FAIL — `resolveScopedCandidates is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/actions/autopilot-targeting.server.ts
// Resolve a concrete campaign target for alerts whose entity_ref carries NO
// campaign_id (shop-scoped ad_tax_overload, SKU-scoped negative_unit_economics),
// so autopilot can act on them. Deterministic v1 (spec §8): reuse the graded
// pool's worst-source pick. Returns synthetic candidates in the SAME shape the
// candidate view produces, so runAutopilotForShop treats them identically.
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickReallocation, type ReallocationCandidate } from "./reallocation-suggest.server";

interface ScopedAlert {
  id: string;
  detector_id: string;
  dollar_impact: number;
  entity_ref: Record<string, unknown>;
}

export interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number;
  campaign_id: string;
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
}

export async function resolveScopedCandidates(
  _shopId: string,
  alerts: ScopedAlert[],
  graded: ReallocationCandidate[],
  _sb: SupabaseClient,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const a of alerts) {
    if (a.detector_id !== "ad_tax_overload") continue; // SKU path added in Task 2
    const { source } = pickReallocation(graded); // worst-graded, never a winner
    if (!source) continue;
    out.push({
      alert_id: a.id,
      detector_id: a.detector_id,
      dollar_impact: a.dollar_impact,
      campaign_id: source.campaignId,
      campaign_spend_cents: source.dailyBudgetCents,
      daily_budget_cents: source.dailyBudgetCents,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/autopilot-targeting.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/autopilot-targeting.server.ts app/lib/actions/__tests__/autopilot-targeting.test.ts
git commit -m "feat(autopilot): resolve shop-scoped ad_tax_overload to a campaign target (D6)"
```

## Task 2: ~~Resolve a campaign for SKU-scoped `negative_unit_economics`~~ — CUT from v1

> **CUT (2026-06-19, verified against prod `ajgrmnvzxfxxlwrxcgnu`).** `attribution_fact`
> has no `sku_id` and no `roas` — it links `order_id → campaign_id → attributed_revenue_cents`.
> The steps below assumed columns that do not exist. A real SKU→campaign map needs an
> `order_id → order-line-item SKU → campaign` join + per-campaign ROAS from `ad_spend_fact`
> — a follow-up feature, not a deterministic v1 one-liner. Skip this task. Task 1's committed
> code is already the without-SKU version. `negative_unit_economics` stays in `PAUSE_DETECTORS`
> (harmless — SKU-scoped alerts still never enter the candidate view, as today). The original
> (invalid) steps are retained below struck-through for the record.

**Files:**
- Modify: `app/lib/actions/autopilot-targeting.server.ts`
- Test: `app/lib/actions/__tests__/autopilot-targeting.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("maps a SKU-scoped negative_unit_economics alert to the worst-ROAS campaign driving that SKU", async () => {
  // attribution_fact rows: which campaigns sold this sku_id, with per-campaign roas
  const attrib = [
    { campaign_id: "c-poor", roas: 0.4 },
    { campaign_id: "c-win", roas: 3.1 },
  ];
  const sb = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: attrib, error: null }),
        }),
      }),
    }),
  } as never;
  const alerts = [{ id: "a2", detector_id: "negative_unit_economics", dollar_impact: 80, entity_ref: { sku_id: "sku-1" } }];
  const out = await resolveScopedCandidates("shop1", alerts as never, graded, sb);
  expect(out).toEqual([
    {
      alert_id: "a2",
      detector_id: "negative_unit_economics",
      dollar_impact: 80,
      campaign_id: "c-poor", // worst ROAS among campaigns driving the SKU, intersected with graded pool
      campaign_spend_cents: 5000,
      daily_budget_cents: 5000,
    },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/autopilot-targeting.test.ts -t "negative_unit_economics"`
Expected: FAIL — current code `continue`s on non-`ad_tax_overload` detectors, so `out` is `[]`.

- [ ] **Step 3: Write minimal implementation**

Replace the loop body in `resolveScopedCandidates` with:

```ts
  const byId = new Map(graded.map((g) => [g.campaignId, g]));
  for (const a of alerts) {
    if (a.detector_id === "ad_tax_overload") {
      const { source } = pickReallocation(graded);
      if (source) out.push(toCandidate(a, source));
      continue;
    }
    if (a.detector_id === "negative_unit_economics") {
      const skuId = a.entity_ref["sku_id"];
      if (typeof skuId !== "string") continue;
      const { data, error } = await _sb
        .from("attribution_fact")
        .select("campaign_id, roas")
        .eq("shop_id", _shopId)
        .eq("sku_id", skuId);
      if (error) throw error;
      // Worst-ROAS campaign that is also in the graded pool (has live budget).
      const ranked = ((data ?? []) as { campaign_id: string; roas: number }[])
        .filter((r) => byId.has(r.campaign_id))
        .sort((x, y) => Number(x.roas) - Number(y.roas));
      const pick = ranked[0] ? byId.get(ranked[0].campaign_id) : undefined;
      if (pick) out.push(toCandidate(a, pick));
      continue;
    }
  }
```

Add the helper above the function:

```ts
function toCandidate(a: ScopedAlert, c: ReallocationCandidate): Candidate {
  return {
    alert_id: a.id,
    detector_id: a.detector_id,
    dollar_impact: a.dollar_impact,
    campaign_id: c.campaignId,
    campaign_spend_cents: c.dailyBudgetCents,
    daily_budget_cents: c.dailyBudgetCents,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/autopilot-targeting.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/autopilot-targeting.server.ts app/lib/actions/__tests__/autopilot-targeting.test.ts
git commit -m "feat(autopilot): resolve SKU-scoped negative_unit_economics to a campaign target (D6)"
```

## Task 3: Feed scoped candidates into `runAutopilotForShop`

**Files:**
- Modify: `app/lib/actions/autopilot.server.ts` (the `candidates` assembly, ~lines 53–73)
- Test: `app/lib/actions/__tests__/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("acts on a shop-scoped ad_tax_overload alert by resolving a campaign target", async () => {
  // guardrail_config enabled; candidate VIEW returns nothing (shop-scoped alert
  // is not in v_autopilot_candidates); an open ad_tax_overload alert + a graded
  // pool with a poor source exists. Expect ONE reduce/reallocate action.
  const summary = await runAutopilotForShop("shop1", makeSb({
    enabled: true,
    viewRows: [],
    scopedAlerts: [{ id: "a1", detector_id: "ad_tax_overload", dollar_impact: 120, entity_ref: { scope: "shop" } }],
    graded: [{ campaignId: "c-poor", externalId: "x", platform: "meta", name: "P", dailyBudgetCents: 5000, grade: "poor", roas: 0.4 }],
  }));
  expect(summary.acted).toBe(1);
});
```

(Extend the existing `makeSb` test helper in this file to return `scopedAlerts` for the `alerts` table query filtered to the scoped detectors, and `graded` for `loadReallocationCandidates`. Mirror the existing mock style in `autopilot.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts -t "shop-scoped ad_tax_overload"`
Expected: FAIL — `acted` is `0` (scoped alert never enters the loop).

- [ ] **Step 3: Write minimal implementation**

In `autopilot.server.ts`, after the existing `v_autopilot_candidates` read builds `candidates`, fetch the scoped alerts and append. The graded pool is already loaded for budget detectors — hoist it so targeting reuses it:

```ts
import { resolveScopedCandidates } from "./autopilot-targeting.server";

// ...after `const candidates = (rows ?? []) as Candidate[];`

// Scoped detectors (shop/SKU) never appear in v_autopilot_candidates (no
// campaign_id to inner-join). Resolve a campaign target for them (D6).
const { data: scopedRows } = await sb
  .from("alerts")
  .select("id, detector_id, dollar_impact, entity_ref")
  .eq("shop_id", shopId)
  .eq("status", "open")
  .in("detector_id", ["ad_tax_overload"]); // SKU-scoped negative_unit_economics cut from v1 (Task 2)

const gradedPool =
  candidates.some((c) => BUDGET_DETECTORS.has(c.detector_id)) || (scopedRows ?? []).length > 0
    ? await loadReallocationCandidates(shopId, sb)
    : [];

const scoped = await resolveScopedCandidates(shopId, (scopedRows ?? []) as never, gradedPool, sb);
const allCandidates = [...candidates, ...scoped];
```

Then change the `ordered` construction and the existing `gradedPool` declaration to use `allCandidates` and the hoisted `gradedPool` (delete the old `gradedPool` declaration so it is not computed twice). `negative_unit_economics` is already in `PAUSE_DETECTORS`; ensure `ad_tax_overload` stays in `BUDGET_DETECTORS` so it routes to reduce/reallocate.

- [ ] **Step 4: Run the full autopilot suite**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS (existing tests + the new one). Fix any mock-shape mismatches in `makeSb`.

- [ ] **Step 5: Commit + run the Part-1 gate**

```bash
npm run typecheck && npx eslint app/lib/actions/autopilot.server.ts app/lib/actions/autopilot-targeting.server.ts --max-warnings=0
git add app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "feat(autopilot): act on shop/SKU-scoped alerts via resolved campaign targets (D6)"
```

> **Ship gate for Part 1:** `npm run typecheck` → 0, `npm run lint` → 0, `npx vitest run` → green, `npm run build` → 0. Part 1 is independently shippable here.

---

# Part 0 — Migration (precondition for Part 2)

Branch: `feat/autopilot-action-learning`.

## Task 4: Create `moat.action_models` + `moat.action_baselines`

**Files:**
- Create: `supabase/migrations/20260619140000_autopilot_action_models.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Autopilot action-learning (spec 2026-06-19). Mirror of moat.detection_models /
-- moat.peer_baselines but for ACTION policy. Keyed by pseudonym (invariant A4).
create table if not exists moat.action_models (
  detector_id        text not null,
  action_kind        text not null,
  shop_id_pseudonym  text not null,
  policy_json        jsonb not null,   -- {"mu": 0..1}
  posterior_json     jsonb not null,   -- {alpha,beta,n_events,last_reward,n_peers,seeded_from}
  updated_at         timestamptz not null default now(),
  primary key (detector_id, action_kind, shop_id_pseudonym)
);

create table if not exists moat.action_baselines (
  segment      text not null,
  detector_id  text not null,
  action_kind  text not null,
  p25          numeric not null,
  p50          numeric not null,
  p75          numeric not null,
  n            int not null,            -- distinct contributors; always >= 5 (A3)
  updated_at   timestamptz not null default now(),
  primary key (segment, detector_id, action_kind)
);
```

- [ ] **Step 2: Validate the SQL applies cleanly**

Run: `npx supabase db diff --schema moat` (or apply to a local/branch DB). Expected: the two tables created, no errors. If using the Supabase MCP, apply via `apply_migration` against a development branch first.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260619140000_autopilot_action_models.sql
git commit -m "feat(autopilot): action_models + action_baselines tables (D-migration)"
```

---

# Part 2 — Learning loop (D1–D5)

## Task 5: D1 — `compute_action_reward` pure kernel

**Files:**
- Create: `engine/calderyn_engine/moat/action_rewards.py`
- Test: `tests/engine/moat/test_action_rewards.py`

- [ ] **Step 1: Write the failing test**

```python
from decimal import Decimal
from calderyn_engine.moat.action_rewards import compute_action_reward, UNDO_PENALTY

def test_pause_rewards_loss_averted_when_was_below_breakeven():
    # campaign was bleeding (roas 0.5 < be 1.5); pausing stops a $300 loss.
    r = compute_action_reward("pause_campaign",
                              pre_roas=Decimal("0.5"), post_roas=Decimal("0"),
                              pre_profit_cents=-30000, post_profit_cents=0,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r == Decimal("300")  # loss averted, in dollars

def test_increase_rewards_profit_delta_only_above_breakeven():
    r = compute_action_reward("increase_campaign_budget",
                              pre_roas=Decimal("2.0"), post_roas=Decimal("2.1"),
                              pre_profit_cents=10000, post_profit_cents=25000,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r == Decimal("150")  # +$150 profit, ROAS stayed above BE

def test_increase_into_diminishing_returns_is_penalised():
    r = compute_action_reward("increase_campaign_budget",
                              pre_roas=Decimal("2.0"), post_roas=Decimal("1.2"),
                              pre_profit_cents=10000, post_profit_cents=4000,
                              break_even_roas=Decimal("1.5"), undone=False)
    assert r < 0  # ROAS fell below BE after scaling

def test_undo_is_hard_negative_overriding_outcome():
    r = compute_action_reward("pause_campaign",
                              pre_roas=Decimal("0.5"), post_roas=Decimal("0"),
                              pre_profit_cents=-30000, post_profit_cents=0,
                              break_even_roas=Decimal("1.5"), undone=True)
    assert r == UNDO_PENALTY
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && pytest ../tests/engine/moat/test_action_rewards.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```python
"""D1 — pure reward kernel for the autopilot action trainer (spec 2026-06-19 §4).

Numbers in, Decimal reward out. No I/O. Mirrors moat/rewards.py. Sign: positive
== the action helped. Undo (merchant veto) overrides the outcome math.
"""
from __future__ import annotations
from decimal import Decimal

UNDO_PENALTY: Decimal = Decimal("-100")  # flat veto; mirrors FALSE_POSITIVE_PENALTY scale

_DEFENSIVE = {"pause_campaign", "reduce_campaign_budget"}

def compute_action_reward(
    action_kind: str,
    pre_roas: Decimal, post_roas: Decimal,
    pre_profit_cents: int, post_profit_cents: int,
    break_even_roas: Decimal,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY

    if action_kind in _DEFENSIVE:
        # Loss averted: only credit when the campaign WAS below break-even.
        if pre_roas < break_even_roas and pre_profit_cents < 0:
            return (Decimal(-pre_profit_cents) / 100)  # the bleed we stopped, in dollars
        return Decimal("0")

    if action_kind in ("increase_campaign_budget", "reallocate_budget"):
        delta = Decimal(post_profit_cents - pre_profit_cents) / 100
        # Penalise scaling into diminishing returns: if ROAS fell below BE after
        # the action, the profit delta is treated as the loss it is (already
        # negative) and additionally floored at <0.
        if action_kind == "increase_campaign_budget" and post_roas < break_even_roas:
            return delta if delta < 0 else -delta
        return delta

    return Decimal("0")  # unknown kind -> no signal (do not raise; mirrors moat)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && pytest ../tests/engine/moat/test_action_rewards.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_rewards.py tests/engine/moat/test_action_rewards.py
git commit -m "feat(autopilot): compute_action_reward kernel (D1)"
```

## Task 6: D1 — `derive_action_reward_inputs`

**Files:**
- Create: `engine/calderyn_engine/moat/action_reward_inputs.py`
- Test: `tests/engine/moat/test_action_reward_inputs.py`

Reads each autopilot `action_audit` row for a shop, computes pre/post ROAS + profit from `ad_spend_fact` over `[T-14d, T)` vs `[T, T+14d]`, the chosen-pct from `pre_state.daily_budget_cents` (old) vs `params.daily_budget_cents` (new), and whether it was undone (`action_audit.undo_of`). Returns one `ActionRewardInput` per action.

- [ ] **Step 1: Write the failing test** (use a fake asyncpg conn returning canned rows)

```python
import pytest
from decimal import Decimal
from datetime import date
from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs, ActionRewardInput

class FakeConn:
    def __init__(self, actions, spend, grade): self._a, self._s, self._g = actions, spend, grade
    async def fetch(self, q, *args):
        if "action_audit" in q: return self._a
        if "ad_spend_fact" in q: return self._s
        return self._g

@pytest.mark.asyncio
async def test_derives_reward_input_with_chosen_pct_and_reward():
    actions = [{
        "id": "act1", "detector_id": "ad_tax_overload", "action_kind": "reduce_campaign_budget",
        "campaign_id": "c1", "created_at": "2026-06-01T00:00:00+00:00",
        "old_budget_cents": 10000, "new_budget_cents": 7000, "undone": False,
    }]
    # pre window bleeding, post window stopped (handled inside via spend rows)
    spend = [
        {"campaign_id": "c1", "phase": "pre", "spend_cents": 20000, "revenue_cents": 5000},
        {"campaign_id": "c1", "phase": "post", "spend_cents": 7000, "revenue_cents": 7000},
    ]
    grade = [{"campaign_id": "c1", "break_even_roas": Decimal("1.5")}]
    rows = await derive_action_reward_inputs(FakeConn(actions, spend, grade), "shop1", date(2026, 6, 19))
    assert len(rows) == 1
    r = rows[0]
    assert isinstance(r, ActionRewardInput)
    assert r["action_kind"] == "reduce_campaign_budget"
    assert r["chosen_pct"] == pytest.approx(30.0)  # (10000-7000)/10000
    assert r["reward"] > 0  # loss averted
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && pytest ../tests/engine/moat/test_action_reward_inputs.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```python
"""D1 — derive per-action reward inputs for a shop (spec 2026-06-19 §4).

One query reads the shop's autopilot action_audit rows (with old/new budget and
undo flag); a second reads ad_spend_fact bucketed into pre/post 14d windows; a
third reads break-even per campaign. compute_action_reward turns each into a
scalar. Own raw data only (invariant A5). pgbouncer-safe: plain fetches, no
session state.
"""
from __future__ import annotations
from decimal import Decimal
from datetime import date
from typing import Any, TypedDict

from calderyn_engine.moat.action_rewards import compute_action_reward

WINDOW_DAYS = 14

class ActionRewardInput(TypedDict):
    shop_id: str
    detector_id: str
    action_kind: str
    campaign_id: str
    chosen_pct: float          # |new-old|/old * 100
    reward: Decimal
    action_id: str

_ACTIONS_SQL = """
SELECT a.id, a.action_kind,
       (a.params->>'campaign_id') AS campaign_id,
       a.created_at,
       COALESCE(al.detector_id, 'unknown') AS detector_id,
       (a.pre_state->>'daily_budget_cents')::int AS old_budget_cents,
       (a.params->>'daily_budget_cents')::int    AS new_budget_cents,
       EXISTS (SELECT 1 FROM public.action_audit u WHERE u.undo_of = a.id) AS undone
  FROM public.action_audit a
  LEFT JOIN public.alerts al ON al.id = a.alert_id
 WHERE a.shop_id = $1 AND a.actor_user_id = 'autopilot' AND a.outcome = 'succeeded'
"""

_SPEND_SQL = """
SELECT campaign_id,
       CASE WHEN day <  $2 THEN 'pre' ELSE 'post' END AS phase,
       SUM(spend_cents)          AS spend_cents,
       SUM(revenue_attrib_cents) AS revenue_cents
  FROM public.ad_spend_fact
 WHERE shop_id = $1 AND day >= $3 AND day < $4
 GROUP BY campaign_id, phase
"""

def _roas(spend: int, rev: int) -> Decimal:
    return (Decimal(rev) / Decimal(spend)) if spend else Decimal("0")

async def derive_action_reward_inputs(conn: Any, shop_id: str, run_date: date) -> list[ActionRewardInput]:
    actions = await conn.fetch(_ACTIONS_SQL, shop_id)
    out: list[ActionRewardInput] = []
    grades = {g["campaign_id"]: Decimal(str(g["break_even_roas"]))
              for g in await conn.fetch(
                  "SELECT DISTINCT ON (campaign_id) campaign_id, break_even_roas "
                  "FROM public.campaign_grade_fact WHERE shop_id = $1 "
                  "ORDER BY campaign_id, day_bucket DESC", shop_id)}
    for a in actions:
        from datetime import datetime, timedelta
        t = a["created_at"] if isinstance(a["created_at"], datetime) else datetime.fromisoformat(str(a["created_at"]))
        lo, hi = (t - timedelta(days=WINDOW_DAYS)).date(), (t + timedelta(days=WINDOW_DAYS)).date()
        spend = await conn.fetch(_SPEND_SQL, shop_id, t.date(), lo, hi)
        agg = {(r["campaign_id"], r["phase"]): r for r in spend}
        cid = a["campaign_id"]
        pre = agg.get((cid, "pre"), {"spend_cents": 0, "revenue_cents": 0})
        post = agg.get((cid, "post"), {"spend_cents": 0, "revenue_cents": 0})
        reward = compute_action_reward(
            a["action_kind"],
            _roas(pre["spend_cents"], pre["revenue_cents"]),
            _roas(post["spend_cents"], post["revenue_cents"]),
            int(pre["revenue_cents"]) - int(pre["spend_cents"]),
            int(post["revenue_cents"]) - int(post["spend_cents"]),
            grades.get(cid, Decimal("1")),
            bool(a["undone"]),
        )
        old, new = a["old_budget_cents"], a["new_budget_cents"]
        chosen_pct = abs((new or 0) - (old or 0)) / old * 100 if old else 0.0
        out.append({
            "shop_id": shop_id, "detector_id": a["detector_id"], "action_kind": a["action_kind"],
            "campaign_id": cid, "chosen_pct": float(chosen_pct), "reward": reward, "action_id": a["id"],
        })
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && pytest ../tests/engine/moat/test_action_reward_inputs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_reward_inputs.py tests/engine/moat/test_action_reward_inputs.py
git commit -m "feat(autopilot): derive_action_reward_inputs from action_audit + ad_spend_fact (D1)"
```

## Task 7: D2 — peer action baselines ETL

**Files:**
- Create: `engine/calderyn_engine/moat/action_peer_etl.py`
- Test: `tests/engine/moat/test_action_peer_etl.py`

Aggregates each consenting shop's *positively-rewarded* actions into per-`(segment, detector, action_kind)` percentiles of the aggressiveness fraction `chosen_pct/cap_pct`, with a **k≥5 distinct-contributor floor** (A2, A3). Reuses `gmv_band_for_shop`; `cap_pct` comes from the shop's current `autopilot_max_budget_*_pct` (flag the approximation per spec §6 open item).

- [ ] **Step 1: Write the failing test**

```python
import pytest
from calderyn_engine.moat.action_peer_etl import run_action_peer_etl

@pytest.mark.asyncio
async def test_suppresses_baseline_below_k_floor(fake_conn_4_shops):
    # 4 consenting shops with a winning reduce action -> below k=5 -> no rows written
    summary = await run_action_peer_etl(fake_conn_4_shops, pepper="p", run_date=__import__("datetime").date(2026,6,19))
    assert summary["baselines_written"] == 0

@pytest.mark.asyncio
async def test_publishes_baseline_at_k_floor(fake_conn_5_shops):
    summary = await run_action_peer_etl(fake_conn_5_shops, pepper="p", run_date=__import__("datetime").date(2026,6,19))
    assert summary["baselines_written"] == 1  # one (segment, detector, action_kind) group reached k=5
```

(Provide the `fake_conn_4_shops` / `fake_conn_5_shops` fixtures in the test file modeled on `tests/engine/moat/conftest.py`; each fake returns consenting shops, their winning actions with `chosen_pct`, and a fixed segment from `gmv_band_for_shop`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && pytest ../tests/engine/moat/test_action_peer_etl.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```python
"""D2 — anonymized peer baselines of WINNING action aggressiveness (spec §6).

For every consenting shop (shops.peer_data_consent), bucket its positively-
rewarded autopilot actions by (segment, detector, action_kind), keep the
aggressiveness fraction chosen_pct/cap_pct, and publish p25/p50/p75 ONLY when
>= 5 DISTINCT shops contributed (invariant A3). Reads own data per shop but only
aggregates across pseudonymous contributors (A1, A2). Mirrors peer_incident_etl.
"""
from __future__ import annotations
import statistics
from datetime import date
from typing import Any, TypedDict

from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs
from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop

MIN_CONTRIBUTORS = 5

class ActionEtlSummary(TypedDict):
    baselines_written: int
    groups_suppressed: int

async def _consenting_shop_ids(conn: Any) -> list[str]:
    rows = await conn.fetch("SELECT id::text AS shop_id FROM public.shops WHERE peer_data_consent = true")
    return [r["shop_id"] for r in rows]

async def _caps(conn: Any, shop_id: str) -> dict[str, float]:
    row = await conn.fetchrow(
        "SELECT autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct "
        "FROM public.guardrail_config WHERE shop_id = $1", shop_id)
    cut = float(row["autopilot_max_budget_cut_pct"]) if row else 50.0
    inc = float(row["autopilot_max_budget_increase_pct"]) if row else 20.0
    return {"reduce_campaign_budget": cut, "reallocate_budget": cut,
            "increase_campaign_budget": inc, "pause_campaign": 100.0}

async def run_action_peer_etl(conn: Any, *, pepper: str, run_date: date) -> ActionEtlSummary:
    # group -> {fraction list, set of contributing shops}
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for shop_id in await _consenting_shop_ids(conn):
        segment = await gmv_band_for_shop(conn, shop_id, run_date)
        caps = await _caps(conn, shop_id)
        for r in await derive_action_reward_inputs(conn, shop_id, run_date):
            if r["reward"] <= 0:
                continue  # only winning actions inform the prior
            cap = caps.get(r["action_kind"], 100.0) or 100.0
            frac = min(max(r["chosen_pct"] / cap, 0.0), 1.0)
            key = (segment, r["detector_id"], r["action_kind"])
            g = groups.setdefault(key, {"fracs": [], "shops": set()})
            g["fracs"].append(frac)
            g["shops"].add(shop_id)

    written = suppressed = 0
    for (segment, detector_id, action_kind), g in groups.items():
        n = len(g["shops"])
        if n < MIN_CONTRIBUTORS:
            suppressed += 1
            continue
        fr = sorted(g["fracs"])
        q = statistics.quantiles(fr, n=4) if len(fr) >= 2 else [fr[0], fr[0], fr[0]]
        await conn.execute(
            """
            INSERT INTO moat.action_baselines (segment, detector_id, action_kind, p25, p50, p75, n, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7, now())
            ON CONFLICT (segment, detector_id, action_kind) DO UPDATE SET
              p25=EXCLUDED.p25, p50=EXCLUDED.p50, p75=EXCLUDED.p75, n=EXCLUDED.n, updated_at=EXCLUDED.updated_at
            """,
            segment, detector_id, action_kind, q[0], q[1], q[2], n)
        written += 1
    return {"baselines_written": written, "groups_suppressed": suppressed}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && pytest ../tests/engine/moat/test_action_peer_etl.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_peer_etl.py tests/engine/moat/test_action_peer_etl.py
git commit -m "feat(autopilot): peer action-baseline ETL, consent + k>=5 (D2)"
```

## Task 8: D3 — `train_action_policies`

**Files:**
- Create: `engine/calderyn_engine/moat/action_trainer.py`
- Test: `tests/engine/moat/test_action_trainer.py`

Per `(shop, detector, action_kind)`: read the peer baseline → seed prior → fold the shop's own action rewards via `update_threshold` → map posterior mean to `μ` via fraction-space rescale (cold start lands on `p50`) → upsert `moat.action_models` keyed by `pseudonym_for(shop_id, pepper)`. Mirrors `threshold_trainer.train_thresholds` (cohort, per-group transaction, fail-visible).

- [ ] **Step 1: Write the failing test**

```python
import pytest
from decimal import Decimal
from datetime import date
from calderyn_engine.moat.action_trainer import _mu_from_posterior

def test_cold_start_mu_lands_on_peer_p50():
    baseline = {"p25": Decimal("0.2"), "p50": Decimal("0.5"), "p75": Decimal("0.8")}
    mu = _mu_from_posterior({"alpha": 1.0, "beta": 1.0}, baseline)  # mean 0.5
    assert mu == pytest.approx(0.5)  # exactly p50

def test_no_baseline_falls_back_to_full_cap():
    mu = _mu_from_posterior({"alpha": 1.0, "beta": 1.0}, None)
    assert mu == 1.0
```

(Add an integration-style test `test_train_writes_model_row` with a fake conn modeled on `tests/engine/moat/conftest.py`, asserting one `moat.action_models` upsert occurs for a shop with one positive reward + a baseline.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && pytest ../tests/engine/moat/test_action_trainer.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```python
"""D3 — nightly autopilot action trainer (spec §5, §3). Seeds a Beta prior from
the peer action-baseline, folds the shop's own action rewards, maps the posterior
mean to mu in [0,1] (fraction-space rescale: cold start -> p50), and upserts
moat.action_models keyed by pseudonym (A4). Reuses update_threshold + pseudonym_for.
Mirrors threshold_trainer: cohort enumeration, per-(shop,group) short transaction,
fail-visible, pooler-safe.
"""
from __future__ import annotations
import json, math
from datetime import date
from decimal import Decimal
from typing import Any, TypedDict

import structlog
from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_updater import update_threshold
from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs

logger = structlog.get_logger()
BASE_STRENGTH, CONTRIB_WEIGHT, LEARNING_RATE = 2.0, 1.0, 0.1

def _seed_prior(baseline: dict | None) -> dict[str, float]:
    if baseline is None:
        return {"alpha": 1.0, "beta": 1.0, "n_peers": 0, "seeded_from": "flat_default"}
    n = int(baseline["n"])
    s0 = BASE_STRENGTH + CONTRIB_WEIGHT * math.log(1 + n)
    half = s0 / 2.0
    return {"alpha": half, "beta": half, "n_peers": n, "seeded_from": "peer_baseline"}

def _mu_from_posterior(posterior: dict, baseline: dict | None) -> float:
    a, b = float(posterior.get("alpha", 1.0)), float(posterior.get("beta", 1.0))
    m = a / (a + b) if (a + b) > 0 else 0.5
    if baseline is None:
        return 1.0  # no peer signal -> full merchant cap (today's behavior)
    p25, p50, p75 = (Decimal(str(baseline[k])) for k in ("p25", "p50", "p75"))
    md, half = Decimal(str(m)), Decimal("0.5")
    thr = (p50 - (md - half) / half * (p50 - p25)) if md >= half else (p50 + (half - md) / half * (p75 - p50))
    return float(max(Decimal("0"), min(thr, Decimal("1"))))

async def _read_baseline(conn: Any, segment: str, detector_id: str, action_kind: str) -> dict | None:
    row = await conn.fetchrow(
        "SELECT p25,p50,p75,n FROM moat.action_baselines "
        "WHERE segment=$1 AND detector_id=$2 AND action_kind=$3", segment, detector_id, action_kind)
    return dict(row) if row else None

async def _upsert(conn: Any, detector_id: str, action_kind: str, shop_id: str, pepper: str,
                  posterior: dict, mu: float) -> None:
    await conn.execute(
        """
        INSERT INTO moat.action_models (detector_id, action_kind, shop_id_pseudonym, policy_json, posterior_json, updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb, now())
        ON CONFLICT (detector_id, action_kind, shop_id_pseudonym) DO UPDATE SET
          policy_json=EXCLUDED.policy_json, posterior_json=EXCLUDED.posterior_json, updated_at=EXCLUDED.updated_at
        """,
        detector_id, action_kind, pseudonym_for(shop_id, pepper),
        json.dumps({"mu": mu}), json.dumps(posterior))

class ActionTrainSummary(TypedDict):
    shops_trained: int
    models_written: int
    skipped: int
    errors: list[str]

async def train_action_policies(conn: Any, *, pepper: str, run_date: date,
                                learning_rate: float = LEARNING_RATE) -> ActionTrainSummary:
    s: ActionTrainSummary = {"shops_trained": 0, "models_written": 0, "skipped": 0, "errors": []}
    shop_rows = await conn.fetch(
        "SELECT DISTINCT s.id::text AS shop_id FROM public.shops s "
        "LEFT JOIN public.action_audit a ON a.shop_id = s.id AND a.actor_user_id='autopilot' "
        "WHERE s.peer_data_consent = true OR a.shop_id IS NOT NULL")
    for sr in shop_rows:
        shop_id = sr["shop_id"]
        try:
            rewards = await derive_action_reward_inputs(conn, shop_id, run_date)
        except Exception as exc:  # noqa: BLE001
            s["skipped"] += 1; s["errors"].append(f"{shop_id}/*: reward read failed: {exc}"); continue
        by_group: dict[tuple[str, str], list] = {}
        for r in rewards:
            by_group.setdefault((r["detector_id"], r["action_kind"]), []).append(r)
        # Also train consenting shops with NO actions yet, from the peer prior (cold start).
        trained_any = False
        segment = await gmv_band_for_shop(conn, shop_id, run_date)
        keys = set(by_group) | {(d, k) for (d, k) in await _coldstart_keys(conn, segment)}
        for (detector_id, action_kind) in keys:
            try:
                async with conn.transaction():
                    baseline = await _read_baseline(conn, segment, detector_id, action_kind)
                    group = by_group.get((detector_id, action_kind), [])
                    if baseline is None and not group:
                        continue
                    posterior = _seed_prior(baseline)
                    for r in sorted(group, key=lambda x: x["action_id"]):
                        posterior = update_threshold(posterior, r["reward"], learning_rate=learning_rate)
                    posterior["n_events"] = len(group)
                    posterior["last_reward"] = float(group[-1]["reward"]) if group else 0.0
                    await _upsert(conn, detector_id, action_kind, shop_id, pepper, posterior, _mu_from_posterior(posterior, baseline))
            except Exception as exc:  # noqa: BLE001
                s["skipped"] += 1; s["errors"].append(f"{shop_id}/{detector_id}/{action_kind}: {exc}"); continue
            s["models_written"] += 1; trained_any = True
        if trained_any:
            s["shops_trained"] += 1
    logger.info("train_action_policies_complete", **{k: s[k] if k != "errors" else len(s["errors"]) for k in s})
    return s

async def _coldstart_keys(conn: Any, segment: str) -> list[tuple[str, str]]:
    rows = await conn.fetch("SELECT detector_id, action_kind FROM moat.action_baselines WHERE segment=$1", segment)
    return [(r["detector_id"], r["action_kind"]) for r in rows]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && pytest ../tests/engine/moat/test_action_trainer.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_trainer.py tests/engine/moat/test_action_trainer.py
git commit -m "feat(autopilot): action policy trainer, peer-seeded mu (D3)"
```

## Task 9: D3 — engine entrypoint `POST /api/engine/autopilot-train`

**Files:**
- Create: `engine/_autopilot_train_core.py`
- Create: `api/engine/autopilot_train.py`
- Test: `tests/engine/test_autopilot_train_core.py`

Mirror `engine/_moat_train_core.py` + `api/engine/moat_train.py` exactly. `handle(body, authorization)` checks `Bearer $CRON_SECRET`, returns `503` if `MOAT_PEPPER` unset, then runs `run_action_peer_etl` then `train_action_policies`, returning `(status, {etl, shops_trained, models_written, skipped, errors})`.

- [ ] **Step 1: Write the failing test**

```python
import pytest
from _autopilot_train_core import handle

@pytest.mark.asyncio
async def test_rejects_without_bearer(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s"); monkeypatch.setenv("MOAT_PEPPER", "p")
    status, body = await handle({}, authorization=None)
    assert status == 401

@pytest.mark.asyncio
async def test_503_without_pepper(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s"); monkeypatch.delenv("MOAT_PEPPER", raising=False)
    status, body = await handle({}, authorization="Bearer s")
    assert status == 503
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && pytest ../tests/engine/test_autopilot_train_core.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — copy `engine/_moat_train_core.py`, swap the trainer calls to `run_action_peer_etl` + `train_action_policies`; copy `api/engine/moat_train.py` to `api/engine/autopilot_train.py` changing only the docstring URL and `from _autopilot_train_core import handle`. (Reproduce the auth + DB-connect + 503-on-missing-pepper structure verbatim from `_moat_train_core.py` — read that file and mirror it; do not invent a new shape.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && pytest ../tests/engine/test_autopilot_train_core.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/_autopilot_train_core.py api/engine/autopilot_train.py tests/engine/test_autopilot_train_core.py
git commit -m "feat(autopilot): /api/engine/autopilot-train entrypoint (D3)"
```

## Task 10: D4 — nightly cron `/cron/autopilot-train`

**Files:**
- Create: `app/routes/cron.autopilot-train.tsx`
- Modify: `vercel.json` (crons array, ~line 36)
- Test: `app/routes/__tests__/cron.autopilot-train.test.ts`

Copy `app/routes/cron.moat-train.tsx` exactly, changing `ENGINE_PATH` to `/api/engine/autopilot-train` and the log prefixes to `[cron.autopilot-train]`. **Omit the train-lock** (the `action_models` PK upsert is concurrency-safe; document this — spec §9 / moat §9.7 precedent).

- [ ] **Step 1: Write the failing test** — copy `app/routes/__tests__/cron.moat-train.test.ts`, change the imported `loader` path and the asserted engine URL to `/api/engine/autopilot-train`, and drop the lock-specific cases.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.autopilot-train.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Write minimal implementation** — create the route (no lock) and add to `vercel.json`:

```json
    { "path": "/cron/autopilot-train", "schedule": "0 4 * * *" }
```

(4am UTC, after `/cron/moat-train` precedent; one entry in the `crons` array.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/cron.autopilot-train.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.autopilot-train.tsx app/routes/__tests__/cron.autopilot-train.test.ts vercel.json
git commit -m "feat(autopilot): nightly /cron/autopilot-train (D4)"
```

## Task 11: D5 — consume `μ` in `runAutopilotForShop`

**Files:**
- Create: `app/lib/actions/action-policy.server.ts`
- Modify: `app/lib/actions/autopilot.server.ts` (cut/scale magnitude computation)
- Test: `app/lib/actions/__tests__/action-policy.test.ts`, `app/lib/actions/__tests__/autopilot.test.ts`

- [ ] **Step 1: Write the failing test (the seam)**

```ts
import { describe, it, expect, vi } from "vitest";
import { getActionPolicy } from "../action-policy.server";

describe("getActionPolicy", () => {
  it("returns null when the shop has no pseudonym row (safe full-cap fallthrough)", async () => {
    const sb = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }) }) } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBeNull();
  });

  it("returns mu from action_models keyed by the resolved pseudonym", async () => {
    const calls: string[] = [];
    const sb = { from: vi.fn().mockImplementation((t: string) => { calls.push(t); return {
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: t === "shop_pseudonym" ? { pseudonym_id: "ps1" } : { mu: 0.4 } }),
        eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { policy_json: { mu: 0.4 } } }) }) }),
      }) }) }; }) } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBe(0.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/action-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/actions/action-policy.server.ts
// D5 consume seam (spec §7). Read the learned aggressiveness dial mu for
// (shop, detector, action). Resolve the pseudonym from moat_keys.shop_pseudonym
// (do NOT re-implement pseudonym_for in TS). Missing pseudonym/model -> null ->
// caller uses the full merchant cap (today's behavior). The guardrail is always
// the hard ceiling; mu only scales within it.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getActionPolicy(
  sb: SupabaseClient, shopId: string, detectorId: string, actionKind: string,
): Promise<number | null> {
  const { data: key } = await sb
    .schema("moat_keys").from("shop_pseudonym")
    .select("pseudonym_id").eq("shop_id", shopId).maybeSingle();
  if (!key?.pseudonym_id) return null;
  const { data: model } = await sb
    .schema("moat").from("action_models")
    .select("policy_json")
    .eq("shop_id_pseudonym", String(key.pseudonym_id))
    .eq("detector_id", detectorId).eq("action_kind", actionKind).maybeSingle();
  const mu = (model?.policy_json as { mu?: number } | undefined)?.mu;
  return typeof mu === "number" ? mu : null;
}
```

(If `sb.schema(...)` is not how this codebase reaches non-`public` schemas, match the existing moat reader's pattern — grep `moat_keys` / `.schema(` in `app/` and follow it. Do not guess; mirror the established access path.)

- [ ] **Step 4a: Run the seam test**

Run: `npx vitest run app/lib/actions/__tests__/action-policy.test.ts`
Expected: PASS.

- [ ] **Step 4b: Thread `μ` into the magnitude in `autopilot.server.ts`**

Replace the two static-percent computations. For the scale path:

```ts
const muInc = (await getActionPolicy(sb, shopId, c.detector_id, "increase_campaign_budget")) ?? 1;
const effIncreasePct = maxIncreasePct * muInc;            // mu scales WITHIN the cap
let target = Math.round(currentBudgetCents * (1 + effIncreasePct / 100));
```

For the reduce path:

```ts
const muCut = (await getActionPolicy(sb, shopId, c.detector_id, "reduce_campaign_budget")) ?? 1;
const effCutPct = maxCutPct * muCut;
const newBudgetCents =
  kind === "reduce_campaign_budget" && currentBudgetCents != null
    ? Math.round(currentBudgetCents * (1 - effCutPct / 100))
    : undefined;
```

`checkGuardrails` still runs unchanged — it re-validates that the chosen value is within the cap (it always will be, since `μ≤1`), so the hard ceiling is doubly enforced. Add an `autopilot.test.ts` case: with `getActionPolicy` mocked to `0.5`, a 50%-cap cut produces a 25% cut; with no model row (`null`), it produces the full 50% (today's behavior).

- [ ] **Step 5: Run the suite + commit**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts app/lib/actions/__tests__/action-policy.test.ts`
Expected: PASS.

```bash
git add app/lib/actions/action-policy.server.ts app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/action-policy.test.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "feat(autopilot): consume learned mu within guardrail caps (D5)"
```

---

## Final gate (run before any merge/PR — CLAUDE.md pre-commit gate)

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run lint` → exit 0 (no warnings on touched files)
- [ ] `npx vitest run` → all green
- [ ] `npm run build` → exit 0
- [ ] `cd engine && pytest ../tests/engine/moat -q` → all green
- [ ] `npx prisma validate` N/A (no prisma schema change); migration validated via `supabase db diff`
- [ ] `/code-review` on the working tree; resolve blockers

---

## Self-review against the spec

- **§4 reward (hybrid, 14d, undo veto)** → Tasks 5, 6. ✓ (`compute_action_reward` + `derive_action_reward_inputs`, `WINDOW_DAYS=14`, `UNDO_PENALTY`).
- **§5 learned object + fraction rescale (cold start → p50)** → Task 8 (`_mu_from_posterior`, `_seed_prior`). ✓
- **§6 peer baselines, consent + k≥5, segment** → Task 7 (`MIN_CONTRIBUTORS=5`, `gmv_band_for_shop`, consent filter). ✓ Open item (cap-at-exec approximation) handled in `_caps` (current cap) — **flag in the projection log** when implementing (rule 12).
- **§7 consume seam, pseudonym mapping, full-cap fallthrough** → Task 11 (`getActionPolicy`, `?? 1`). ✓
- **§8 deterministic targeting (ad_tax_overload + SKU)** → Tasks 1, 2, 3. ✓
- **§9 hybrid architecture (Python train / TS consume / own cron+tables)** → Tasks 4, 9, 10, 11. ✓
- **§10 invariants A1–A5** → Task 7 (A1/A2/A3 in the ETL), Task 8 (`pseudonym_for` keying = A4), Task 6 (own raw data = A5). ✓
- **Guardrail hard cap (μ scales within)** → Task 11 (`maxCutPct * mu`, `checkGuardrails` unchanged). ✓
- **Dormant-until-data** → cold-start path (Task 8 `_coldstart_keys`) + `null`→full-cap (Task 11) make the system safe/silent until data accrues. ✓

**Type consistency check:** `Candidate` shape identical across Tasks 1–3 and `autopilot.server.ts`; `policy_json={mu}` and `posterior_json` keys identical across Tasks 4, 8, 11; `compute_action_reward` signature identical across Tasks 5, 6; `ActionRewardInput` keys (`chosen_pct`, `reward`, `action_id`, `detector_id`, `action_kind`) identical across Tasks 6, 7, 8. ✓

**Known follow-ups (explicitly deferred, not gaps):** learned campaign-selection for targeting (v1 is grade-rank); recency decay in the reward; surfacing autopilot decisions/μ in the merchant dashboard (a parity task once stream B+C lands).
