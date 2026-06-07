# Ad Campaign Integrations — Slice 4 (Auto-pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in auto-pilot that automatically pauses (or trims the budget of) clearly money-losing campaigns for shops that turned it on — running the exact Slice 3 action path, bounded by enforced guardrails, every action audited as `autopilot` and undoable.

**Architecture:** Auto-pilot is "one-click with the human stepped out." A pure `evaluateGuardrails(config, facts)` decides if an action is permitted; a thin `checkGuardrails` server wrapper loads the shop's config + counts. A cron (`cron.autopilot`) scans open money-losing alerts for shops with `autopilot_enabled = true`, derives the action, runs the guardrail check, and on pass calls the existing `executeAction` (Slice 3) with `actor = "autopilot"`. The Settings page gets an Auto-pilot toggle (off by default = the kill-switch) plus the rule fields.

**Tech Stack:** TypeScript (strict, ES modules), `@supabase/supabase-js` (service role), Vitest, Remix routes/Polaris. Reuses `executeAction` (`app/lib/actions/execute.server.ts`), `isAuthorizedCron`, `mapWithConcurrency`. Spec: `docs/superpowers/specs/2026-06-06-ad-campaign-integrations-design.md`.

---

## Design decisions (conservative defaults)

- **Toggle + kill-switch = one field.** `guardrail_config.autopilot_enabled` (boolean, **default false**). Off by default is the opt-in; flipping it off is the instant global kill-switch (the cron skips disabled shops). YAGNI — no separate "paused" flag.
- **What triggers an auto-action:** open `alerts` for the **money-losing detectors** — `campaign_below_breakeven`, `negative_unit_economics`, `ad_tax_overload` — that resolve to a real `ad_campaign_dim` campaign. Other detectors never auto-act.
- **Which action:** `campaign_below_breakeven` / `negative_unit_economics` → **pause** (decisive, fully reversible). `ad_tax_overload` → **reduce budget** to `(1 − maxBudgetCutPct/100) × current`. Both are Slice 3 actions.
- **Guardrail rule set (all enforced):** auto-pilot enabled; per-action `dollar_impact ≤ dollar cap`; **daily action cap** (count of autopilot actions today < `autopilot_daily_action_cap`); **min spend before acting** (campaign 7-day spend ≥ `autopilot_min_spend_cents`, so we never act on too-little data); **max budget cut %** (a budget action can't cut more than `autopilot_max_budget_cut_pct`); **cooldown** (no autopilot action on the same campaign within `cooldown_minutes_per_campaign`); **business hours** (if `business_hours_only`, only act inside the window).
- **Defaults:** `autopilot_daily_action_cap = 3`, `autopilot_min_spend_cents = 20000` ($200), `autopilot_max_budget_cut_pct = 50`. Existing `dollar_impact_cap_without_2fa` and `cooldown_minutes_per_campaign` are reused.
- **Audit:** every auto-action is a normal `action_audit` row with `actor_user_id = "autopilot"`, so it shows in the audit trail and is undoable via the Slice 3 undo path.

---

## File Structure

**New files:**
- `app/lib/actions/guardrails.ts` — pure `evaluateGuardrails(config, facts)` + types.
- `app/lib/actions/guardrails.server.ts` — `checkGuardrails(shopId, facts, sb)` (loads config + today's autopilot count + last-action time).
- `app/lib/actions/autopilot.server.ts` — `runAutopilotForShop(shopId, sb)`.
- `app/routes/cron.autopilot.tsx` — the cron.
- Test files mirror each under `__tests__/`.
- `supabase/migrations/20260606140000_autopilot_guardrails.sql` + `tests/engine/schema/migrations/20260606140000_autopilot_guardrails.sql`.

**Modified files:**
- `app/lib/actions/execute.server.ts` — add optional `actor` to `ExecuteInput`.
- `app/lib/types.ts` — extend `GuardrailConfig` with the autopilot fields.
- `app/lib/calderyn.server.ts` — `guardrails.get`/`update` map the new fields. (No other work-stream is editing this now.)
- `app/routes/app.settings.tsx` — Auto-pilot toggle + fields in `GuardrailsCard`.
- `vercel.json` — add the `/cron/autopilot` schedule.

---

## Task 1: Migration — autopilot guardrail columns

**Files:**
- Create: `supabase/migrations/20260606140000_autopilot_guardrails.sql`
- Create: `tests/engine/schema/migrations/20260606140000_autopilot_guardrails.sql`

Identical SQL in both trees. Do NOT apply to prod here — controller applies at the end (Task 8).

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260606140000_autopilot_guardrails.sql`:

```sql
-- Slice 4: auto-pilot. Opt-in toggle (also the kill-switch; default OFF) + the
-- autonomous-action bounds. Existing dollar_impact_cap_without_2fa and
-- cooldown_minutes_per_campaign are reused by the guardrail check.
alter table public.guardrail_config
  add column if not exists autopilot_enabled         boolean not null default false,
  add column if not exists autopilot_daily_action_cap int     not null default 3,
  add column if not exists autopilot_min_spend_cents   int     not null default 20000,
  add column if not exists autopilot_max_budget_cut_pct int    not null default 50;
```

- [ ] **Step 2: Copy identical SQL to the test schema tree**

Create `tests/engine/schema/migrations/20260606140000_autopilot_guardrails.sql` byte-for-byte identical.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260606140000_autopilot_guardrails.sql tests/engine/schema/migrations/20260606140000_autopilot_guardrails.sql
git commit -m "supabase/migrations: autopilot guardrail columns (enabled + caps)"
```

---

## Task 2: Pure guardrail evaluator

**Files:**
- Create: `app/lib/actions/guardrails.ts`
- Test: `app/lib/actions/__tests__/guardrails.test.ts`

`evaluateGuardrails(config, facts)` returns `{ allowed, reason? }`, checking rules in priority order and returning the first failure. Pure — no I/O.

- [ ] **Step 1: Write the failing test**

Create `app/lib/actions/__tests__/guardrails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateGuardrails } from "../guardrails";
import type { AutopilotGuardrails, GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true,
  dailyActionCap: 3,
  minSpendCents: 20000,
  maxBudgetCutPct: 50,
  dollarCapCents: 1000000,
  cooldownMinutes: 30,
  businessHoursOnly: false,
  businessHoursStartUtc: 14,
  businessHoursEndUtc: 0,
};

const facts: GuardrailFacts = {
  kind: "pause_campaign",
  dollarImpactCents: 50000,
  campaignSpendCents: 50000,
  currentBudgetCents: 10000,
  newBudgetCents: undefined,
  todayAutopilotCount: 0,
  minutesSinceLastActionOnCampaign: null,
  nowUtcHour: 16,
};

describe("evaluateGuardrails", () => {
  it("allows a clean pause", () => {
    expect(evaluateGuardrails(cfg, facts)).toEqual({ allowed: true });
  });

  it("blocks when auto-pilot is disabled", () => {
    expect(evaluateGuardrails({ ...cfg, enabled: false }, facts)).toMatchObject({ allowed: false });
  });

  it("blocks when the daily action cap is reached", () => {
    expect(evaluateGuardrails(cfg, { ...facts, todayAutopilotCount: 3 }).allowed).toBe(false);
  });

  it("blocks when campaign spend is below the minimum", () => {
    expect(evaluateGuardrails(cfg, { ...facts, campaignSpendCents: 19999 }).allowed).toBe(false);
  });

  it("blocks when the dollar impact exceeds the cap", () => {
    expect(evaluateGuardrails(cfg, { ...facts, dollarImpactCents: 1000001 }).allowed).toBe(false);
  });

  it("blocks an in-cooldown campaign", () => {
    expect(evaluateGuardrails(cfg, { ...facts, minutesSinceLastActionOnCampaign: 10 }).allowed).toBe(false);
  });

  it("blocks a budget cut deeper than the max", () => {
    // current 10000 -> new 4000 is a 60% cut, cap is 50%
    const r = evaluateGuardrails(cfg, { ...facts, kind: "reduce_campaign_budget", newBudgetCents: 4000 });
    expect(r.allowed).toBe(false);
  });

  it("allows a budget cut within the max", () => {
    // current 10000 -> new 5000 is exactly 50%
    const r = evaluateGuardrails(cfg, { ...facts, kind: "reduce_campaign_budget", newBudgetCents: 5000 });
    expect(r.allowed).toBe(true);
  });

  it("blocks outside business hours when business_hours_only", () => {
    // window 14->0 (wraps midnight). hour 5 is outside.
    const r = evaluateGuardrails({ ...cfg, businessHoursOnly: true }, { ...facts, nowUtcHour: 5 });
    expect(r.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: FAIL — cannot find module `../guardrails`.

- [ ] **Step 3: Write the evaluator**

Create `app/lib/actions/guardrails.ts`:

```ts
// Pure auto-pilot guardrail evaluation. Returns the first failing rule's reason,
// or { allowed: true }. No I/O — the server wrapper supplies the facts.

import type { ExecutableKind } from "./execute.server";

export interface AutopilotGuardrails {
  enabled: boolean;
  dailyActionCap: number;
  minSpendCents: number;
  maxBudgetCutPct: number;
  dollarCapCents: number;
  cooldownMinutes: number;
  businessHoursOnly: boolean;
  businessHoursStartUtc: number; // 0-23
  businessHoursEndUtc: number;   // 0-23 (may wrap past midnight)
}

export interface GuardrailFacts {
  kind: ExecutableKind;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
  todayAutopilotCount: number;
  minutesSinceLastActionOnCampaign: number | null;
  nowUtcHour: number; // 0-23
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
}

function withinBusinessHours(startUtc: number, endUtc: number, hour: number): boolean {
  // Window may wrap midnight (e.g. 14 -> 0 means 14:00..24:00).
  if (startUtc === endUtc) return true;
  if (startUtc < endUtc) return hour >= startUtc && hour < endUtc;
  return hour >= startUtc || hour < endUtc;
}

export function evaluateGuardrails(cfg: AutopilotGuardrails, facts: GuardrailFacts): GuardrailResult {
  if (!cfg.enabled) return { allowed: false, reason: "auto-pilot disabled" };
  if (facts.todayAutopilotCount >= cfg.dailyActionCap) return { allowed: false, reason: "daily action cap reached" };
  if (facts.campaignSpendCents < cfg.minSpendCents) return { allowed: false, reason: "campaign spend below minimum" };
  if (facts.dollarImpactCents > cfg.dollarCapCents) return { allowed: false, reason: "dollar impact exceeds cap" };
  if (facts.minutesSinceLastActionOnCampaign != null && facts.minutesSinceLastActionOnCampaign < cfg.cooldownMinutes) {
    return { allowed: false, reason: "campaign in cooldown" };
  }
  if (
    facts.kind === "reduce_campaign_budget" &&
    facts.currentBudgetCents != null &&
    facts.currentBudgetCents > 0 &&
    facts.newBudgetCents != null
  ) {
    const cutPct = (1 - facts.newBudgetCents / facts.currentBudgetCents) * 100;
    if (cutPct > cfg.maxBudgetCutPct + 1e-9) return { allowed: false, reason: "budget cut exceeds max" };
  }
  if (cfg.businessHoursOnly && !withinBusinessHours(cfg.businessHoursStartUtc, cfg.businessHoursEndUtc, facts.nowUtcHour)) {
    return { allowed: false, reason: "outside business hours" };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/guardrails.ts app/lib/actions/__tests__/guardrails.test.ts
git commit -m "app/lib/actions/guardrails: pure auto-pilot rule evaluator"
```

---

## Task 3: Add `actor` to executeAction

**Files:**
- Modify: `app/lib/actions/execute.server.ts`
- Test: `app/lib/actions/__tests__/execute.test.ts` (extend)

Auto-pilot actions must be attributable. Add an optional `actor` (default `"merchant"`).

- [ ] **Step 1: Write the failing test**

Append to `app/lib/actions/__tests__/execute.test.ts` a case asserting the audit row carries `actor_user_id: "autopilot"` when `actor: "autopilot"` is passed (reuse the file's existing fake + the campaign-present setup; mirror the "pauses via the adapter" test, adding `actor: "autopilot"` to the input and asserting the inserted `action_audit` row's `actor_user_id`).

```ts
it("records the actor on the audit row", async () => {
  const { sb, calls } = fakeSb({ campaign });
  await executeAction(SHOP, { alertId: null, kind: "pause_campaign", campaignId: CAMP, idempotencyKey: "kA", actor: "autopilot" }, sb);
  const audit = calls.inserts.find((i) => i.table === "action_audit");
  expect((audit?.rows as Record<string, unknown>).actor_user_id).toBe("autopilot");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: FAIL — `actor_user_id` is `"merchant"`, not `"autopilot"` (and `actor` is not a valid `ExecuteInput` key).

- [ ] **Step 3: Add the field**

In `app/lib/actions/execute.server.ts`: add `actor?: string;` to the `ExecuteInput` interface, and change the audit insert's `actor_user_id: "merchant"` to `actor_user_id: input.actor ?? "merchant"`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: PASS (all prior + the new one).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/execute.server.ts app/lib/actions/__tests__/execute.test.ts
git commit -m "app/lib/actions/execute: attribute actions to an actor (default merchant)"
```

---

## Task 4: Guardrail server wrapper

**Files:**
- Create: `app/lib/actions/guardrails.server.ts`
- Test: `app/lib/actions/__tests__/guardrails-server.test.ts`

`checkGuardrails(shopId, input, sb)`: load `guardrail_config`, count today's autopilot actions (`action_audit` where `actor_user_id = 'autopilot'` and `created_at >= start-of-day-UTC`), find minutes since the last autopilot action on this campaign, then call `evaluateGuardrails`. `input` carries the per-action facts the runner computed (kind, dollarImpactCents, campaignSpendCents, currentBudgetCents, newBudgetCents, campaignId).

- [ ] **Step 1: Write the failing test**

Create `app/lib/actions/__tests__/guardrails-server.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "../guardrails.server";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

const config = {
  autopilot_enabled: true, autopilot_daily_action_cap: 3, autopilot_min_spend_cents: 20000,
  autopilot_max_budget_cut_pct: 50, dollar_impact_cap_without_2fa: 10000, cooldown_minutes_per_campaign: 30,
  business_hours_only: false, business_hours_start_utc: 14, business_hours_end_utc: 0,
};

function fakeSb(opts: { config?: Record<string, unknown> | null; todayCount?: number; lastActionAtIso?: string | null }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "guardrail_config") return { data: opts.config ?? config, error: null };
      if (table === "action_audit") return { data: opts.lastActionAtIso ? { created_at: opts.lastActionAtIso } : null, error: null };
      return { data: null, error: null };
    });
    // count query: head:true select returns { count }
    chain.then = (resolve: (r: { count: number; data: unknown; error: null }) => unknown) =>
      resolve({ count: opts.todayCount ?? 0, data: [], error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

describe("checkGuardrails", () => {
  beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-06-06T16:00:00Z")));
  afterAll(() => vi.useRealTimers());

  it("allows when config + counts are within bounds", async () => {
    const sb = fakeSb({ todayCount: 0, lastActionAtIso: null });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000,
      campaignSpendCents: 50000, currentBudgetCents: 10000, newBudgetCents: undefined,
    }, sb);
    expect(r.allowed).toBe(true);
  });

  it("blocks when the shop has no guardrail config", async () => {
    const sb = fakeSb({ config: null });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(r.allowed).toBe(false);
  });

  it("passes the today autopilot count into the evaluator (cap)", async () => {
    const sb = fakeSb({ todayCount: 3 });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(r).toMatchObject({ allowed: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: FAIL — cannot find module `../guardrails.server`.

- [ ] **Step 3: Write the wrapper**

Create `app/lib/actions/guardrails.server.ts`:

```ts
// Load a shop's guardrail config + live counts, then evaluate. Translates the DB
// row (dollars, ints) into the pure evaluator's shape.

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailResult } from "./guardrails";
import type { ExecutableKind } from "./execute.server";

export interface CheckInput {
  kind: ExecutableKind;
  campaignId: string;
  dollarImpactCents: number;
  campaignSpendCents: number;
  currentBudgetCents?: number;
  newBudgetCents?: number;
}

function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function checkGuardrails(
  shopId: string,
  input: CheckInput,
  sb: SupabaseClient,
): Promise<GuardrailResult> {
  const { data: row, error } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_daily_action_cap, autopilot_min_spend_cents, autopilot_max_budget_cut_pct, dollar_impact_cap_without_2fa, cooldown_minutes_per_campaign, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { allowed: false, reason: "no guardrail config" };

  const config: AutopilotGuardrails = {
    enabled: Boolean(row.autopilot_enabled),
    dailyActionCap: Number(row.autopilot_daily_action_cap ?? 0),
    minSpendCents: Number(row.autopilot_min_spend_cents ?? 0),
    maxBudgetCutPct: Number(row.autopilot_max_budget_cut_pct ?? 0),
    dollarCapCents: Math.round(Number(row.dollar_impact_cap_without_2fa ?? 0) * 100),
    cooldownMinutes: Number(row.cooldown_minutes_per_campaign ?? 0),
    businessHoursOnly: Boolean(row.business_hours_only),
    businessHoursStartUtc: Number(row.business_hours_start_utc ?? 0),
    businessHoursEndUtc: Number(row.business_hours_end_utc ?? 0),
  };

  // Count today's autopilot actions (UTC day).
  const { count } = await sb
    .from("action_audit")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .gte("created_at", startOfUtcDayIso());

  // Most recent autopilot action on this campaign (for cooldown).
  const { data: last } = await sb
    .from("action_audit")
    .select("created_at")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("params->>campaign_id", input.campaignId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const minutesSince = last?.created_at
    ? (Date.now() - Date.parse(String(last.created_at))) / 60000
    : null;

  return evaluateGuardrails(config, {
    kind: input.kind,
    dollarImpactCents: input.dollarImpactCents,
    campaignSpendCents: input.campaignSpendCents,
    currentBudgetCents: input.currentBudgetCents,
    newBudgetCents: input.newBudgetCents,
    todayAutopilotCount: count ?? 0,
    minutesSinceLastActionOnCampaign: minutesSince,
    nowUtcHour: new Date().getUTCHours(),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/guardrails.server.ts app/lib/actions/__tests__/guardrails-server.test.ts
git commit -m "app/lib/actions/guardrails.server: load config + counts, evaluate"
```

---

## Task 5: Auto-pilot runner

**Files:**
- Create: `app/lib/actions/autopilot.server.ts`
- Test: `app/lib/actions/__tests__/autopilot.test.ts`

`runAutopilotForShop(shopId, sb)`: if `autopilot_enabled` is false → skip. Load open alerts for the money-losing detectors with their campaign + spend facts. For each: derive the action (pause vs reduce-budget), run `checkGuardrails`; on pass call `executeAction(actor:"autopilot")`. Returns a summary `{ acted, blocked, skipped }`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/actions/__tests__/autopilot.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const checkGuardrails = vi.fn();
const executeAction = vi.fn(async () => ({ id: "aud1", outcome: "succeeded" }));
vi.mock("../guardrails.server", () => ({ checkGuardrails }));
vi.mock("../execute.server", () => ({ executeAction }));

import { runAutopilotForShop } from "../autopilot.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

// rows: guardrail_config (enabled), candidate alerts (with campaign + spend).
function fakeSb(opts: { enabled: boolean; alerts: Array<Record<string, unknown>> }) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: { autopilot_enabled: opts.enabled }, error: null }));
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "v_autopilot_candidates" ? opts.alerts : [], error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

const candidate = {
  alert_id: "al1", detector_id: "campaign_below_breakeven", dollar_impact: 80,
  campaign_id: "camp-uuid", campaign_spend_cents: 50000, daily_budget_cents: 10000,
};

describe("runAutopilotForShop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips entirely when auto-pilot is disabled", async () => {
    const sb = fakeSb({ enabled: false, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(r.skipped).toBe(true);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("pauses a money-losing campaign when guardrails allow", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "pause_campaign", campaignId: "camp-uuid", actor: "autopilot", alertId: "al1" }),
      sb,
    );
    expect(r.acted).toBe(1);
  });

  it("does not act when guardrails block", async () => {
    checkGuardrails.mockResolvedValue({ allowed: false, reason: "daily action cap reached" });
    const sb = fakeSb({ enabled: true, alerts: [candidate] });
    const r = await runAutopilotForShop(SHOP, sb);
    expect(executeAction).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });

  it("reduces budget for an ad_tax_overload alert", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const sb = fakeSb({ enabled: true, alerts: [{ ...candidate, detector_id: "ad_tax_overload" }] });
    await runAutopilotForShop(SHOP, sb);
    // 50% default cut of 10000 -> 5000
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "reduce_campaign_budget", dailyBudgetCents: 5000 }),
      sb,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: FAIL — cannot find module `../autopilot.server`.

- [ ] **Step 3: Write the runner**

Create `app/lib/actions/autopilot.server.ts`:

```ts
// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind } from "./execute.server";

const PAUSE_DETECTORS = new Set(["campaign_below_breakeven", "negative_unit_economics"]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const DEFAULT_MAX_CUT_PCT = 50; // mirrors the config default; the guardrail check enforces the live value

export interface AutopilotSummary {
  skipped: boolean;
  acted: number;
  blocked: number;
}

interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number; // dollars
  campaign_id: string;
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
}

export async function runAutopilotForShop(shopId: string, sb: SupabaseClient): Promise<AutopilotSummary> {
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select("autopilot_enabled, autopilot_max_budget_cut_pct")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled) return { skipped: true, acted: 0, blocked: 0 };

  const maxCutPct = Number(cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);

  const { data: rows, error: aErr } = await sb
    .from("v_autopilot_candidates")
    .select("alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents")
    .eq("shop_id", shopId)
    .order("dollar_impact", { ascending: false });
  if (aErr) throw aErr;
  const candidates = (rows ?? []) as Candidate[];

  let acted = 0;
  let blocked = 0;
  for (const c of candidates) {
    let kind: ExecutableKind | null = null;
    if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
    else if (BUDGET_DETECTORS.has(c.detector_id)) kind = "reduce_campaign_budget";
    if (!kind) continue;

    const currentBudgetCents = c.daily_budget_cents ?? null;
    const newBudgetCents =
      kind === "reduce_campaign_budget" && currentBudgetCents != null
        ? Math.round(currentBudgetCents * (1 - maxCutPct / 100))
        : undefined;

    const verdict = await checkGuardrails(
      shopId,
      {
        kind,
        campaignId: c.campaign_id,
        dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
        campaignSpendCents: c.campaign_spend_cents,
        currentBudgetCents: currentBudgetCents ?? undefined,
        newBudgetCents,
      },
      sb,
    );
    if (!verdict.allowed) {
      blocked += 1;
      continue;
    }

    await executeAction(
      shopId,
      {
        alertId: c.alert_id,
        kind,
        campaignId: c.campaign_id,
        idempotencyKey: `autopilot:${c.alert_id}:${kind}`,
        dailyBudgetCents: newBudgetCents,
        actor: "autopilot",
      },
      sb,
    );
    acted += 1;
  }

  return { skipped: false, acted, blocked };
}
```

Note: `idempotencyKey` is deterministic per (alert, kind), so re-running the cron never double-acts on the same alert (Slice 3's idempotency short-circuits).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "app/lib/actions/autopilot: guardrail-bounded auto-action runner"
```

---

## Task 6: `v_autopilot_candidates` view + cron route

**Files:**
- Create: `supabase/migrations/20260606150000_autopilot_candidates_view.sql` + test-tree copy
- Create: `app/routes/cron.autopilot.tsx`
- Modify: `vercel.json`
- Test: `app/routes/__tests__/cron.autopilot.test.ts`

The view joins open money-losing `alerts` → `ad_campaign_dim` (campaign_id, current budget) → trailing 7-day `ad_spend_fact` sum. `security_invoker` (per the repo's view hardening). The cron loops shops with `autopilot_enabled = true`.

- [ ] **Step 1: Write the view migration**

Create `supabase/migrations/20260606150000_autopilot_candidates_view.sql` (and an identical test-tree copy):

```sql
-- Slice 4: candidates auto-pilot may act on — open money-losing alerts joined to
-- their campaign + trailing-7d spend. security_invoker so per-shop RLS applies.
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
  ), 0) as campaign_spend_cents
from public.alerts a
join public.ad_campaign_dim c on c.id = (a.entity_ref->>'campaign_id')::uuid
where a.status = 'open'
  and a.detector_id in ('campaign_below_breakeven', 'negative_unit_economics', 'ad_tax_overload');
```

(If `a.entity_ref` stores the campaign id under a different key, adjust the `->>'campaign_id'` accessor to match what the engine writes — verify against `alert_context`/`entity_ref` in a real row during Step 4.)

- [ ] **Step 2: Write the failing cron test**

Create `app/routes/__tests__/cron.autopilot.test.ts` mirroring `cron.ingest-ads.test.ts`'s `vi.hoisted` + `vi.mock` harness: mock `~/lib/actions/autopilot.server` (`runAutopilotForShop`) and `~/lib/supabase.server` (`getSupabase` returning a fake that lists two enabled shops). Assert: 401 on bad bearer; `runAutopilotForShop` called once per enabled shop; one shop's throw is isolated into `summary.errors` without aborting the other.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.autopilot.test.ts`
Expected: FAIL — cannot find module `../cron.autopilot`.

- [ ] **Step 4: Write the cron**

Create `app/routes/cron.autopilot.tsx`:

```ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { runAutopilotForShop } from "~/lib/actions/autopilot.server";

const CONCURRENCY = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const summary = { acted: 0, blocked: 0, shops: 0, errors: [] as string[] };

  const { data: rows } = await sb
    .from("guardrail_config")
    .select("shop_id")
    .eq("autopilot_enabled", true);
  const shopIds = (rows ?? []).map((r) => String(r.shop_id));

  const settled = await mapWithConcurrency(shopIds, CONCURRENCY, (shopId) => runAutopilotForShop(shopId, sb));
  settled.forEach((r, i) => {
    if (r.ok) {
      summary.shops += 1;
      summary.acted += r.value.acted;
      summary.blocked += r.value.blocked;
    } else {
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${shopIds[i]}: ${message}`);
      console.error(`[cron.autopilot] failed for ${shopIds[i]}`, r.error);
    }
  });
  return json(summary);
};
```

- [ ] **Step 5: Add the cron schedule**

In `vercel.json`, add to `crons`: `{ "path": "/cron/autopilot", "schedule": "0,30 * * * *" }` (every 30 min). Then run the test:

Run: `npx vitest run app/routes/__tests__/cron.autopilot.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260606150000_autopilot_candidates_view.sql tests/engine/schema/migrations/20260606150000_autopilot_candidates_view.sql app/routes/cron.autopilot.tsx app/routes/__tests__/cron.autopilot.test.ts vercel.json
git commit -m "routes/cron.autopilot: candidates view + bounded auto-pilot cron"
```

---

## Task 7: Settings — Auto-pilot toggle + rules

**Files:**
- Modify: `app/lib/types.ts` (extend `GuardrailConfig`)
- Modify: `app/lib/calderyn.server.ts` (`guardrails.get`/`update` map new fields)
- Modify: `app/routes/app.settings.tsx` (`GuardrailsCard` UI)
- Test: extend an existing calderyn/guardrails test if present, else add a focused mapping test

- [ ] **Step 1: Extend the `GuardrailConfig` type**

In `app/lib/types.ts`, add to `GuardrailConfig`:
```ts
  autopilot_enabled: boolean;
  autopilot_daily_action_cap: number;
  autopilot_min_spend_cents: number;
  autopilot_max_budget_cut_pct: number;
```

- [ ] **Step 2: Map in `calderyn.server.ts`**

In `rowToGuardrails`, add (reading the DB columns):
```ts
    autopilot_enabled: Boolean(r.autopilot_enabled),
    autopilot_daily_action_cap: Number(r.autopilot_daily_action_cap ?? 3),
    autopilot_min_spend_cents: Number(r.autopilot_min_spend_cents ?? 20000),
    autopilot_max_budget_cut_pct: Number(r.autopilot_max_budget_cut_pct ?? 50),
```
In `guardrails.update`, extend the patch mapping (these map 1:1 to DB columns, no cents conversion except min_spend which is already cents):
```ts
    if (patch.autopilot_enabled !== undefined) updates.autopilot_enabled = patch.autopilot_enabled;
    if (patch.autopilot_daily_action_cap !== undefined) updates.autopilot_daily_action_cap = patch.autopilot_daily_action_cap;
    if (patch.autopilot_min_spend_cents !== undefined) updates.autopilot_min_spend_cents = patch.autopilot_min_spend_cents;
    if (patch.autopilot_max_budget_cut_pct !== undefined) updates.autopilot_max_budget_cut_pct = patch.autopilot_max_budget_cut_pct;
```
Also extend the `guardrail_config` `.select(...)` if it uses an explicit column list (it uses `*`, so no change needed — verify).

- [ ] **Step 3: UI in `GuardrailsCard`**

Read the existing `GuardrailsCard` (in `app.settings.tsx`) and the `update_guardrails` action handler. Add, following the SAME pattern (useState + hidden input + the existing `update_guardrails` intent):
- A Polaris `Checkbox` labeled **"Auto-pilot — automatically pause clearly money-losing campaigns"** bound to `autopilot_enabled` (hidden input `autopilot_enabled` = "true"/"false").
- Three `TextField type="number"`: **"Max automatic actions per day"** (`autopilot_daily_action_cap`), **"Don't act until a campaign has spent (USD)"** (`autopilot_min_spend_cents`, ×100 on submit / ÷100 on display), **"Max budget cut per action (%)"** (`autopilot_max_budget_cut_pct`).
In the `update_guardrails` action handler, parse those four form fields via the existing `setIfPresent` helper (boolean for the checkbox; ints for the rest; `autopilot_min_spend_cents` = dollars×100). A short helper for the checkbox: `patch.autopilot_enabled = formData.get("autopilot_enabled") === "true"`.
Add a one-line caption under the toggle: **"Off by default. When on, Calderyn can pause or trim losing campaigns within the limits below. Every automatic action is logged and can be undone."**

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run app/lib app/routes`
Expected: tsc 0, lint 0 errors, suites green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/routes/app.settings.tsx
git commit -m "settings: auto-pilot toggle + guardrail rule fields (off by default)"
```

---

## Task 8: Full gate + prod migrations + PR

- [ ] **Step 1: Full eval pipeline** — `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run`. All green.
- [ ] **Step 2: `/code-review`** on the working tree; resolve blockers.
- [ ] **Step 3: Patch sanity** — `git diff --check`; no stray debug.
- [ ] **Step 4: Apply migrations to prod** (controller-confirmed): `20260606140000_autopilot_guardrails.sql` and `20260606150000_autopilot_candidates_view.sql` to `ajgrmnvzxfxxlwrxcgnu` via Supabase MCP `apply_migration`; verify the columns + view exist and `autopilot_enabled` defaults to false on existing rows.
- [ ] **Step 5: Push + PR** — `git push`; add a Slice 4 summary comment.

---

## Self-Review Notes

- **Spec coverage (Slice 4 bullets):** guardrail_config enforcing → Tasks 2+4 (evaluator + server check actually block); guardrail check wrapping the action path → Task 5 calls `checkGuardrails` before `executeAction`; daily action cap → Task 2 rule + Task 4 count; global kill-switch + off-by-default → `autopilot_enabled` default false (Task 1), enforced in Task 5 + the cron's shop filter (Task 6); auto-pilot performs pause/reduce-budget for money-losing alerts → Task 5; cron scanning qualifying alerts → Task 6; Settings UI + toggle → Task 7; every auto-action audited (actor=autopilot) + undoable → Task 3 (`actor`) + Slice 3 undo.
- **Type consistency:** `AutopilotGuardrails`/`GuardrailFacts`/`GuardrailResult` (Task 2) consumed by Task 4; `ExecutableKind` imported from `execute.server` across Tasks 2/4/5; `CheckInput` (Task 4) built by Task 5; `ExecuteInput.actor` (Task 3) passed by Task 5; `AutopilotSummary` (Task 5) consumed by the cron (Task 6); `GuardrailConfig` fields (Task 7) map to the migration columns (Task 1).
- **Idempotency:** the runner's deterministic `idempotencyKey` (`autopilot:<alertId>:<kind>`) means re-running the cron never double-acts on the same alert — Slice 3's `action_idempotency` short-circuits.
- **Safety posture:** off by default; the cron only loads `autopilot_enabled = true` shops; every rule is fail-closed (missing config → blocked); pause is the primary action (fully reversible); budget cuts are bounded by `maxBudgetCutPct`; all actions audited + undoable.
- **Two migrations** in this slice (columns + view); both need prod apply (Task 8) and both trees for CI parity.
