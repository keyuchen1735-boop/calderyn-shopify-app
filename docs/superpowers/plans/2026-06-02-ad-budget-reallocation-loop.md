# Ad-Budget Reallocation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly cron that pulls each Meta campaign's 7-day ROAS, classifies winners/losers against a merchant-set target ROAS, and shifts budget loser->winner in small budget-neutral steps -- each move passing a guardrail gate and writing an undoable audit row.

**Architecture:** Pure scoring/planning functions (`score.server.ts`, `guardrails.server.ts`, `tick.server.ts`) carry all the decision logic and the unit-test weight. A thin `loop.server.ts` reads config + live Meta data, calls the pure `planTick`, then applies executes (real Meta budget writes + audit rows) and upserts loser alerts. A cron route fans the loop over Meta-connected shops. Cuts are gated/applied before feeds, and the feed pool is built only from cuts that actually succeeded, so total spend never rises.

**Tech Stack:** Remix (Vercel) + TypeScript, Vitest, Supabase (service-role), Meta Graph API v21.0 via the existing injected `MetaClient`.

**Spec:** `docs/superpowers/specs/2026-06-02-ad-budget-reallocation-loop-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/budget/score.server.ts` | Pure: types, `toPerf`, `classify`, `planCuts`, `planFeeds`, `scoreLosers`, `isLoser`. |
| `app/lib/budget/guardrails.server.ts` | Pure: `GateStatic`, `inBusinessHours`, `gateMove`. The enforce gate. |
| `app/lib/budget/tick.server.ts` | Pure: `planTick` -- composes score + gate into the two-phase plan. |
| `app/lib/budget/loop.server.ts` | Orchestration: config + live Meta -> `planTick` -> apply (Meta + audit) -> loser alerts. Shop lock + idempotency. |
| `app/lib/meta/campaigns.server.ts` | (modify) add `CampaignInsight`, `fetchCampaignInsights`, `setCampaignBudget`. |
| `app/lib/types.ts` | (modify) add `"increase_campaign_budget"` to `ActionKind`. |
| `app/lib/calderyn.server.ts` | (modify) `ExecuteActionOpts.dollarImpactAtExec`; write `dollar_impact_at_exec`; budget-restore in `audit.undo`. |
| `app/routes/cron.budget-loop.tsx` | Hourly route; Bearer auth; JSON summary. |
| `supabase/migrations/20260602120000_budget_loop_config.sql` | `guardrail_config` columns + `budget_loop_lock` table. |
| `app/lib/budget/__tests__/*.test.ts` | Unit tests for the pure modules. |

**Test boundary (rule 9, honest):** the pure modules (`score`, `guardrails`, `tick`) and the Meta calls + the `calderyn.server.ts` changes are unit-tested. `loop.server.ts` is thin DB/Meta orchestration with no decision logic of its own (all decisions live in `planTick`); following the existing `runReorderTimingDetector` precedent it is covered by the `planTick` tests + the typecheck/build gate, not a bespoke Supabase mock.

**Per-task commit gate (CLAUDE.md):** every task ends in a commit, and every commit is a "major commit." Before each `git commit` in this plan, ALL of the following must be green -- do not commit otherwise:

```
npm run typecheck            # exit 0 (whole project, every commit)
npm run lint                 # exit 0, no warnings on touched files
npx vitest run <task's test> # the test(s) named in that task, green
```

Each task below is authored so the project typechecks at that task's commit (no task commits half-defined types). The heavier `npm run build`, full `npm test`, patch-sanity, and `/code-review` run once at Task 11 before the branch leaves WIP / opens a PR -- they gate the branch, the fast checks above gate each commit. If any check fails, stop and fix the root cause (no `--no-verify`, no `eslint-disable`, no type-narrowing to silence `tsc`).

**Idempotency model (read before Task 9):** each budget move is reserved by an **atomic** insert into `budget_move_ledger` keyed `budget:<shopId>:<campaignId>:<tickHour>:<role>` *before* the Meta write. A PK conflict means the move is already claimed this tick -> skip. Because `setCampaignBudget` writes an **absolute** `toCents` (not a delta), replaying it is a no-op, so an at-least-once retry is safe. On any failure after the claim, the ledger row is deleted (claim released) so a later tick can re-attempt; the move is never applied twice as a net effect, and no duplicate `action_audit` row can inflate `used_today`.

---

## Task 1: ActionKind + budget scoring types & classify

**Files:**
- Modify: `app/lib/types.ts:5-11`
- Create: `app/lib/budget/score.server.ts`
- Test: `app/lib/budget/__tests__/score.test.ts`

- [ ] **Step 1: Add the new ActionKind**

In `app/lib/types.ts`, change the `ActionKind` union to add one line:

```ts
export type ActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "snooze_alert";
```

- [ ] **Step 2: Write the failing test for `classify`**

Create `app/lib/budget/__tests__/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  classify,
  toPerf,
  DEFAULT_BUDGET_CONFIG,
  type CampaignPerf,
} from "../score.server";
import type { MetaCampaign } from "../../meta/campaigns.server";

function perf(over: Partial<CampaignPerf>): CampaignPerf {
  return {
    id: "c1",
    name: "Camp",
    status: "ACTIVE",
    dailyBudgetCents: 5000,
    hasCampaignBudget: true,
    spend7dCents: 10000,
    roas7d: 2.5,
    ...over,
  };
}

describe("toPerf", () => {
  it("merges live campaigns with insights, defaulting missing insights to 0", () => {
    const campaigns: MetaCampaign[] = [
      { id: "c1", name: "A", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000 },
      { id: "c2", name: "B", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null },
    ];
    const out = toPerf(campaigns, { c1: { spend7dCents: 10000, roas7d: 3.1 } });
    expect(out[0]).toEqual({
      id: "c1", name: "A", status: "ACTIVE",
      dailyBudgetCents: 5000, hasCampaignBudget: true, spend7dCents: 10000, roas7d: 3.1,
    });
    expect(out[1]).toMatchObject({ hasCampaignBudget: false, spend7dCents: 0, roas7d: 0 });
  });
});

describe("classify", () => {
  it("skips ineligible campaigns (paused / no campaign budget / below min spend)", () => {
    const out = classify(
      [
        perf({ id: "p", status: "PAUSED" }),
        perf({ id: "nb", hasCampaignBudget: false }),
        perf({ id: "low", spend7dCents: 100 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual(["skip", "skip", "skip"]);
  });

  it("classifies against the target ROAS bands (target 2.0)", () => {
    const out = classify(
      [
        perf({ id: "neg", roas7d: 0.7 }),
        perf({ id: "below", roas7d: 1.5 }),
        perf({ id: "hold", roas7d: 2.0 }),
        perf({ id: "win", roas7d: 3.0 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual([
      "negative_unit_economics",
      "campaign_below_breakeven",
      "hold",
      "winner",
    ]);
  });

  it("treats the band edges as hold (target*0.9 and target*1.2)", () => {
    const out = classify(
      [perf({ id: "loEdge", roas7d: 1.8 }), perf({ id: "hiEdge", roas7d: 2.4 })],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual(["hold", "hold"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: FAIL -- cannot find module `../score.server`.

- [ ] **Step 4: Write the minimal implementation**

Create `app/lib/budget/score.server.ts`:

```ts
import type { MetaCampaign } from "../meta/campaigns.server";

// Defined here (not imported from meta) so this module typechecks standalone at
// this task's commit. `fetchCampaignInsights` (Task 5) returns this exact shape;
// TypeScript matches it structurally.
export type CampaignInsight = { spend7dCents: number; roas7d: number };

export type CampaignPerf = {
  id: string;
  name: string;
  status: string;
  dailyBudgetCents: number;
  hasCampaignBudget: boolean;
  spend7dCents: number;
  roas7d: number;
};

export type BudgetConfig = {
  targetRoas: number;
  loseBand: number;
  winBand: number;
  stepPct: number;
  floorCents: number;
  ceilingPct: number;
  minSpend7dCents: number;
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  targetRoas: 2.0,
  loseBand: 0.9,
  winBand: 1.2,
  stepPct: 0.2,
  floorCents: 500,
  ceilingPct: 0.2,
  minSpend7dCents: 2000,
};

export type LoserDetectorId = "negative_unit_economics" | "campaign_below_breakeven";
export type Decision = LoserDetectorId | "winner" | "hold" | "skip";

export type Classified = { campaign: CampaignPerf; decision: Decision };

export type BudgetMove = {
  campaignId: string;
  name: string;
  fromCents: number;
  toCents: number;
  deltaCents: number; // negative = cut, positive = feed
  role: "cut" | "feed";
  roas7d: number;
};

export type CampaignAlertDraft = {
  detectorId: LoserDetectorId;
  entity_ref: { campaign_id: string; name: string };
  severity: "critical" | "high";
  dollar_impact: number;
  claude_rank: number;
  claude_narrative: string;
  evidence: Record<string, unknown>;
};

export function isLoser(d: Decision): d is LoserDetectorId {
  return d === "negative_unit_economics" || d === "campaign_below_breakeven";
}

export function toPerf(
  campaigns: MetaCampaign[],
  insights: Record<string, CampaignInsight>,
): CampaignPerf[] {
  return campaigns.map((c) => {
    const ins = insights[c.id] ?? { spend7dCents: 0, roas7d: 0 };
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      dailyBudgetCents: c.dailyBudgetCents ?? 0,
      hasCampaignBudget: c.dailyBudgetCents != null,
      spend7dCents: ins.spend7dCents,
      roas7d: ins.roas7d,
    };
  });
}

export function classify(perf: CampaignPerf[], cfg: BudgetConfig): Classified[] {
  return perf.map((c) => {
    if (c.status !== "ACTIVE" || !c.hasCampaignBudget || c.spend7dCents < cfg.minSpend7dCents) {
      return { campaign: c, decision: "skip" as const };
    }
    let decision: Decision;
    if (c.roas7d < 1.0) decision = "negative_unit_economics";
    else if (c.roas7d < cfg.targetRoas * cfg.loseBand) decision = "campaign_below_breakeven";
    else if (c.roas7d > cfg.targetRoas * cfg.winBand) decision = "winner";
    else decision = "hold";
    return { campaign: c, decision };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: PASS (3 suites).

- [ ] **Step 6: Commit gate, then commit**

Run the per-task gate (must all be green):

```bash
npm run typecheck
npm run lint
npx vitest run app/lib/budget/__tests__/score.test.ts
```
Expected: typecheck exit 0 (this module defines `CampaignInsight` locally, so it resolves now), lint clean on touched files, tests PASS.

```bash
git add app/lib/types.ts app/lib/budget/score.server.ts app/lib/budget/__tests__/score.test.ts
git commit -m "feat(budget): ActionKind increase_campaign_budget + campaign classify"
```

---

## Task 2: planCuts + planFeeds (two-phase, budget-neutral)

**Files:**
- Modify: `app/lib/budget/score.server.ts`
- Test: `app/lib/budget/__tests__/score.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `app/lib/budget/__tests__/score.test.ts`:

```ts
import { planCuts, planFeeds, type Classified } from "../score.server";

function classified(id: string, decision: Classified["decision"], over: Partial<CampaignPerf> = {}): Classified {
  return { campaign: perf({ id, ...over }), decision };
}

describe("planCuts", () => {
  it("cuts each loser by stepPct, clamped at the floor", () => {
    const moves = planCuts(
      [
        classified("a", "negative_unit_economics", { dailyBudgetCents: 5000 }),
        classified("b", "campaign_below_breakeven", { dailyBudgetCents: 600 }),
        classified("w", "winner", { dailyBudgetCents: 9000 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    // a: 5000 - 20% = 4000 (freed 1000); b: 600 - 120 = 480 < floor 500 -> 500 (freed 100); w ignored
    expect(moves).toEqual([
      { campaignId: "a", name: "Camp", fromCents: 5000, toCents: 4000, deltaCents: -1000, role: "cut", roas7d: 2.5 },
      { campaignId: "b", name: "Camp", fromCents: 600, toCents: 500, deltaCents: -100, role: "cut", roas7d: 2.5 },
    ]);
  });

  it("skips losers already at the floor (no negative or zero cut)", () => {
    const moves = planCuts([classified("a", "negative_unit_economics", { dailyBudgetCents: 500 })], DEFAULT_BUDGET_CONFIG);
    expect(moves).toEqual([]);
  });
});

describe("planFeeds", () => {
  it("feeds winners by ROAS desc, each capped at ceilingPct, until the pool is empty", () => {
    const moves = planFeeds(
      [
        classified("hi", "winner", { dailyBudgetCents: 10000, roas7d: 4 }),
        classified("lo", "winner", { dailyBudgetCents: 10000, roas7d: 3 }),
      ],
      3000, // pool $30
      DEFAULT_BUDGET_CONFIG,
    );
    // hi first: cap 2000, add 2000 -> pool 1000; lo: cap 2000, add 1000 -> pool 0
    expect(moves).toEqual([
      { campaignId: "hi", name: "Camp", fromCents: 10000, toCents: 12000, deltaCents: 2000, role: "feed", roas7d: 4 },
      { campaignId: "lo", name: "Camp", fromCents: 10000, toCents: 11000, deltaCents: 1000, role: "feed", roas7d: 3 },
    ]);
  });

  it("returns nothing when the pool is empty", () => {
    expect(planFeeds([classified("hi", "winner")], 0, DEFAULT_BUDGET_CONFIG)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: FAIL -- `planCuts`/`planFeeds` not exported.

- [ ] **Step 3: Implement in `score.server.ts`**

Append to `app/lib/budget/score.server.ts`:

```ts
export function planCuts(classified: Classified[], cfg: BudgetConfig): BudgetMove[] {
  const moves: BudgetMove[] = [];
  for (const c of classified) {
    if (!isLoser(c.decision)) continue;
    const budget = c.campaign.dailyBudgetCents;
    const cut = Math.round(budget * cfg.stepPct);
    const toCents = Math.max(cfg.floorCents, budget - cut);
    const freed = budget - toCents;
    if (freed <= 0) continue;
    moves.push({
      campaignId: c.campaign.id,
      name: c.campaign.name,
      fromCents: budget,
      toCents,
      deltaCents: -freed,
      role: "cut",
      roas7d: c.campaign.roas7d,
    });
  }
  return moves;
}

export function planFeeds(
  classified: Classified[],
  realizedFreedCents: number,
  cfg: BudgetConfig,
): BudgetMove[] {
  const winners = classified
    .filter((c) => c.decision === "winner")
    .map((c) => c.campaign)
    .sort((a, b) => b.roas7d - a.roas7d);
  const moves: BudgetMove[] = [];
  let pool = realizedFreedCents;
  for (const w of winners) {
    if (pool <= 0) break;
    const cap = Math.round(w.dailyBudgetCents * cfg.ceilingPct);
    const add = Math.min(cap, pool);
    if (add <= 0) continue;
    moves.push({
      campaignId: w.id,
      name: w.name,
      fromCents: w.dailyBudgetCents,
      toCents: w.dailyBudgetCents + add,
      deltaCents: add,
      role: "feed",
      roas7d: w.roas7d,
    });
    pool -= add;
  }
  return moves;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/budget/score.server.ts app/lib/budget/__tests__/score.test.ts
git commit -m "feat(budget): planCuts + planFeeds (bounded, budget-neutral)"
```

---

## Task 3: scoreLosers (alert drafts + ranking)

**Files:**
- Modify: `app/lib/budget/score.server.ts`
- Test: `app/lib/budget/__tests__/score.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/lib/budget/__tests__/score.test.ts`:

```ts
import { scoreLosers } from "../score.server";

describe("scoreLosers", () => {
  it("emits one alert per loser, ranked by dollar_impact desc, with detector + severity", () => {
    const drafts = scoreLosers(
      [
        classified("small", "campaign_below_breakeven", { roas7d: 1.5, spend7dCents: 10000 }),
        classified("big", "negative_unit_economics", { roas7d: 0.5, spend7dCents: 40000 }),
        classified("win", "winner"),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    // big: $400 * (1 - 0.5/2) = $400 * 0.75 = $300 ; small: $100 * (1 - 1.5/2) = $100 * 0.25 = $25
    expect(drafts.map((d) => d.entity_ref.campaign_id)).toEqual(["big", "small"]);
    expect(drafts[0]).toMatchObject({
      detectorId: "negative_unit_economics",
      severity: "critical",
      claude_rank: 1,
      entity_ref: { campaign_id: "big", name: "Camp" },
    });
    expect(drafts[0].dollar_impact).toBeCloseTo(300);
    expect(drafts[1]).toMatchObject({ detectorId: "campaign_below_breakeven", severity: "high", claude_rank: 2 });
    expect(drafts[1].dollar_impact).toBeCloseTo(25);
    expect(drafts[0].evidence).toMatchObject({ roas7d: 0.5, spend7d_cents: 40000, target_roas: 2 });
  });

  it("returns nothing when there are no losers", () => {
    expect(scoreLosers([classified("w", "winner"), classified("h", "hold")], DEFAULT_BUDGET_CONFIG)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: FAIL -- `scoreLosers` not exported.

- [ ] **Step 3: Implement in `score.server.ts`**

Append to `app/lib/budget/score.server.ts`:

```ts
export function scoreLosers(classified: Classified[], cfg: BudgetConfig): CampaignAlertDraft[] {
  const drafts: CampaignAlertDraft[] = [];
  for (const c of classified) {
    if (!isLoser(c.decision)) continue;
    const cam = c.campaign;
    const dollarImpact = (cam.spend7dCents / 100) * Math.max(0, 1 - cam.roas7d / cfg.targetRoas);
    const severity: "critical" | "high" = c.decision === "negative_unit_economics" ? "critical" : "high";
    const narrative =
      `${cam.name} is running at ${cam.roas7d.toFixed(2)} ROAS over 7 days against a ` +
      `${cfg.targetRoas.toFixed(2)} target on $${(cam.spend7dCents / 100).toFixed(0)} spend. ` +
      (c.decision === "negative_unit_economics"
        ? "It is returning less than it costs -- cut its budget."
        : "It is below breakeven -- cut its budget and shift it to a winner.");
    drafts.push({
      detectorId: c.decision,
      entity_ref: { campaign_id: cam.id, name: cam.name },
      severity,
      dollar_impact: dollarImpact,
      claude_rank: 0,
      claude_narrative: narrative,
      evidence: {
        roas7d: cam.roas7d,
        spend7d_cents: cam.spend7dCents,
        daily_budget_cents: cam.dailyBudgetCents,
        target_roas: cfg.targetRoas,
        decision: c.decision,
      },
    });
  }
  drafts.sort((a, b) => b.dollar_impact - a.dollar_impact);
  drafts.forEach((d, i) => (d.claude_rank = i + 1));
  return drafts;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/budget/__tests__/score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/budget/score.server.ts app/lib/budget/__tests__/score.test.ts
git commit -m "feat(budget): scoreLosers alert drafts ranked by dollar impact"
```

---

## Task 4: Guardrail gate

**Files:**
- Create: `app/lib/budget/guardrails.server.ts`
- Test: `app/lib/budget/__tests__/guardrails.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/budget/__tests__/guardrails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gateMove, inBusinessHours, type GateStatic } from "../guardrails.server";
import type { BudgetMove } from "../score.server";

const move: BudgetMove = {
  campaignId: "c1", name: "C", fromCents: 5000, toCents: 4000, deltaCents: -1000, role: "cut", roas7d: 0.8,
};

function gate(over: Partial<GateStatic> = {}): GateStatic {
  return {
    nowUtc: new Date("2026-06-02T15:00:00Z"),
    businessHoursStartUtc: 14,
    businessHoursEndUtc: 0, // 14:00..24:00 UTC (wraps)
    cooldownMinutes: 30,
    dollarCapCents: 5000,
    dailyActionBudgetCents: 100000,
    lastActionAtByCampaign: {},
    ...over,
  };
}

describe("inBusinessHours", () => {
  it("handles a normal window", () => {
    expect(inBusinessHours(10, 9, 17)).toBe(true);
    expect(inBusinessHours(17, 9, 17)).toBe(false);
  });
  it("handles a window that wraps midnight (14 -> 0)", () => {
    expect(inBusinessHours(15, 14, 0)).toBe(true);
    expect(inBusinessHours(2, 14, 0)).toBe(false);
  });
  it("treats start==end as always open", () => {
    expect(inBusinessHours(3, 0, 0)).toBe(true);
  });
});

describe("gateMove", () => {
  it("executes inside all guardrails", () => {
    expect(gateMove(move, 0, gate())).toEqual({ decision: "execute", reason: "ok" });
  });
  it("blocks outside business hours", () => {
    expect(gateMove(move, 0, gate({ nowUtc: new Date("2026-06-02T03:00:00Z") }))).toEqual({
      decision: "block", reason: "outside_business_hours",
    });
  });
  it("blocks during cooldown", () => {
    const g = gate({ lastActionAtByCampaign: { c1: "2026-06-02T14:45:00Z" } }); // 15 min ago < 30
    expect(gateMove(move, 0, g)).toEqual({ decision: "block", reason: "cooldown" });
  });
  it("blocks a move larger than the per-action cap", () => {
    expect(gateMove(move, 0, gate({ dollarCapCents: 500 }))).toEqual({
      decision: "block", reason: "over_dollar_cap",
    });
  });
  it("blocks when the daily action budget would be exceeded", () => {
    expect(gateMove(move, 99500, gate())).toEqual({ decision: "block", reason: "daily_budget_exhausted" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/budget/__tests__/guardrails.test.ts`
Expected: FAIL -- cannot find module `../guardrails.server`.

- [ ] **Step 3: Implement the gate**

Create `app/lib/budget/guardrails.server.ts`:

```ts
import type { BudgetMove } from "./score.server";

export type GateStatic = {
  nowUtc: Date;
  businessHoursStartUtc: number;
  businessHoursEndUtc: number;
  cooldownMinutes: number;
  dollarCapCents: number;
  dailyActionBudgetCents: number;
  lastActionAtByCampaign: Record<string, string | null>;
};

export type GateDecision = { decision: "execute" | "block"; reason: string };

export function inBusinessHours(hourUtc: number, startUtc: number, endUtc: number): boolean {
  if (startUtc === endUtc) return true; // degenerate window = always open
  return startUtc < endUtc
    ? hourUtc >= startUtc && hourUtc < endUtc
    : hourUtc >= startUtc || hourUtc < endUtc; // wraps midnight, e.g. 14 -> 0
}

export function gateMove(move: BudgetMove, usedTodayCents: number, g: GateStatic): GateDecision {
  const hour = g.nowUtc.getUTCHours();
  if (!inBusinessHours(hour, g.businessHoursStartUtc, g.businessHoursEndUtc)) {
    return { decision: "block", reason: "outside_business_hours" };
  }
  const last = g.lastActionAtByCampaign[move.campaignId];
  if (last) {
    const elapsedMin = (g.nowUtc.getTime() - new Date(last).getTime()) / 60000;
    if (elapsedMin < g.cooldownMinutes) return { decision: "block", reason: "cooldown" };
  }
  const magnitude = Math.abs(move.deltaCents);
  if (magnitude > g.dollarCapCents) return { decision: "block", reason: "over_dollar_cap" };
  if (usedTodayCents + magnitude > g.dailyActionBudgetCents) {
    return { decision: "block", reason: "daily_budget_exhausted" };
  }
  return { decision: "execute", reason: "ok" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/budget/__tests__/guardrails.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/budget/guardrails.server.ts app/lib/budget/__tests__/guardrails.test.ts
git commit -m "feat(budget): guardrail gate (hours/cooldown/cap/daily-budget)"
```

---

## Task 5: Meta insights + budget write

**Files:**
- Modify: `app/lib/meta/campaigns.server.ts`
- Test: `app/lib/meta/__tests__/campaigns.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `app/lib/meta/__tests__/campaigns.test.ts`:

```ts
import { fetchCampaignInsights, setCampaignBudget } from "../campaigns.server";

describe("fetchCampaignInsights", () => {
  it("parses spend->cents and the purchase_roas array (omni_purchase pick), missing -> 0", async () => {
    const get = vi.fn(async () => ({
      data: [
        { campaign_id: "120", spend: "50.00", purchase_roas: [{ action_type: "omni_purchase", value: "3.12" }] },
        { campaign_id: "121", spend: "12.34" },
      ],
    }));
    const out = await fetchCampaignInsights(fakeClient({ get }), "act_99");
    expect(get).toHaveBeenCalledWith("/act_99/insights", {
      level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,purchase_roas",
    });
    expect(out).toEqual({
      "120": { spend7dCents: 5000, roas7d: 3.12 },
      "121": { spend7dCents: 1234, roas7d: 0 },
    });
  });

  it("follows pagination cursors", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ campaign_id: "1", spend: "1.00" }],
        paging: { next: "http://next", cursors: { after: "CUR2" } },
      })
      .mockResolvedValueOnce({ data: [{ campaign_id: "2", spend: "2.00" }] });
    const out = await fetchCampaignInsights(fakeClient({ get }), "act_1");
    expect(get).toHaveBeenNthCalledWith(2, "/act_1/insights", {
      level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,purchase_roas", after: "CUR2",
    });
    expect(Object.keys(out)).toEqual(["1", "2"]);
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ error: { message: "Bad account", code: 100 } })) });
    await expect(fetchCampaignInsights(client, "act_99")).rejects.toThrow(/Bad account/);
  });
});

describe("setCampaignBudget", () => {
  it("posts the daily_budget in cents as a string", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await setCampaignBudget(fakeClient({ post }), "120", 4000);
    expect(post).toHaveBeenCalledWith("/120", { daily_budget: "4000" });
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ post: vi.fn(async () => ({ error: { message: "Cannot set budget", code: 200 } })) });
    await expect(setCampaignBudget(client, "120", 4000)).rejects.toThrow(/Cannot set budget/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/meta/__tests__/campaigns.test.ts`
Expected: FAIL -- `fetchCampaignInsights`/`setCampaignBudget` not exported.

- [ ] **Step 3: Implement in `campaigns.server.ts`**

Append to `app/lib/meta/campaigns.server.ts` (the return shape is structurally `CampaignInsight` from `score.server.ts`; meta does not import from budget to keep layering one-directional):

```ts
type RawInsight = {
  campaign_id: string;
  spend?: string;
  purchase_roas?: { action_type?: string; value?: string }[];
};

function parsePurchaseRoas(pr: RawInsight["purchase_roas"]): number {
  if (!Array.isArray(pr) || pr.length === 0) return 0;
  const entry = pr.find((e) => e.action_type === "omni_purchase") ?? pr[0];
  const v = Number(entry?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export async function fetchCampaignInsights(
  client: MetaClient,
  adAccountId: string,
): Promise<Record<string, { spend7dCents: number; roas7d: number }>> {
  const out: Record<string, { spend7dCents: number; roas7d: number }> = {};
  let params: Record<string, string> = {
    level: "campaign",
    date_preset: "last_7d",
    fields: "campaign_id,spend,purchase_roas",
  };
  for (let page = 0; page < 50; page++) {
    const body = check(await client.get(`/${adAccountId}/insights`, params));
    for (const row of (body.data as RawInsight[]) ?? []) {
      out[String(row.campaign_id)] = {
        spend7dCents: Math.round(Number(row.spend ?? 0) * 100),
        roas7d: parsePurchaseRoas(row.purchase_roas),
      };
    }
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    if (!paging?.next || !paging.cursors?.after) break;
    params = { ...params, after: paging.cursors.after };
  }
  return out;
}

export async function setCampaignBudget(
  client: MetaClient,
  campaignId: string,
  dailyBudgetCents: number,
): Promise<void> {
  check(await client.post(`/${campaignId}`, { daily_budget: String(dailyBudgetCents) }));
}
```

- [ ] **Step 4: Commit gate, then commit**

```bash
npm run typecheck
npm run lint
npx vitest run app/lib/meta/__tests__/campaigns.test.ts
```
Expected: typecheck exit 0, lint clean on touched files, tests PASS.

```bash
git add app/lib/meta/campaigns.server.ts app/lib/meta/__tests__/campaigns.test.ts
git commit -m "feat(meta): fetchCampaignInsights + setCampaignBudget"
```

---

## Task 6: planTick (two-phase composition)

**Files:**
- Create: `app/lib/budget/tick.server.ts`
- Test: `app/lib/budget/__tests__/tick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/budget/__tests__/tick.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planTick } from "../tick.server";
import { DEFAULT_BUDGET_CONFIG } from "../score.server";
import type { GateStatic } from "../guardrails.server";
import type { MetaCampaign } from "../../meta/campaigns.server";

function campaign(over: Partial<MetaCampaign>): MetaCampaign {
  return { id: "c", name: "C", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000, ...over };
}

function openGate(over: Partial<GateStatic> = {}): GateStatic {
  return {
    nowUtc: new Date("2026-06-02T15:00:00Z"),
    businessHoursStartUtc: 0,
    businessHoursEndUtc: 0, // always open
    cooldownMinutes: 30,
    dollarCapCents: 1_000_000,
    dailyActionBudgetCents: 1_000_000,
    lastActionAtByCampaign: {},
    ...over,
  };
}

describe("planTick", () => {
  it("cuts losers, then feeds winners from the realized pool, staying budget-neutral", () => {
    const campaigns = [
      campaign({ id: "loser", dailyBudgetCents: 5000 }),
      campaign({ id: "winner", dailyBudgetCents: 8000 }),
    ];
    const insights = {
      loser: { spend7dCents: 10000, roas7d: 0.7 },
      winner: { spend7dCents: 10000, roas7d: 3.1 },
    };
    const plan = planTick(campaigns, insights, DEFAULT_BUDGET_CONFIG, openGate(), 0);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]).toMatchObject({ campaignId: "loser", toCents: 4000, decision: "execute" });
    expect(plan.feeds).toHaveLength(1);
    // realized pool = 1000; winner ceiling = 1600 -> add 1000
    expect(plan.feeds[0]).toMatchObject({ campaignId: "winner", deltaCents: 1000, toCents: 9000, decision: "execute" });
    expect(plan.breachingCampaignIds).toEqual(["loser"]);
    expect(plan.loserAlerts[0].entity_ref.campaign_id).toBe("loser");
  });

  it("does NOT feed from a blocked cut -- a blocked cut contributes nothing to the pool", () => {
    const campaigns = [
      campaign({ id: "loser", dailyBudgetCents: 5000 }),
      campaign({ id: "winner", dailyBudgetCents: 8000 }),
    ];
    const insights = {
      loser: { spend7dCents: 10000, roas7d: 0.7 },
      winner: { spend7dCents: 10000, roas7d: 3.1 },
    };
    // cap below the cut magnitude (1000) -> cut blocked -> pool stays 0 -> no feeds
    const plan = planTick(campaigns, insights, DEFAULT_BUDGET_CONFIG, openGate({ dollarCapCents: 500 }), 0);
    expect(plan.cuts[0].decision).toBe("block");
    expect(plan.feeds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/budget/__tests__/tick.test.ts`
Expected: FAIL -- cannot find module `../tick.server`.

- [ ] **Step 3: Implement planTick**

Create `app/lib/budget/tick.server.ts`:

```ts
import {
  classify,
  planCuts,
  planFeeds,
  scoreLosers,
  toPerf,
  isLoser,
  type BudgetConfig,
  type BudgetMove,
  type CampaignAlertDraft,
  type CampaignInsight,
} from "./score.server";
import { gateMove, type GateStatic } from "./guardrails.server";
import type { MetaCampaign } from "../meta/campaigns.server";

export type GatedMove = BudgetMove & { decision: "execute" | "block"; reason: string };

export type TickPlan = {
  cuts: GatedMove[];
  feeds: GatedMove[];
  loserAlerts: CampaignAlertDraft[];
  breachingCampaignIds: string[];
};

export function planTick(
  campaigns: MetaCampaign[],
  insights: Record<string, CampaignInsight>,
  cfg: BudgetConfig,
  gate: GateStatic,
  usedTodayCents0: number,
): TickPlan {
  const classified = classify(toPerf(campaigns, insights), cfg);
  const loserAlerts = scoreLosers(classified, cfg);
  const breachingCampaignIds = classified.filter((c) => isLoser(c.decision)).map((c) => c.campaign.id);

  let used = usedTodayCents0;
  let realizedFreed = 0;
  const cuts: GatedMove[] = planCuts(classified, cfg).map((m) => {
    const g = gateMove(m, used, gate);
    if (g.decision === "execute") {
      used += Math.abs(m.deltaCents);
      realizedFreed += Math.abs(m.deltaCents);
    }
    return { ...m, ...g };
  });

  const feeds: GatedMove[] = planFeeds(classified, realizedFreed, cfg).map((m) => {
    const g = gateMove(m, used, gate);
    if (g.decision === "execute") used += Math.abs(m.deltaCents);
    return { ...m, ...g };
  });

  return { cuts, feeds, loserAlerts, breachingCampaignIds };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/budget/__tests__/tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/budget/tick.server.ts app/lib/budget/__tests__/tick.test.ts
git commit -m "feat(budget): planTick two-phase plan (cuts realize the feed pool)"
```

---

## Task 7: actions.execute records dollar_impact_at_exec + budget undo

**Files:**
- Modify: `app/lib/calderyn.server.ts` (`ExecuteActionOpts` ~35-42; `actions.execute` insert ~320-334; imports line 14; `audit.undo` ~236-253)
- Test: `app/lib/__tests__/audit-undo-budget.test.ts`

- [ ] **Step 1: Add `dollarImpactAtExec` to `ExecuteActionOpts` and write it**

In `app/lib/calderyn.server.ts`, extend the type:

```ts
export type ExecuteActionOpts = {
  alertId: string | null;
  kind: ActionKind;
  params: Record<string, unknown>;
  idempotencyKey: string;
  preState?: unknown;
  postState?: unknown;
  dollarImpactAtExec?: number;
};
```

In `actions.execute`, add the field to the `action_audit` insert object (alongside `actor_user_id`):

```ts
        actor_user_id: "demo@calderyn.app",
        dollar_impact_at_exec: opts.dollarImpactAtExec ?? null,
        completed_at: new Date().toISOString(),
```

- [ ] **Step 2: Import `setCampaignBudget` and add the budget-restore branch to `audit.undo`**

Change the import on line 14:

```ts
import { setCampaignStatus, setCampaignBudget } from "./meta/campaigns.server";
```

In `audit.undo`, immediately after the existing `pause_campaign` restore block (just before `const undoRow = {`), add:

```ts
          // For budget actions, restore the prior daily_budget on Meta first.
          if (
            orig.action_kind === "reduce_campaign_budget" ||
            orig.action_kind === "increase_campaign_budget"
          ) {
            const priorCents = (orig.pre_state as { daily_budget_cents?: number } | null)?.daily_budget_cents;
            const campaignId = (orig.post_state as { campaign_id?: string } | null)?.campaign_id;
            if (typeof priorCents === "number" && campaignId) {
              const meta = await metaClientForShop(shop);
              if (!meta) {
                throw new CalderynError({
                  code: "UNDO_META_UNAVAILABLE",
                  status: 400,
                  message: "Cannot undo: Meta is not connected.",
                });
              }
              await setCampaignBudget(meta.client, campaignId, priorCents);
            }
          }
```

- [ ] **Step 3: Write the failing test**

Create `app/lib/__tests__/audit-undo-budget.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

const { insertSpy, setBudgetSpy, metaForShopSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  setBudgetSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "a1",
                action_kind: "reduce_campaign_budget",
                pre_state: { campaign_id: "120", daily_budget_cents: 5000 },
                post_state: { campaign_id: "120", daily_budget_cents: 4000 },
                alert_id: null,
                params: {},
                dollar_impact_at_exec: 10,
              },
              error: null,
            }),
          }),
        }),
      }),
      insert: insertSpy,
    }),
  }),
  resolveShopId: async () => "shop-uuid",
}));

vi.mock("../meta/client.server", () => ({
  metaClientForShop: (...args: unknown[]) => metaForShopSpy(...args),
}));

vi.mock("../meta/campaigns.server", () => ({
  setCampaignStatus: vi.fn(),
  setCampaignBudget: (...args: unknown[]) => setBudgetSpy(...args),
}));

beforeEach(() => {
  insertSpy.mockReset();
  setBudgetSpy.mockReset();
  metaForShopSpy.mockReset();
});

describe("audit.undo budget safety", () => {
  it("restores the prior daily_budget and writes no inverse row when Meta fails", async () => {
    metaForShopSpy.mockResolvedValue({ client: { get: vi.fn(), post: vi.fn() }, adAccountId: "act_1" });
    setBudgetSpy.mockRejectedValue(new Error("Meta API error: Cannot set budget"));

    const client = calderynClient("acme.myshopify.com");

    await expect(client.audit.undo("a1")).rejects.toThrow(/Cannot set budget/);
    expect(setBudgetSpy).toHaveBeenCalledWith(expect.anything(), "120", 5000);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/__tests__/audit-undo-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing undo test to confirm no regression**

Run: `npx vitest run app/lib/__tests__/audit-undo-meta.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/calderyn.server.ts app/lib/__tests__/audit-undo-budget.test.ts
git commit -m "feat(audit): persist dollar_impact_at_exec + restore budget on undo"
```

---

## Task 8: Supabase migration (config columns + lock table)

**Files:**
- Create: `supabase/migrations/20260602120000_budget_loop_config.sql`

> Coordination (spec Section 11): confirm this timestamp is later than every existing migration (latest is `20260601010000`) and does not collide with the parallel session's migration before applying. Adjust the timestamp if needed.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260602120000_budget_loop_config.sql`:

```sql
-- Ad-budget reallocation loop settings + overlap lock.
alter table guardrail_config
  add column if not exists target_roas        numeric not null default 2.0,
  add column if not exists budget_step_pct    numeric not null default 0.20,
  add column if not exists budget_floor_cents integer not null default 500,
  add column if not exists budget_ceiling_pct numeric not null default 0.20,
  add column if not exists lose_band          numeric not null default 0.90,
  add column if not exists win_band           numeric not null default 1.20,
  add column if not exists min_spend_7d_cents integer not null default 2000;

create table if not exists budget_loop_lock (
  shop_id   uuid primary key references shops(id) on delete cascade,
  locked_at timestamptz not null
);

-- Atomic per-move reservation. The composite PK makes the INSERT in the loop's
-- apply() conflict (and thus skip) if the same move was already claimed this
-- tick -- closing the check-then-act race in the idempotency path.
-- (Rows are keyed by tick_hour, so the table grows ~slowly; prune rows older
-- than a few days in a later housekeeping job -- tracked as a plan open item.)
create table if not exists budget_move_ledger (
  shop_id        uuid not null references shops(id) on delete cascade,
  idempotency_key text not null,
  applied_at     timestamptz not null,
  primary key (shop_id, idempotency_key)
);
```

- [ ] **Step 2: Apply via Supabase tooling**

Apply through the Supabase migration workflow used for the prior slices (CLI `supabase db push` or the dashboard migration runner against project `Calderyn-SHOPIFY`). This is **not** a Prisma migration (spec Section 10).
Expected: columns exist on `guardrail_config`; `budget_loop_lock` table exists.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260602120000_budget_loop_config.sql
git commit -m "feat(db): budget loop config columns + loop lock + move ledger"
```

---

## Task 9: Loop orchestration

**Files:**
- Create: `app/lib/budget/loop.server.ts`

> No bespoke unit test (see Test boundary note at the top). All decision logic is in `planTick` (Task 6). This task is verified by `npm run typecheck` + `npm run build` and the end-to-end run in Task 11.

- [ ] **Step 1: Implement the loop**

Create `app/lib/budget/loop.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../supabase.server";
import { calderynClient } from "../calderyn.server";
import { metaClientForShop } from "../meta/client.server";
import { listCampaigns, fetchCampaignInsights, setCampaignBudget } from "../meta/campaigns.server";
import { planTick, type GatedMove } from "./tick.server";
import {
  DEFAULT_BUDGET_CONFIG,
  type BudgetConfig,
  type CampaignAlertDraft,
} from "./score.server";
import type { GateStatic } from "./guardrails.server";

const BUDGET_KINDS = ["reduce_campaign_budget", "increase_campaign_budget"];
const LOSER_DETECTORS = ["campaign_below_breakeven", "negative_unit_economics"];
const LOCK_STALE_MINUTES = 15;

export type ShopLoopResult = {
  shop: string;
  cutsApplied: number;
  feedsApplied: number;
  freedCents: number;
  blocked: number;
  campaignErrors: number;
  alertsUpserted: number;
  alertsResolved: number;
  skipped?: string;
};

function tickHour(now: Date): string {
  return now.toISOString().slice(0, 13); // e.g. "2026-06-02T15"
}

export async function runBudgetLoopForShop(shopDomain: string, now = new Date()): Promise<ShopLoopResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const result: ShopLoopResult = {
    shop: shopDomain, cutsApplied: 0, feedsApplied: 0, freedCents: 0,
    blocked: 0, campaignErrors: 0, alertsUpserted: 0, alertsResolved: 0,
  };

  // Overlap guard: drop a stale lock, then claim. A live lock means another tick owns this shop.
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MINUTES * 60000).toISOString();
  await sb.from("budget_loop_lock").delete().eq("shop_id", shopId).lt("locked_at", staleBefore);
  const claim = await sb.from("budget_loop_lock").insert({ shop_id: shopId, locked_at: now.toISOString() });
  if (claim.error) {
    result.skipped = "locked";
    return result;
  }

  try {
    const meta = await metaClientForShop(shopDomain);
    if (!meta) {
      result.skipped = "meta_not_connected";
      return result;
    }

    const { data: gc } = await sb.from("guardrail_config").select("*").eq("shop_id", shopId).maybeSingle();
    const cfg: BudgetConfig = {
      targetRoas: Number(gc?.target_roas ?? DEFAULT_BUDGET_CONFIG.targetRoas),
      loseBand: Number(gc?.lose_band ?? DEFAULT_BUDGET_CONFIG.loseBand),
      winBand: Number(gc?.win_band ?? DEFAULT_BUDGET_CONFIG.winBand),
      stepPct: Number(gc?.budget_step_pct ?? DEFAULT_BUDGET_CONFIG.stepPct),
      floorCents: Number(gc?.budget_floor_cents ?? DEFAULT_BUDGET_CONFIG.floorCents),
      ceilingPct: Number(gc?.budget_ceiling_pct ?? DEFAULT_BUDGET_CONFIG.ceilingPct),
      minSpend7dCents: Number(gc?.min_spend_7d_cents ?? DEFAULT_BUDGET_CONFIG.minSpend7dCents),
    };

    // Used-today + last-action-per-campaign from today's budget audits (UTC day).
    const dayStart = now.toISOString().slice(0, 10) + "T00:00:00Z";
    const { data: todays } = await sb
      .from("action_audit")
      .select("dollar_impact_at_exec, params, completed_at")
      .eq("shop_id", shopId)
      .in("action_kind", BUDGET_KINDS)
      .gte("completed_at", dayStart);
    let usedTodayCents = 0;
    const lastActionAtByCampaign: Record<string, string | null> = {};
    for (const r of todays ?? []) {
      usedTodayCents += Math.abs(Number(r.dollar_impact_at_exec ?? 0)) * 100;
      const cid = (r.params as { campaign_id?: string } | null)?.campaign_id;
      const t = r.completed_at ? String(r.completed_at) : null;
      if (cid && t) {
        const prev = lastActionAtByCampaign[cid];
        if (!prev || new Date(t) > new Date(prev)) lastActionAtByCampaign[cid] = t;
      }
    }

    const gate: GateStatic = {
      nowUtc: now,
      businessHoursStartUtc: Number(gc?.business_hours_start_utc ?? 0),
      businessHoursEndUtc: Number(gc?.business_hours_end_utc ?? 0),
      cooldownMinutes: Number(gc?.cooldown_minutes_per_campaign ?? 30),
      dollarCapCents: Math.round(Number(gc?.dollar_impact_cap_without_2fa ?? 0) * 100),
      dailyActionBudgetCents: Math.round(Number(gc?.daily_action_budget ?? 0) * 100),
      lastActionAtByCampaign,
    };

    const campaigns = await listCampaigns(meta.client, meta.adAccountId);
    const insights = await fetchCampaignInsights(meta.client, meta.adAccountId);
    const plan = planTick(campaigns, insights, cfg, gate, usedTodayCents);
    const client = calderynClient(shopDomain);

    const apply = async (m: GatedMove) => {
      if (m.decision === "block") {
        result.blocked += 1;
        return;
      }
      // Deterministic key: at most one cut and one feed per campaign per UTC hour.
      const key = `budget:${shopId}:${m.campaignId}:${tickHour(now)}:${m.role}`;

      // ATOMIC reservation BEFORE the Meta write. A PK conflict means this move
      // was already claimed this tick -> skip (no select-then-act race).
      const claim = await sb
        .from("budget_move_ledger")
        .insert({ shop_id: shopId, idempotency_key: key, applied_at: now.toISOString() });
      if (claim.error) return; // already claimed/applied this tick

      try {
        // Absolute write: re-applying the same toCents is a no-op, so an
        // at-least-once retry cannot move the budget twice.
        await setCampaignBudget(meta.client, m.campaignId, m.toCents);
        const kind = m.role === "cut" ? "reduce_campaign_budget" : "increase_campaign_budget";
        await client.actions.execute({
          alertId: null,
          kind,
          params: {
            role: m.role,
            campaign_id: m.campaignId,
            campaign_name: m.name,
            from_cents: m.fromCents,
            to_cents: m.toCents,
            delta_cents: m.deltaCents,
            roas7d: m.roas7d,
            target_roas: cfg.targetRoas,
            tick_hour: tickHour(now),
          },
          idempotencyKey: key,
          dollarImpactAtExec: Math.abs(m.deltaCents) / 100,
          preState: { campaign_id: m.campaignId, daily_budget_cents: m.fromCents },
          postState: { campaign_id: m.campaignId, daily_budget_cents: m.toCents },
        });
        if (m.role === "cut") {
          result.cutsApplied += 1;
          result.freedCents += Math.abs(m.deltaCents);
        } else {
          result.feedsApplied += 1;
        }
      } catch (err) {
        // Release the claim so a later tick can re-attempt; the absolute Meta
        // write makes a re-attempt safe. One bad campaign must not abort the
        // shop (spec Section 12) -> log and continue.
        await sb.from("budget_move_ledger").delete().eq("shop_id", shopId).eq("idempotency_key", key);
        result.campaignErrors += 1;
        console.error(`[cron.budget-loop] move failed shop=${shopDomain} campaign=${m.campaignId} role=${m.role}`, err);
      }
    };

    for (const m of plan.cuts) await apply(m); // phase A
    for (const m of plan.feeds) await apply(m); // phase B

    const alertOutcome = await upsertLoserAlerts(shopId, plan.loserAlerts, plan.breachingCampaignIds, now);
    result.alertsUpserted = alertOutcome.upserted;
    result.alertsResolved = alertOutcome.resolved;
    return result;
  } finally {
    await sb.from("budget_loop_lock").delete().eq("shop_id", shopId);
  }
}

async function upsertLoserAlerts(
  shopId: string,
  drafts: CampaignAlertDraft[],
  breachingIds: string[],
  now: Date,
): Promise<{ upserted: number; resolved: number }> {
  const sb = getSupabase();
  const dayBucket = now.toISOString().slice(0, 10);
  let upserted = 0;

  for (const d of drafts) {
    const { data: existing } = await sb
      .from("alerts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("detector_id", d.detectorId)
      .eq("day_bucket", dayBucket)
      .filter("entity_ref->>campaign_id", "eq", d.entity_ref.campaign_id)
      .maybeSingle();

    let alertId: string;
    if (existing) {
      alertId = (existing as { id: string }).id;
      await sb
        .from("alerts")
        .update({
          severity: d.severity,
          dollar_impact: d.dollar_impact,
          claude_rank: d.claude_rank,
          claude_narrative: d.claude_narrative,
          entity_ref: d.entity_ref,
          status: "open",
          last_seen_at: now.toISOString(),
          resolved_at: null,
        })
        .eq("id", alertId);
    } else {
      const { data: ins, error: insErr } = await sb
        .from("alerts")
        .upsert(
          {
            shop_id: shopId,
            detector_id: d.detectorId,
            entity_ref: d.entity_ref,
            status: "open",
            severity: d.severity,
            dollar_impact: d.dollar_impact,
            day_bucket: dayBucket,
            claude_narrative: d.claude_narrative,
            claude_rank: d.claude_rank,
            first_seen_at: now.toISOString(),
            last_seen_at: now.toISOString(),
          },
          { onConflict: "shop_id,detector_id,entity_ref,day_bucket" },
        )
        .select("id")
        .single();
      if (insErr) throw insErr;
      alertId = (ins as { id: string }).id;
    }
    await sb
      .from("alert_context")
      .upsert(
        { alert_id: alertId, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() },
        { onConflict: "alert_id" },
      );
    upserted += 1;
  }

  // Recovery: resolve open campaign alerts whose campaign no longer breaches.
  const breaching = new Set(breachingIds);
  const { data: openRows } = await sb
    .from("alerts")
    .select("id, entity_ref")
    .eq("shop_id", shopId)
    .in("detector_id", LOSER_DETECTORS)
    .eq("status", "open");
  let resolved = 0;
  for (const r of openRows ?? []) {
    const cid = (r.entity_ref as { campaign_id?: string })?.campaign_id;
    if (cid && !breaching.has(cid)) {
      await sb.from("alerts").update({ status: "resolved", resolved_at: now.toISOString() }).eq("id", r.id);
      resolved += 1;
    }
  }
  return { upserted, resolved };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/budget/loop.server.ts
git commit -m "feat(budget): per-shop loop (lock, idempotent apply, loser alerts)"
```

---

## Task 10: Cron route

**Files:**
- Create: `app/routes/cron.budget-loop.tsx`

- [ ] **Step 1: Implement the route**

Create `app/routes/cron.budget-loop.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { runBudgetLoopForShop } from "~/lib/budget/loop.server";

const MAX_SHOPS = 10; // bounded per tick to stay under the function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    shopsProcessed: 0,
    cutsApplied: 0,
    feedsApplied: 0,
    freedCents: 0,
    blocked: 0,
    campaignErrors: 0,
    alertsUpserted: 0,
    alertsResolved: 0,
    errors: [] as string[],
  };

  const { data: shops } = await sb
    .from("shop_integrations")
    .select("shops!inner(shop_domain)")
    .eq("kind", "meta_ads")
    .eq("sync_status", "ready")
    .limit(MAX_SHOPS);

  for (const row of shops ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      const r = await runBudgetLoopForShop(domain);
      summary.shopsProcessed += 1;
      summary.cutsApplied += r.cutsApplied;
      summary.feedsApplied += r.feedsApplied;
      summary.freedCents += r.freedCents;
      summary.blocked += r.blocked;
      summary.campaignErrors += r.campaignErrors;
      summary.alertsUpserted += r.alertsUpserted;
      summary.alertsResolved += r.alertsResolved;
    } catch (err) {
      // One shop's failure must not deny the rest their reallocation.
      summary.errors.push(domain);
      console.error(`[cron.budget-loop] failed for ${domain}`, err);
    }
  }

  return json(summary);
};
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0 (Remix + Vite build completes, new route registered).

- [ ] **Step 3: Commit**

```bash
git add app/routes/cron.budget-loop.tsx
git commit -m "feat(cron): hourly budget-loop route (Bearer auth, JSON summary)"
```

---

## Task 11: Schedule + full pre-commit gate

**Files:**
- Modify: `vercel.json` (if present)
- Verify: `.env.example` (`CRON_SECRET` already present -- reused, no new var)

- [ ] **Step 1: Add the hourly schedule**

Open `vercel.json`. If it has a `crons` array (the `cron.ingest` entry lives here), add:

```json
{ "path": "/cron/budget-loop", "schedule": "0 * * * *" }
```

The invocation/auth mechanism mirrors the existing `/cron/ingest` entry (same `CRON_SECRET` Bearer). If `vercel.json` has no `crons` array yet, mirror exactly how `cron.ingest` is scheduled in this repo's deploy config. (Cadence tuning is a spec Section 15 open item.)

- [ ] **Step 2: Confirm no new env var is needed**

`CRON_SECRET` is already in `.env.example` (used by `cron.ingest`). The budget loop reuses it. No `.env.example` change.

- [ ] **Step 3: Run the full pre-commit gate (CLAUDE.md)**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: all exit 0. Resolve any lint warnings on touched files (`--max-warnings=0` for new code).

- [ ] **Step 4: Patch sanity**

```bash
git diff --stat
git diff --check
```
Expected: no whitespace errors, no stray `console.log`/`.only`/`TODO(me)` introduced (the route's `console.error` for shop failures is intentional, matching `cron.ingest`).

- [ ] **Step 5: Run `/code-review` on the branch and resolve blockers**

Per CLAUDE.md pre-commit gate. Downgrade any nit explicitly with a one-line justification.

- [ ] **Step 6: Commit the schedule**

```bash
git add vercel.json
git commit -m "chore(cron): schedule budget-loop hourly"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 2.1 fetch ROAS from insights | Task 5 (`fetchCampaignInsights`) |
| 2.2 classify + min spend hold | Task 1 (`classify` eligibility) |
| 2.3 two-phase, never raise spend | Task 6 (`planTick`) + Task 2 (`planCuts`/`planFeeds`) |
| 2.4 gate before Meta; blocked behavior | Task 4 (gate) + Task 9 (apply/blocked count) |
| 2.5 real Meta write + undoable audit + dollar_impact_at_exec | Task 5 (`setCampaignBudget`), Task 7, Task 9 |
| 2.6 loser alerts + recovery | Task 3 + Task 9 (`upsertLoserAlerts`) |
| 2.7 idempotency / overlap | Task 9 (atomic `budget_move_ledger` reservation + shop lock) + Task 8 (ledger table) |
| 2.8 per-shop/campaign isolation + summary | Task 9 + Task 10 |
| 6.3 feed audit params | Task 9 (`apply` params block) |
| 7 gate order + UTC time semantics | Task 4 |
| 8 purchase_roas array parsing | Task 5 |
| 9 undo restores prior budget | Task 7 |
| 10 migration | Task 8 |
| 11 ActionKind one line; one migration | Task 1, Task 8 |

**Type consistency:** `BudgetConfig`, `BudgetMove`, `Classified`, `CampaignAlertDraft`, `CampaignInsight`, `GateStatic`, `GatedMove`, `TickPlan` are each defined once and imported everywhere they are used. `CampaignInsight` is defined in `campaigns.server.ts` (Task 5) and imported by `score.server.ts` (Task 1) and `tick.server.ts` (Task 6) -- the Task 1 note flags that typecheck is deferred until Task 5 closes that import.

**Placeholder scan:** no TBD/TODO/"handle errors"/"similar to" -- every code step shows the actual code.
