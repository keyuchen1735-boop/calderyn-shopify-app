# Campaign Direction Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On both the embedded admin and the dashboard, a merchant opening a campaign sees the full ad-efficiency metric set plus a single recommended direction (Scale up / Keep / Scale down / Pause) with a plain-English "why" and a one-click button that executes it.

**Architecture:** A pure, fully-tested deterministic recommender (`recommendDirection`) decides the direction from `roas` vs `break-even ROAS` (reusing `grade.py`'s 0.95×/1.2× factors plus a 0.7× pause floor) and active alerts. A thin reasoning layer asks Claude to phrase the already-decided direction in one sentence — Claude never chooses — with a deterministic template fallback, cached in a new `campaign_direction_reason` Postgres table so we call Claude at most once per campaign per day per direction. Both surfaces call one shared orchestrator (`resolveCampaignDirection`) and reuse the existing `executeAction` path for the one-click action.

**Tech Stack:** Remix + TypeScript, Vitest, Supabase/Postgres (raw, service-role), `@anthropic-ai/sdk` via the existing `app/lib/assistant/anthropic.server.ts`, Polaris (embedded) + the `.cd-*` dashboard CSS.

---

## File Structure

**Create:**
- `app/lib/actions/direction.server.ts` — pure recommender: `Direction`, `DirectionInput`, `DirectionResult`, `buildDirectionInput()`, `recommendDirection()`, `suggestBudgetCents()`.
- `app/lib/actions/__tests__/direction.test.ts` — table-driven recommender tests (no mocks).
- `app/lib/actions/direction-reason.server.ts` — `CampaignDirection`, `directionTemplate()` (pure), `directionReason()` (Claude), `resolveCampaignDirection()` (orchestrator + cache).
- `app/lib/actions/__tests__/direction-reason.test.ts` — template + orchestrator tests (mock Anthropic + a fake Supabase).
- `supabase/migrations/20260618120000_campaign_direction_reason.sql` — cache table.
- `app/routes/dashboard.api.campaigns.$id.direction.tsx` — GET endpoint returning the dashboard's `CampaignDirection`.
- `app/routes/__tests__/campaign-direction-routes.test.ts` — embedded action + dashboard endpoint tests.

**Modify:**
- `app/lib/ads/campaign-detail.server.ts` — add `breakEvenRoas` to `CampaignPerformance` and `buildCampaignPerformance()`.
- `app/routes/app.campaigns.$campaignId.tsx` — loader resolves the direction; add a "Recommended direction" `Card`, a Break-even ROAS tile, relabel "Real return"→"Profit ROAS (POAS)"; `action` handles the one-click execute.
- `app/components/dashboard/screens/Campaigns.tsx` — detail view fetches + renders the direction badge/why/button and adds Break-even ROAS + POAS tiles.
- `app/lib/dashboard/client.ts` — add `fetchCampaignDirection(id)`.

---

## Slice 1 — Deterministic recommender

### Task 1: `Direction` types + `recommendDirection`

**Files:**
- Create: `app/lib/actions/direction.server.ts`
- Test: `app/lib/actions/__tests__/direction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/actions/__tests__/direction.test.ts
import { describe, it, expect } from "vitest";
import { recommendDirection, type DirectionInput } from "../direction.server";

const base: DirectionInput = {
  roas: 2,
  breakEvenRoas: 1,
  status: "active",
  hasScalingHeadroom: false,
  pauseAlertActive: false,
};

describe("recommendDirection", () => {
  it("recommends pause when roas is far below break-even (< 0.7x)", () => {
    const r = recommendDirection({ ...base, roas: 0.6, breakEvenRoas: 1 });
    expect(r.direction).toBe("pause");
    expect(r.actionKind).toBe("pause_campaign");
    expect(r.dataSufficient).toBe(true);
  });

  it("recommends pause when a pause-detector alert is active, even if roas is healthy", () => {
    const r = recommendDirection({ ...base, roas: 2, breakEvenRoas: 1, pauseAlertActive: true });
    expect(r.direction).toBe("pause");
  });

  it("recommends scale_down when roas is between 0.7x and 0.95x break-even", () => {
    const r = recommendDirection({ ...base, roas: 0.8, breakEvenRoas: 1 });
    expect(r.direction).toBe("scale_down");
    expect(r.actionKind).toBe("reduce_campaign_budget");
  });

  it("recommends keep when roas is around break-even (0.95x to 1.2x)", () => {
    const r = recommendDirection({ ...base, roas: 1.0, breakEvenRoas: 1 });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("recommends scale_up when winning (>= 1.2x) AND has scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: true });
    expect(r.direction).toBe("scale_up");
    expect(r.actionKind).toBe("increase_campaign_budget");
  });

  it("recommends keep when winning but no scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: false });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("keeps (paused) without an action when the campaign is paused", () => {
    const r = recommendDirection({ ...base, roas: 0.5, breakEvenRoas: 1, status: "paused" });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
    expect(r.dataSufficient).toBe(true);
  });

  it("keeps with dataSufficient=false when roas or break-even is null/non-positive", () => {
    expect(recommendDirection({ ...base, roas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: 0 }).dataSufficient).toBe(false);
    const r = recommendDirection({ ...base, roas: null });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("uses the exact grade boundaries: 1.2x is scale-eligible, 0.95x is keep, 0.7x is scale_down", () => {
    expect(recommendDirection({ ...base, roas: 1.2, breakEvenRoas: 1, hasScalingHeadroom: true }).direction).toBe("scale_up");
    expect(recommendDirection({ ...base, roas: 0.95, breakEvenRoas: 1 }).direction).toBe("keep");
    expect(recommendDirection({ ...base, roas: 0.7, breakEvenRoas: 1 }).direction).toBe("scale_down");
    expect(recommendDirection({ ...base, roas: 0.69, breakEvenRoas: 1 }).direction).toBe("pause");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/direction.test.ts`
Expected: FAIL — cannot find module `../direction.server`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/actions/direction.server.ts
// Deterministic 4-way campaign direction. Pure: no I/O, no model. The thresholds
// mirror engine/calderyn_engine/grade.py (GRADE_OK_FACTOR 0.95, GRADE_WIN_FACTOR 1.2)
// so a recommendation never contradicts the displayed grade; PAUSE_FLOOR (0.7) is the
// one new tunable — below it a campaign is bleeding hard enough to pause outright.

export type Direction = "scale_up" | "keep" | "scale_down" | "pause";
export type DirectionActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget";

const GRADE_OK_FACTOR = 0.95;
const GRADE_WIN_FACTOR = 1.2;
const PAUSE_FLOOR = 0.7;

export interface DirectionInput {
  roas: number | null;
  breakEvenRoas: number | null;
  status: "active" | "paused";
  /** Open campaign_scaling_opportunity alert for this campaign. */
  hasScalingHeadroom: boolean;
  /** Open campaign_below_breakeven / negative_unit_economics alert for this campaign. */
  pauseAlertActive: boolean;
}

export interface DirectionResult {
  direction: Direction;
  actionKind: DirectionActionKind | null;
  dataSufficient: boolean;
}

const KEEP: DirectionResult = { direction: "keep", actionKind: null, dataSufficient: true };

export function recommendDirection(input: DirectionInput): DirectionResult {
  const { roas, breakEvenRoas } = input;
  // Fail visibly (rule 12): no fabricated direction without real numbers.
  if (roas == null || breakEvenRoas == null || breakEvenRoas <= 0 || !Number.isFinite(roas)) {
    return { ...KEEP, dataSufficient: false };
  }
  if (input.status === "paused") return KEEP;

  if (input.pauseAlertActive || roas < PAUSE_FLOOR * breakEvenRoas) {
    return { direction: "pause", actionKind: "pause_campaign", dataSufficient: true };
  }
  if (roas < GRADE_OK_FACTOR * breakEvenRoas) {
    return { direction: "scale_down", actionKind: "reduce_campaign_budget", dataSufficient: true };
  }
  if (roas < GRADE_WIN_FACTOR * breakEvenRoas) {
    return KEEP;
  }
  // Winning.
  if (input.hasScalingHeadroom) {
    return { direction: "scale_up", actionKind: "increase_campaign_budget", dataSufficient: true };
  }
  return KEEP;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/direction.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/direction.server.ts app/lib/actions/__tests__/direction.test.ts
git commit -m "feat(direction): deterministic 4-way campaign direction recommender"
```

### Task 2: `buildDirectionInput` + `suggestBudgetCents`

**Files:**
- Modify: `app/lib/actions/direction.server.ts`
- Test: `app/lib/actions/__tests__/direction.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```ts
import { buildDirectionInput, suggestBudgetCents } from "../direction.server";
import type { Alert } from "~/lib/types";

const alert = (over: Partial<Alert>): Alert => ({
  id: "a1", detector_id: "campaign_below_breakeven", severity: "high", status: "open",
  dollar_impact: 100, claude_rank: 1, created_at: "", title: "", narrative: "",
  campaign: null, campaign_id: "cmp-1", campaign_external_id: null, sku: null, evidence: {},
  ...over,
});

describe("buildDirectionInput", () => {
  it("flags pauseAlertActive for an open below-breakeven alert on this campaign", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [alert({ detector_id: "campaign_below_breakeven", status: "open", campaign_id: "cmp-1" })],
    });
    expect(inp.pauseAlertActive).toBe(true);
    expect(inp.hasScalingHeadroom).toBe(false);
  });

  it("flags hasScalingHeadroom for an open scaling-opportunity alert on this campaign", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [alert({ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" })],
    });
    expect(inp.hasScalingHeadroom).toBe(true);
    expect(inp.pauseAlertActive).toBe(false);
  });

  it("ignores alerts for other campaigns and non-open alerts", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [
        alert({ detector_id: "campaign_below_breakeven", status: "open", campaign_id: "OTHER" }),
        alert({ detector_id: "campaign_scaling_opportunity", status: "acknowledged", campaign_id: "cmp-1" }),
      ],
    });
    expect(inp.pauseAlertActive).toBe(false);
    expect(inp.hasScalingHeadroom).toBe(false);
  });
});

describe("suggestBudgetCents", () => {
  const gr = { autopilot_max_budget_increase_pct: 20, autopilot_max_budget_cut_pct: 50, autopilot_max_daily_budget_cents: null };
  it("scales up by the increase pct", () => {
    expect(suggestBudgetCents("scale_up", 10000, gr)).toBe(12000);
  });
  it("caps a scale-up at the daily ceiling when set", () => {
    expect(suggestBudgetCents("scale_up", 10000, { ...gr, autopilot_max_daily_budget_cents: 11000 })).toBe(11000);
  });
  it("returns null for scale_up that cannot exceed the current budget", () => {
    expect(suggestBudgetCents("scale_up", 10000, { ...gr, autopilot_max_daily_budget_cents: 10000 })).toBeNull();
  });
  it("scales down by the cut pct", () => {
    expect(suggestBudgetCents("scale_down", 10000, gr)).toBe(5000);
  });
  it("returns null when there is no current budget, or for keep/pause", () => {
    expect(suggestBudgetCents("scale_up", null, gr)).toBeNull();
    expect(suggestBudgetCents("keep", 10000, gr)).toBeNull();
    expect(suggestBudgetCents("pause", 10000, gr)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/direction.test.ts`
Expected: FAIL — `buildDirectionInput`/`suggestBudgetCents` not exported.

- [ ] **Step 3: Write minimal implementation (append to `direction.server.ts`)**

```ts
import type { Alert } from "~/lib/types";

const PAUSE_DETECTORS = new Set(["campaign_below_breakeven", "negative_unit_economics"]);
const SCALE_DETECTOR = "campaign_scaling_opportunity";
const DEFAULT_MAX_INCREASE_PCT = 20;
const DEFAULT_MAX_CUT_PCT = 50;

export function buildDirectionInput(args: {
  campaignId: string;
  roas: number | null;
  breakEvenRoas: number | null;
  status: "active" | "paused";
  alerts: Pick<Alert, "detector_id" | "status" | "campaign_id">[];
}): DirectionInput {
  const open = args.alerts.filter((a) => a.status === "open" && a.campaign_id === args.campaignId);
  return {
    roas: args.roas,
    breakEvenRoas: args.breakEvenRoas,
    status: args.status,
    hasScalingHeadroom: open.some((a) => a.detector_id === SCALE_DETECTOR),
    pauseAlertActive: open.some((a) => PAUSE_DETECTORS.has(a.detector_id)),
  };
}

export function suggestBudgetCents(
  direction: Direction,
  currentBudgetCents: number | null,
  guardrails: {
    autopilot_max_budget_increase_pct?: number | null;
    autopilot_max_budget_cut_pct?: number | null;
    autopilot_max_daily_budget_cents?: number | null;
  },
): number | null {
  if (!currentBudgetCents || currentBudgetCents <= 0) return null;
  if (direction === "scale_up") {
    const pct = Number(guardrails.autopilot_max_budget_increase_pct ?? DEFAULT_MAX_INCREASE_PCT);
    let target = Math.round(currentBudgetCents * (1 + pct / 100));
    if (guardrails.autopilot_max_daily_budget_cents != null) {
      target = Math.min(target, Number(guardrails.autopilot_max_daily_budget_cents));
    }
    return target > currentBudgetCents ? target : null;
  }
  if (direction === "scale_down") {
    const pct = Number(guardrails.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);
    const target = Math.round(currentBudgetCents * (1 - pct / 100));
    return target > 0 ? target : null;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/direction.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/direction.server.ts app/lib/actions/__tests__/direction.test.ts
git commit -m "feat(direction): alert→input mapping and one-click budget targets"
```

---

## Slice 2 — Reasoning (Claude phrasing + template fallback + cache)

### Task 3: Cache table migration

**Files:**
- Create: `supabase/migrations/20260618120000_campaign_direction_reason.sql`

- [ ] **Step 1: Write the migration**

```sql
-- campaign_direction_reason: caches the ONE plain-English sentence shown for a
-- campaign's recommended direction, so Claude is called at most once per campaign
-- per day per direction. `as_of_date` is the UTC date the reason was generated;
-- when the direction flips intraday the (…, direction) key changes and we re-phrase.
-- `source` = 'claude' | 'template' (the deterministic fallback). Shop-scoped in
-- code (service-role); deny-by-default RLS like every other table.

create table campaign_direction_reason (
  shop_id     uuid        not null references shops(id) on delete cascade,
  campaign_id text        not null,
  as_of_date  date        not null,
  direction   text        not null
                check (direction in ('scale_up','scale_down','keep','pause')),
  reason      text        not null,
  source      text        not null check (source in ('claude','template')),
  model       text,
  created_at  timestamptz not null default now(),
  primary key (shop_id, campaign_id, as_of_date, direction)
);

alter table campaign_direction_reason enable row level security;
```

- [ ] **Step 2: Verify the migration is well-formed**

Run: `cd /Users/ericchen/Developer/calderyn-campaign-direction && npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script >/dev/null 2>&1; echo "prisma unaffected (supabase migration)"; grep -c "create table campaign_direction_reason" supabase/migrations/20260618120000_campaign_direction_reason.sql`
Expected: prints `1` (table declared once). (This repo's Postgres is Supabase-managed; the migration is applied via the Supabase MCP/CLI at deploy, not Prisma.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618120000_campaign_direction_reason.sql
git commit -m "feat(direction): campaign_direction_reason cache table"
```

### Task 4: `directionTemplate` (deterministic fallback copy)

**Files:**
- Create: `app/lib/actions/direction-reason.server.ts`
- Test: `app/lib/actions/__tests__/direction-reason.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/actions/__tests__/direction-reason.test.ts
import { describe, it, expect } from "vitest";
import { directionTemplate, type ReasonFacts } from "../direction-reason.server";

const facts: ReasonFacts = { roas: 1.5, breakEvenRoas: 1, dataSufficient: true, status: "active" };

describe("directionTemplate", () => {
  it("explains scale_up in plain English referencing the return and break-even", () => {
    const t = directionTemplate("scale_up", facts);
    expect(t).toMatch(/winning|earning/i);
    expect(t).toContain("1.5×");
    expect(t).not.toMatch(/ROAS/); // no jargon (matches scale-reason.ts house style)
  });
  it("explains pause as losing money", () => {
    expect(directionTemplate("pause", { ...facts, roas: 0.5 })).toMatch(/losing|pause/i);
  });
  it("explains scale_down as trimming an underperformer", () => {
    expect(directionTemplate("scale_down", { ...facts, roas: 0.8 })).toMatch(/below|trim|underperform/i);
  });
  it("explains keep for an at-break-even campaign", () => {
    expect(directionTemplate("keep", { ...facts, roas: 1.0 })).toMatch(/hold|steady|break/i);
  });
  it("says paused when the campaign is paused", () => {
    expect(directionTemplate("keep", { ...facts, status: "paused" })).toMatch(/paused/i);
  });
  it("says not enough data when dataSufficient is false", () => {
    expect(directionTemplate("keep", { ...facts, dataSufficient: false })).toMatch(/not enough|yet/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/direction-reason.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/actions/direction-reason.server.ts
// Plain-English "why" for a campaign's recommended direction. The direction is
// ALREADY decided by recommendDirection — this layer only phrases it. Claude does
// the phrasing when available (directionReason); directionTemplate is the
// deterministic fallback, in the no-jargon house style of scale-reason.ts.

import type { Direction } from "./direction.server";

export interface ReasonFacts {
  roas: number | null;
  breakEvenRoas: number | null;
  dataSufficient: boolean;
  status: "active" | "paused";
}

function x(n: number | null): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(1)}×` : "—";
}

export function directionTemplate(direction: Direction, f: ReasonFacts): string {
  if (!f.dataSufficient) return "Not enough recent spend or margin data to make a call yet.";
  if (f.status === "paused") return "This campaign is paused — no change recommended right now.";
  const ret = x(f.roas);
  const be = x(f.breakEvenRoas);
  switch (direction) {
    case "scale_up":
      return `Winning campaign — earning ${ret} on ad spend, above the ${be} it needs to break even. Give the winner more budget.`;
    case "scale_down":
      return `Underperforming — ${ret} on ad spend is below the ${be} it needs to break even. Trim the budget to cut the bleed.`;
    case "pause":
      return `Losing money — ${ret} is well under the ${be} break-even. Pause it before it spends more.`;
    case "keep":
    default:
      return `Holding steady — ${ret} on ad spend is around the ${be} break-even. Keep the budget and keep watching.`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/direction-reason.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/direction-reason.server.ts app/lib/actions/__tests__/direction-reason.test.ts
git commit -m "feat(direction): deterministic plain-English reason templates"
```

### Task 5: `resolveCampaignDirection` — Claude phrasing, fallback, cache, direction-immutability

**Files:**
- Modify: `app/lib/actions/direction-reason.server.ts`
- Test: `app/lib/actions/__tests__/direction-reason.test.ts`

- [ ] **Step 1: Write the failing test (append). Mock Anthropic like `app/routes/__tests__/assistant-action.test.ts`; hand-roll a tiny Supabase fake.**

```ts
import { vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: vi.fn(),
  assistantModel: () => "claude-test",
}));
import { getAnthropic } from "~/lib/assistant/anthropic.server";
import { resolveCampaignDirection } from "../direction-reason.server";

// Minimal chainable Supabase double: supports .from().select().eq()*.maybeSingle()
// and .from().upsert(); records upserts and counts reads.
function fakeSb(cachedRow: Record<string, unknown> | null) {
  const calls = { upserts: [] as Record<string, unknown>[], reads: 0 };
  const sb = {
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          calls.reads += 1;
          return { data: cachedRow, error: null };
        },
        upsert: (row: Record<string, unknown>) => {
          calls.upserts.push(row);
          return { error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const baseArgs = {
  shopId: "shop-1",
  campaignId: "cmp-1",
  roas: 1.5,
  breakEvenRoas: 1,
  contributionMargin: 0.4,
  status: "active" as const,
  currentBudgetCents: 10000,
  alerts: [],
  guardrails: { autopilot_max_budget_increase_pct: 20, autopilot_max_budget_cut_pct: 50, autopilot_max_daily_budget_cents: null },
  now: new Date("2026-06-18T12:00:00Z"),
};

function mockClaude(text: string) {
  (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) },
  });
}
function mockClaudeThrows() {
  (getAnthropic as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: { create: vi.fn().mockRejectedValue(new Error("boom")) },
  });
}

describe("resolveCampaignDirection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the Claude sentence and caches it on a cache miss", async () => {
    mockClaude("This winner has room to grow.");
    const { sb, calls } = fakeSb(null);
    // winning + scaling alert -> scale_up
    const r = await resolveCampaignDirection({
      ...baseArgs,
      alerts: [{ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" }],
      sb,
    });
    expect(r.direction).toBe("scale_up");
    expect(r.reason).toBe("This winner has room to grow.");
    expect(r.reasonSource).toBe("claude");
    expect(r.suggestedBudgetCents).toBe(12000);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]).toMatchObject({ direction: "scale_up", source: "claude", as_of_date: "2026-06-18" });
  });

  it("falls back to the template (source=template) when Claude throws", async () => {
    mockClaudeThrows();
    const { sb } = fakeSb(null);
    const r = await resolveCampaignDirection({ ...baseArgs, sb });
    expect(r.reasonSource).toBe("template");
    expect(r.reason).toMatch(/break even|steady|winning/i);
  });

  it("reuses the cached reason and does NOT call Claude on a hit", async () => {
    mockClaude("SHOULD NOT BE USED");
    const { sb } = fakeSb({ reason: "Cached sentence.", source: "claude" });
    const create = (getAnthropic as any)().messages.create;
    const r = await resolveCampaignDirection({ ...baseArgs, sb });
    expect(r.reason).toBe("Cached sentence.");
    expect(create).not.toHaveBeenCalled();
  });

  it("NEVER lets Claude change the decided direction (even if the sentence says otherwise)", async () => {
    mockClaude("You should pause this immediately.");
    const { sb } = fakeSb(null);
    // roas 1.5 vs BE 1, scaling alert -> deterministic scale_up
    const r = await resolveCampaignDirection({
      ...baseArgs,
      alerts: [{ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" }],
      sb,
    });
    expect(r.direction).toBe("scale_up");
    expect(r.actionKind).toBe("increase_campaign_budget");
  });

  it("returns keep + dataSufficient false + no action when metrics are missing", async () => {
    mockClaude("n/a");
    const { sb } = fakeSb(null);
    const r = await resolveCampaignDirection({ ...baseArgs, roas: null, sb });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
    expect(r.dataSufficient).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/direction-reason.test.ts`
Expected: FAIL — `resolveCampaignDirection` not exported.

- [ ] **Step 3: Write minimal implementation (append to `direction-reason.server.ts`)**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import {
  recommendDirection,
  buildDirectionInput,
  suggestBudgetCents,
  type Direction,
  type DirectionActionKind,
} from "./direction.server";
import type { Alert } from "~/lib/types";

export interface CampaignDirection {
  direction: Direction;
  actionKind: DirectionActionKind | null;
  suggestedBudgetCents: number | null;
  reason: string;
  reasonSource: "claude" | "template";
  dataSufficient: boolean;
}

const DIRECTION_VERB: Record<Direction, string> = {
  scale_up: "scale this campaign up (raise its budget)",
  scale_down: "scale this campaign down (cut its budget)",
  keep: "keep this campaign as-is",
  pause: "pause this campaign",
};

/** ONE sentence from Claude explaining an already-decided direction. Claude is
 *  told the decision as a fact; it never chooses. Throws on any API error so the
 *  caller falls back to the template. */
async function directionReason(direction: Direction, f: ReasonFacts): Promise<string> {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: assistantModel(),
    max_tokens: 120,
    system:
      "You explain an already-decided ad-campaign budget decision to a Shopify merchant in ONE short, plain-English sentence (≤30 words). " +
      "The decision is final — never question, hedge, or contradict it. No jargon (say 'earning 1.5× on ad spend', never 'ROAS'). Invent no numbers beyond those given.",
    messages: [
      {
        role: "user",
        content:
          `Decision: ${DIRECTION_VERB[direction]}.\n` +
          `Return on ad spend: ${f.roas != null ? f.roas.toFixed(2) + "×" : "unknown"}. ` +
          `Break-even return: ${f.breakEvenRoas != null ? f.breakEvenRoas.toFixed(2) + "×" : "unknown"}. ` +
          `Write the one sentence.`,
      },
    ],
  });
  const block = Array.isArray(msg.content) ? msg.content.find((b: { type: string }) => b.type === "text") : null;
  const text = block && "text" in block ? String((block as { text: string }).text).trim() : "";
  if (!text) throw new Error("empty Claude response");
  return text;
}

export async function resolveCampaignDirection(args: {
  shopId: string;
  campaignId: string;
  roas: number | null;
  breakEvenRoas: number | null;
  contributionMargin: number | null;
  status: "active" | "paused";
  currentBudgetCents: number | null;
  alerts: Pick<Alert, "detector_id" | "status" | "campaign_id">[];
  guardrails: {
    autopilot_max_budget_increase_pct?: number | null;
    autopilot_max_budget_cut_pct?: number | null;
    autopilot_max_daily_budget_cents?: number | null;
  };
  sb: SupabaseClient;
  now?: Date;
}): Promise<CampaignDirection> {
  const input = buildDirectionInput({
    campaignId: args.campaignId,
    roas: args.roas,
    breakEvenRoas: args.breakEvenRoas,
    status: args.status,
    alerts: args.alerts,
  });
  const result = recommendDirection(input);
  const suggestedBudgetCents = suggestBudgetCents(result.direction, args.currentBudgetCents, args.guardrails);
  const facts: ReasonFacts = {
    roas: args.roas,
    breakEvenRoas: args.breakEvenRoas,
    dataSufficient: result.dataSufficient,
    status: args.status,
  };

  const asOf = (args.now ?? new Date()).toISOString().slice(0, 10);

  // Cache read.
  const { data: cached } = await args.sb
    .from("campaign_direction_reason")
    .select("reason, source")
    .eq("shop_id", args.shopId)
    .eq("campaign_id", args.campaignId)
    .eq("as_of_date", asOf)
    .eq("direction", result.direction)
    .maybeSingle();
  if (cached?.reason) {
    return {
      direction: result.direction,
      actionKind: result.actionKind,
      suggestedBudgetCents,
      reason: String(cached.reason),
      reasonSource: cached.source === "claude" ? "claude" : "template",
      dataSufficient: result.dataSufficient,
    };
  }

  // Generate: Claude, else template.
  let reason: string;
  let reasonSource: "claude" | "template";
  try {
    reason = await directionReason(result.direction, facts);
    reasonSource = "claude";
  } catch (err) {
    console.error(`[direction] Claude phrasing failed for ${args.campaignId}; using template`, err);
    reason = directionTemplate(result.direction, facts);
    reasonSource = "template";
  }

  // Cache write (best-effort; a write failure must not fail the page — rule 12 logs it).
  const { error: upErr } = await args.sb.from("campaign_direction_reason").upsert({
    shop_id: args.shopId,
    campaign_id: args.campaignId,
    as_of_date: asOf,
    direction: result.direction,
    reason,
    source: reasonSource,
    model: reasonSource === "claude" ? assistantModel() : null,
  });
  if (upErr) console.error(`[direction] reason cache upsert failed for ${args.campaignId}`, upErr);

  return {
    direction: result.direction,
    actionKind: result.actionKind,
    suggestedBudgetCents,
    reason,
    reasonSource,
    dataSufficient: result.dataSufficient,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/direction-reason.test.ts`
Expected: PASS (template + orchestrator tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/lib/actions/direction-reason.server.ts app/lib/actions/__tests__/direction-reason.test.ts
git commit -m "feat(direction): Claude-phrased reason with template fallback + day/direction cache"
```

---

## Slice 3 — Embedded admin detail (Polaris)

### Task 6: Add `breakEvenRoas` to `CampaignPerformance`

**Files:**
- Modify: `app/lib/ads/campaign-detail.server.ts`
- Test: `app/lib/ads/__tests__/campaign-detail.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/ads/__tests__/campaign-detail.test.ts
import { describe, it, expect } from "vitest";
import { buildCampaignPerformance } from "../campaign-detail.server";
import type { Campaign } from "~/lib/types";

const campaign = (over: Partial<Campaign>): Campaign => ({
  id: "c", name: "C", platform: "Meta", status: "active",
  daily_budget_cents: 5000, roas_7d: 2, contribution_margin: 0.4, spend_7d: 10000, ...over,
});

describe("buildCampaignPerformance breakEvenRoas", () => {
  it("derives break-even ROAS as 1/margin when margin is positive", () => {
    expect(buildCampaignPerformance(campaign({ contribution_margin: 0.4 })).breakEvenRoas).toBeCloseTo(2.5, 5);
  });
  it("is null when margin is missing", () => {
    expect(buildCampaignPerformance(campaign({ roas_7d: 2, contribution_margin: 0 })).breakEvenRoas).toBeNull();
  });
  it("is null when there is no campaign", () => {
    expect(buildCampaignPerformance(null).breakEvenRoas).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/campaign-detail.test.ts`
Expected: FAIL — `breakEvenRoas` missing.

- [ ] **Step 3: Implement — add the field to the interface and both return paths**

In `app/lib/ads/campaign-detail.server.ts`, add to the `CampaignPerformance` interface (after `realRoas`):

```ts
  /** ROAS a campaign must clear to break even (1 / margin); null without a positive margin. */
  breakEvenRoas: number | null;
```

In the early-return object (the `!campaign || !hasRoas` branch) add `breakEvenRoas: null,`. In the final return object add:

```ts
    breakEvenRoas: hasMargin ? 1 / campaign.contribution_margin : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/campaign-detail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/campaign-detail.server.ts app/lib/ads/__tests__/campaign-detail.test.ts
git commit -m "feat(direction): expose break-even ROAS on CampaignPerformance"
```

### Task 7: Embedded loader resolves the direction

**Files:**
- Modify: `app/routes/app.campaigns.$campaignId.tsx` (loader + `LoaderPayload`)
- Test: `app/routes/__tests__/campaign-direction-routes.test.ts`

**Read first:** the loader (≈ lines 93–185) and `LoaderPayload` type (≈ lines 40–70). Reuse the already-resolved campaign object, `authenticate.admin`, and the `calderynClient(session.shop)` client (`.alerts.list`, `.guardrails.get`).

- [ ] **Step 1: Write the failing test** (mock `resolveCampaignDirection` and assert the loader returns it)

```ts
// app/routes/__tests__/campaign-direction-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/actions/direction-reason.server", () => ({
  resolveCampaignDirection: vi.fn().mockResolvedValue({
    direction: "scale_up", actionKind: "increase_campaign_budget",
    suggestedBudgetCents: 12000, reason: "Winner with room.", reasonSource: "claude", dataSufficient: true,
  }),
}));
// (Repeat the route's existing authenticate/client mocks here — copy them from the
//  sibling test that already exercises this route's loader, e.g. the campaigns
//  detail loader test, so auth + calderynClient resolve in-test.)

import { resolveCampaignDirection } from "~/lib/actions/direction-reason.server";

describe("embedded campaign detail loader — direction", () => {
  beforeEach(() => vi.clearAllMocks());
  it("includes the resolved direction in the loader payload", async () => {
    const { loader } = await import("~/routes/app.campaigns.$campaignId");
    const res = await loader({
      request: new Request("https://x/app/campaigns/cmp-1?platform=Meta"),
      params: { campaignId: "cmp-1" }, context: {},
    } as never);
    const data = await (res as Response).json();
    expect(resolveCampaignDirection).toHaveBeenCalled();
    expect(data.direction).toMatchObject({ direction: "scale_up", suggestedBudgetCents: 12000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/campaign-direction-routes.test.ts`
Expected: FAIL — `data.direction` undefined.

- [ ] **Step 3: Implement — in the loader, after the campaign + performance are resolved**

Add to `LoaderPayload`: `direction: CampaignDirection | null;` (import the type). After resolving `detail`/`perf`, when there is a dim-resolved campaign with metrics:

```ts
import { resolveCampaignDirection } from "~/lib/actions/direction-reason.server";
import type { CampaignDirection } from "~/lib/actions/direction-reason.server";
import { getSupabase } from "~/lib/supabase.server";
// ... inside loader, after `perf` is built and `detail` is known:
let direction: CampaignDirection | null = null;
if (detail && detail.id) {
  const [openAlerts, guardrails] = await Promise.all([
    client.alerts.list({ status: "open" }).catch(() => []),
    client.guardrails.get().catch(() => null),
  ]);
  direction = await resolveCampaignDirection({
    shopId, // already resolved earlier in the loader
    campaignId: detail.id, // ad_campaign_dim uuid (executeAction key)
    roas: perf.reportedRoas,
    breakEvenRoas: perf.breakEvenRoas,
    contributionMargin: perf.contributionMargin,
    status: detail.status,
    currentBudgetCents: perf.dailyBudgetCents,
    alerts: openAlerts.map((a) => ({ detector_id: a.detector_id, status: a.status, campaign_id: a.campaign_id })),
    guardrails: guardrails ?? {},
    sb: getSupabase(),
  }).catch((err) => {
    console.error("[campaign-detail] direction resolve failed", err);
    return null;
  });
}
// add `direction` to the json(...) payload
```

> If the loader doesn't already expose `shopId`, derive it the same way the rest of the loader resolves the shop (the campaign resolution already loads the shop row — reuse that id). Do not re-authenticate.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/campaign-direction-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/routes/app.campaigns.\$campaignId.tsx app/routes/__tests__/campaign-direction-routes.test.ts
git commit -m "feat(direction): embedded detail loader resolves campaign direction"
```

### Task 8: Embedded UI — direction Card, metric tiles, one-click action

**Files:**
- Modify: `app/routes/app.campaigns.$campaignId.tsx` (JSX + `action`)

**Read first:** the metric `InlineGrid` (≈ lines 435–463) and the existing `action` (if any) / how the route imports Polaris `Card`, `Badge`, `Button`, `BlockStack`, `Text`.

- [ ] **Step 1: Add the Break-even tile + relabel, in the existing `InlineGrid`**

Add a tile mirroring the existing ones:

```tsx
<BlockStack gap="100">
  <Text as="p" variant="bodySm" tone="subdued">Break-even ROAS</Text>
  <Text as="p" variant="headingMd">
    {perf.breakEvenRoas != null ? `${perf.breakEvenRoas.toFixed(1)}×` : "—"}
  </Text>
</BlockStack>
```

Relabel the existing "Real return" tile to **"Profit ROAS (POAS)"** (the value stays `perf.realRoas`). Bump the `InlineGrid` `columns` if needed (e.g. `{ xs: 2, sm: 3, md: 5 }`).

- [ ] **Step 2: Add the "Recommended direction" Card** (place above the metric scorecard `Card`)

```tsx
const DIRECTION_BADGE: Record<string, { label: string; tone: "success" | "attention" | "critical" | undefined }> = {
  scale_up: { label: "Scale up", tone: "success" },
  keep: { label: "Keep", tone: undefined },
  scale_down: { label: "Scale down", tone: "attention" },
  pause: { label: "Pause", tone: "critical" },
};
// ...
{data.direction && (
  <Card>
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h2" variant="headingMd">Recommended direction</Text>
        <Badge tone={DIRECTION_BADGE[data.direction.direction].tone}>
          {DIRECTION_BADGE[data.direction.direction].label}
        </Badge>
      </InlineStack>
      <Text as="p" variant="bodyMd">{data.direction.reason}</Text>
      {data.direction.actionKind && (
        <directionFetcher.Form method="post">
          <input type="hidden" name="intent" value="apply_direction" />
          <input type="hidden" name="action_kind" value={data.direction.actionKind} />
          {data.direction.suggestedBudgetCents != null && (
            <input type="hidden" name="daily_budget_cents" value={String(data.direction.suggestedBudgetCents)} />
          )}
          <Button variant="primary" submit loading={directionFetcher.state !== "idle"}>
            {DIRECTION_BADGE[data.direction.direction].label}
          </Button>
        </directionFetcher.Form>
      )}
    </BlockStack>
  </Card>
)}
```

Add near the other hooks: `const directionFetcher = useFetcher();` (import `useFetcher`, `InlineStack`, `Badge`, `Button` from `@shopify/polaris` / `@remix-run/react` as the file already does).

- [ ] **Step 3: Add the `action` branch** (extend the existing `action`, or add one)

```ts
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
// inside action(), after authenticate.admin + parsing intent:
if (intent === "apply_direction") {
  const kind = String(form.get("action_kind")) as ExecutableKind;
  const dailyRaw = form.get("daily_budget_cents");
  const dailyBudgetCents = dailyRaw != null ? Number(dailyRaw) : undefined;
  const res = await executeAction(
    shopId,
    {
      alertId: null,
      kind,
      campaignId: params.campaignId!, // dim uuid (same id the loader used)
      idempotencyKey: `direction:${params.campaignId}:${kind}:${new Date().toISOString().slice(0, 10)}`,
      dailyBudgetCents,
      actor: "merchant:admin-detail",
    },
    getSupabase(),
  );
  return json({ ok: res.outcome !== "failed", outcome: res.outcome });
}
```

- [ ] **Step 4: Test the action path** (append to `campaign-direction-routes.test.ts`)

```ts
vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: vi.fn().mockResolvedValue({ id: "aud-1", outcome: "succeeded" }),
}));
import { executeAction } from "~/lib/actions/execute.server";

it("apply_direction executes the recommended kind with the suggested budget", async () => {
  const { action } = await import("~/routes/app.campaigns.$campaignId");
  const body = new URLSearchParams({ intent: "apply_direction", action_kind: "increase_campaign_budget", daily_budget_cents: "12000" });
  await action({
    request: new Request("https://x/app/campaigns/cmp-1", { method: "POST", body }),
    params: { campaignId: "cmp-1" }, context: {},
  } as never);
  expect(executeAction).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ kind: "increase_campaign_budget", campaignId: "cmp-1", dailyBudgetCents: 12000 }),
    expect.anything(),
  );
});
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

```bash
npx vitest run app/routes/__tests__/campaign-direction-routes.test.ts
npx tsc --noEmit
npx eslint --max-warnings=0 app/routes/app.campaigns.\$campaignId.tsx
git add app/routes/app.campaigns.\$campaignId.tsx app/routes/__tests__/campaign-direction-routes.test.ts
git commit -m "feat(direction): embedded detail direction Card, POAS/break-even tiles, one-click act"
```

---

## Slice 4 — Dashboard parity

### Task 9: Dashboard GET endpoint `dashboard.api.campaigns.$id.direction`

**Files:**
- Create: `app/routes/dashboard.api.campaigns.$id.direction.tsx`
- Test: `app/routes/__tests__/campaign-direction-routes.test.ts` (append)

**Read first:** `app/routes/dashboard.api.campaigns.$id.tsx` (the sibling detail GET) for the exact session + `calderynClient`/`getSupabase` idiom and `dashboardJson` usage.

- [ ] **Step 1: Write the failing test**

```ts
it("dashboard direction endpoint returns the resolved direction", async () => {
  const { loader } = await import("~/routes/dashboard.api.campaigns.$id.direction");
  const res = await loader({
    request: new Request("https://x/dashboard/api/campaigns/cmp-1/direction"),
    params: { id: "cmp-1" }, context: {},
  } as never);
  const data = await (res as Response).json();
  expect(data).toMatchObject({ direction: "scale_up", suggestedBudgetCents: 12000 });
});
```

(Reuse the `resolveCampaignDirection` mock from Task 7; add the dashboard session/client mocks copied from the sibling dashboard route test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/campaign-direction-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// app/routes/dashboard.api.campaigns.$id.direction.tsx
// GET → the campaign's recommended direction + plain-English why (dashboard parity
// with the embedded detail). Same shared recommender + reasoning + cache.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { resolveCampaignDirection } from "~/lib/actions/direction-reason.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  const client = calderynClient(session.shopDomain);
  const [campaign, openAlerts, guardrails] = await Promise.all([
    client.campaigns.get(id),
    client.alerts.list({ status: "open" }).catch(() => []),
    client.guardrails.get().catch(() => null),
  ]);
  const breakEvenRoas = campaign.contribution_margin > 0 ? 1 / campaign.contribution_margin : null;
  return dashboardJson(async () =>
    resolveCampaignDirection({
      shopId: session.shopId,
      campaignId: campaign.id, // dim uuid
      roas: campaign.roas_7d > 0 ? campaign.roas_7d : null,
      breakEvenRoas,
      contributionMargin: campaign.contribution_margin,
      status: campaign.status,
      currentBudgetCents: campaign.daily_budget_cents,
      alerts: openAlerts.map((a) => ({ detector_id: a.detector_id, status: a.status, campaign_id: a.campaign_id })),
      guardrails: guardrails ?? {},
      sb: getSupabase(),
    }),
  );
}
```

> Verify `requireDashboardSession` returns both `shopId` and `shopDomain` (the action route uses `session.shopId`; the detail GET uses `session.shopDomain`). If one is absent, resolve it the same way the sibling route does.

- [ ] **Step 4: Run test, typecheck, commit**

```bash
npx vitest run app/routes/__tests__/campaign-direction-routes.test.ts
npx tsc --noEmit
git add app/routes/dashboard.api.campaigns.\$id.direction.tsx app/routes/__tests__/campaign-direction-routes.test.ts
git commit -m "feat(direction): dashboard direction GET endpoint (parity)"
```

### Task 10: Dashboard client fetch + detail UI

**Files:**
- Modify: `app/lib/dashboard/client.ts` (add `fetchCampaignDirection`)
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (detail render)

**Read first:** `client.ts` for the existing `fetch*` helper shape (base path, error handling), and `Campaigns.tsx` detail (≈ lines 104–323) for the `.cd-stat-grid`, `Pill`, `Btn`, `Tooltip` usage and how it POSTs actions to `dashboard.api.campaigns.$id.action`.

- [ ] **Step 1: Add the client fetch (mirror an existing `fetch*` in `client.ts`)**

```ts
export interface CampaignDirectionDTO {
  direction: "scale_up" | "scale_down" | "keep" | "pause";
  actionKind: "pause_campaign" | "reduce_campaign_budget" | "increase_campaign_budget" | null;
  suggestedBudgetCents: number | null;
  reason: string;
  reasonSource: "claude" | "template";
  dataSufficient: boolean;
}

export async function fetchCampaignDirection(id: string): Promise<CampaignDirectionDTO | null> {
  const r = await fetch(`/dashboard/api/campaigns/${encodeURIComponent(id)}/direction`, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return null;
  return (await r.json()) as CampaignDirectionDTO;
}
```

- [ ] **Step 2: In the detail render, load + show it** (mirror existing detail data-loading)

```tsx
const [direction, setDirection] = useState<CampaignDirectionDTO | null>(null);
useEffect(() => {
  let live = true;
  fetchCampaignDirection(c.id).then((d) => { if (live) setDirection(d); });
  return () => { live = false; };
}, [c.id]);

const DIR_PILL: Record<string, { label: string; tone: "success" | "warn" | "critical" | "neutral" }> = {
  scale_up: { label: "Scale up", tone: "success" },
  keep: { label: "Keep", tone: "neutral" },
  scale_down: { label: "Scale down", tone: "warn" },
  pause: { label: "Pause", tone: "critical" },
};

{direction && (
  <Card>
    <div className="flex items-center gap-2">
      <span className="cd-h2">Recommended direction</span>
      <Pill tone={DIR_PILL[direction.direction].tone}>{DIR_PILL[direction.direction].label}</Pill>
    </div>
    <p className="cd-body">{direction.reason}</p>
    {direction.actionKind && (
      <Btn
        onClick={() =>
          postCampaignAction(c.id, {
            type: direction.actionKind!,
            idempotency_key: `direction:${c.id}:${direction.actionKind}:${new Date().toISOString().slice(0, 10)}`,
            ...(direction.suggestedBudgetCents != null ? { daily_budget_cents: direction.suggestedBudgetCents } : {}),
          })
        }
      >
        {DIR_PILL[direction.direction].label}
      </Btn>
    )}
  </Card>
)}
```

> Reuse the existing action-POST helper this screen already calls for pause/scale (named like `postCampaignAction` / the existing `app.action(...)`); do not write a new fetch. Match the existing button + idempotency-key pattern exactly.

- [ ] **Step 3: Add the two metric tiles** to the `.cd-stat-grid`, mirroring the existing ROAS/Spend tiles:

```tsx
<div className="cd-stat">
  <div className="cd-stat-label">Break-even ROAS</div>
  <div className="cd-stat-value">{c.breakeven_roas ? `${c.breakeven_roas.toFixed(1)}×` : "—"}</div>
</div>
<div className="cd-stat">
  <div className="cd-stat-label">Profit ROAS (POAS)</div>
  <div className="cd-stat-value">
    {c.roas_7d > 0 && c.contribution_margin > 0 ? `${(c.roas_7d * c.contribution_margin).toFixed(1)}×` : "—"}
  </div>
</div>
```

- [ ] **Step 4: Typecheck, lint, build**

```bash
npx tsc --noEmit
npx eslint --max-warnings=0 app/components/dashboard/screens/Campaigns.tsx app/lib/dashboard/client.ts
npm run build
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/client.ts app/components/dashboard/screens/Campaigns.tsx
git commit -m "feat(direction): dashboard detail direction card, POAS/break-even tiles, one-click act (parity)"
```

---

## Final gate (run before opening any PR — CLAUDE.md pre-commit gate)

- [ ] `npx vitest run app/lib/actions app/lib/ads app/routes/__tests__/campaign-direction-routes.test.ts` → all green
- [ ] `npm run typecheck` → exit 0
- [ ] `npm run lint` → exit 0 (no new warnings on touched files)
- [ ] `npm run build` → exit 0
- [ ] `npx prisma migrate diff --exit-code` is **not** applicable (Supabase migration) — instead confirm the new migration applies cleanly via the Supabase MCP against a branch/dev project before deploy.
- [ ] `/code-review` on the working tree — resolve blockers.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Metric set (ROAS / break-even / POAS / margin), POAS unified → Tasks 6, 8, 10. ✓
- Deterministic recommender reusing grade thresholds + 0.7 pause floor → Task 1. ✓
- Alerts→input + one-click budget targets → Task 2. ✓
- Hybrid reasoning (Claude phrases, never decides) + template fallback + cache → Tasks 4, 5; immutability test in Task 5. ✓
- Cache table (renamed `grade_day`→`as_of_date`; `shops(id)` FK) → Task 3. ✓
- One-click act via existing `executeAction` → Tasks 8 (embedded), 9/10 (dashboard). ✓
- Both surfaces ship together → Slices 3 + 4. ✓
- Fail-visibly edge cases (null metrics → keep + dataSufficient false, no button) → Tasks 1, 5, 8, 10. ✓

**Deviations from spec (intentional):** cache day column named `as_of_date` (the generation date) rather than `grade_day`; recommender derives `breakEvenRoas` as `1/margin` (identical to the stored `break_even_roas` per `grade.py`) to avoid an extra fetch.

**Type consistency:** `Direction`, `DirectionActionKind`, `DirectionInput`, `DirectionResult`, `CampaignDirection`, `ReasonFacts` defined once in Slice 1–2 and imported thereafter; `ExecutableKind` is the existing type from `execute.server.ts`; loader/endpoint return the same `CampaignDirection` shape the dashboard `CampaignDirectionDTO` mirrors.

**Open items the executor must confirm against live code (flagged inline):** how the embedded loader exposes `shopId`; whether the route already has an `action`; whether `requireDashboardSession` exposes both `shopId` and `shopDomain`; the exact name of the dashboard screen's existing action-POST helper.
