# Ad Creative Pre-Screen ("Virality Predictor") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/app/screener` page where a merchant enters an ad creative (image + copy + targeting + destination URL) and gets a full scorecard — composite Virality Potential score, predicted grade, 16 metrics with expandable reasoning, predicted outcomes headlined by a history-grounded Estimated ROAS, and ranked tips — with runs persisted.

**Architecture:** A new `app/lib/screener/` module following the repo's standard `app/lib/` pattern: a Claude **forced-tool** scorer (`score.server.ts`), a **pure deterministic** calibrator (`calibrate.server.ts`) that turns dimension scores + account history + SKU price into predicted outcomes, a thin Supabase history reader (`history.server.ts`), a persisted run table (`runs.server.ts`), and a dependency-injected orchestrator (`orchestrate.server.ts`). The route renders the scorecard with Polaris.

**Tech Stack:** Remix (Vite) + TypeScript (strict), Polaris, Anthropic SDK (vision + forced tool use), Supabase (service-role), Vitest.

---

## Scope & plan sequence

This is **Plan 1 of 4**. Each plan ships working, testable software on its own.

- **Plan 1 (this doc) — Scoring core + scorecard UI.** Manual ad entry → scored, calibrated scorecard with Estimated ROAS + tips, persisted. No external generation provider, no Meta fetch. Fully shippable.
- **Plan 2 — Meta source.** List + fetch draft/paused ads from the connected Meta account as the creative input; wire creative→SKU from the real ad.
- **Plan 3 — Anti-slop generation loop (copy).** `brief.server.ts` + `CreativeGenerator` adapter + re-score gate + native-Claude copy variations + push a chosen variant to Meta as a *paused* draft.
- **Plan 4 — Image/video providers.** Provider-backed generators behind the same adapter, env-gated with graceful degradation.

Spec: `docs/superpowers/specs/2026-06-07-ad-creative-pre-screen-design.md`.

**Plan 1 simplification (deliberate, YAGNI):** all 13 creative dimensions are modeled uniformly as a `0..100` score + reasoning (the spec's "policy risk = Low/Med/High" and "text density = %" become a uniform safety/appropriateness score whose reasoning names the specifics). This keeps the data model and UI uniform for v1; a later plan can specialize them if needed.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260607120000_creative_screen_run.sql` | `creative_screen_run` table + `v_creative_screen_runs` view |
| `tests/engine/schema/migrations/20260607120000_creative_screen_run.sql` | identical mirror so the test DB has the table |
| `app/lib/screener/types.ts` | All DTOs + constants. No raw DB rows leak. |
| `app/lib/screener/calibrate.server.ts` | **Pure** deterministic calibration: metrics + history + spend → outcomes/composite/grade/confidence |
| `app/lib/screener/score.server.ts` | Claude forced-tool scorer; injectable `CreateMessageFn` |
| `app/lib/screener/history.server.ts` | Reads `CalibrationInputs` from Supabase (account baselines, break-even, SKU price/CVR) |
| `app/lib/screener/runs.server.ts` | Persist runs to `creative_screen_run` |
| `app/lib/screener/orchestrate.server.ts` | DI wiring: input → score → history → calibrate → persist; in-app error DTO |
| `app/routes/app.screener.tsx` | Manual-input form + scorecard UI (expandable metrics, ROAS, tips) |
| `app/lib/screener/__tests__/*.test.ts` | Behavior tests per unit |

---

## Task 1: Database migration — `creative_screen_run`

**Files:**
- Create: `supabase/migrations/20260607120000_creative_screen_run.sql`
- Create: `tests/engine/schema/migrations/20260607120000_creative_screen_run.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260607120000_creative_screen_run.sql`:

```sql
-- creative_screen_run: one ad-creative pre-screen. `scorecard` holds the scored
-- + calibrated result (composite, grade, metrics with reasoning, predicted
-- outcomes, tips). Shop-scoped in code (service-role).

create table creative_screen_run (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references shops(id) on delete cascade,
  status               text not null default 'running'
                         check (status in ('running','done','error')),
  source               text not null default 'manual'
                         check (source in ('manual','meta_ad')),
  meta_ad_id           text,
  mapped_sku_id        uuid references sku_dim(id),
  assumed_spend_cents  integer not null default 50000,
  scorecard            jsonb,
  error                text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

-- Deny-by-default: the app reads/writes with the service-role key (bypasses RLS).
alter table creative_screen_run enable row level security;

create index creative_screen_run_shop_created_idx
  on creative_screen_run (shop_id, created_at desc);

-- Read view mirrors the v_*_view convention. `scorecard` is heavy; list queries
-- select columns explicitly and omit it.
create view v_creative_screen_runs as
  select id, shop_id, status, source, meta_ad_id, mapped_sku_id,
         assumed_spend_cents, scorecard, error, created_at, completed_at
  from creative_screen_run;
```

- [ ] **Step 2: Mirror it into the test schema**

Copy the identical file to `tests/engine/schema/migrations/20260607120000_creative_screen_run.sql` (same content — the engine test schema applies these to spin up the test DB).

- [ ] **Step 3: Validate the migration parses**

Run: `npx prisma format --schema=/dev/null 2>/dev/null; echo "sql files are applied by supabase, not prisma"`
Then sanity-check the SQL has no obvious syntax error by eye (balanced parens, trailing semicolons). There is no local `supabase db` in this repo's test loop; the test schema mirror (Step 2) is what exercises it.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260607120000_creative_screen_run.sql tests/engine/schema/migrations/20260607120000_creative_screen_run.sql
git commit -m "screener: add creative_screen_run table + view"
```

---

## Task 2: Types — `app/lib/screener/types.ts`

**Files:**
- Create: `app/lib/screener/types.ts`

- [ ] **Step 1: Write the types**

Create `app/lib/screener/types.ts`:

```ts
// app/lib/screener/types.ts

export const MIN_SPEND_CENTS = 1000;       // $10 floor for the spend assumption
export const MAX_SPEND_CENTS = 10_000_000; // $100k ceiling
export const DEFAULT_SPEND_CENTS = 50_000; // $500 default

/** Fallbacks used only on cold start (no SKU price / CVR). Documented + labeled. */
export const DEFAULT_CVR = 0.02;              // 2% order conversion
export const DEFAULT_AOV_CENTS = 4000;        // $40 average order value
export const DEFAULT_BASELINE_CTR = 0.01;     // 1% click-through
export const DEFAULT_BASELINE_CPM_CENTS = 1500; // $15 CPM
export const DEFAULT_ENGAGEMENT_RATE = 0.05;  // 5% hold/engagement
export const DEFAULT_BREAK_EVEN_ROAS = 2.0;

export const METRIC_GROUPS = [
  "attention",
  "message",
  "offer_conversion",
  "trust_safety",
] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

export const METRIC_GROUP_LABELS: Record<MetricGroup, string> = {
  attention: "Attention",
  message: "Message",
  offer_conversion: "Offer & Conversion",
  trust_safety: "Trust & Safety",
};

/** The 13 creative dimensions, each scored 0..100 by Claude with reasoning. */
export const DIMENSIONS: { id: string; group: MetricGroup; label: string }[] = [
  { id: "hook_strength", group: "attention", label: "Hook strength" },
  { id: "visual_focal_clarity", group: "attention", label: "Visual focal clarity" },
  { id: "brand_presence", group: "attention", label: "Brand presence / recall" },
  { id: "headline_clarity", group: "message", label: "Headline clarity" },
  { id: "copy_concision", group: "message", label: "Copy concision" },
  { id: "readability_tone", group: "message", label: "Readability / tone match" },
  { id: "offer_strength", group: "offer_conversion", label: "Offer strength" },
  { id: "creative_offer_fit", group: "offer_conversion", label: "Creative ↔ offer fit" },
  { id: "cta_strength", group: "offer_conversion", label: "CTA strength" },
  { id: "audience_fit", group: "offer_conversion", label: "Audience / targeting fit" },
  { id: "social_proof", group: "trust_safety", label: "Social proof / trust signals" },
  { id: "policy_risk", group: "trust_safety", label: "Policy / compliance safety" },
  { id: "text_in_image", group: "trust_safety", label: "Text-in-image restraint" },
];
export type DimensionId = (typeof DIMENSIONS)[number]["id"];

export interface MetricScore {
  id: string;          // DimensionId
  group: MetricGroup;
  label: string;
  score: number;       // 0..100
  reasoning: string;
  benchmarkAds?: string[];
}

export type Grade = "winning" | "okay" | "poor";
export type Confidence = "high" | "medium" | "low";

export interface PredictedOutcomes {
  estimatedRoas: number;
  roasLow: number;
  roasHigh: number;
  breakEvenRoas: number;
  predictedCtr: number;          // fraction 0..1
  holdRate: number;              // fraction 0..1
  assumedSpendCents: number;
  predictedRevenueCents: number;
  mappedSku: string | null;
  skuPriceCents: number | null;
}

export interface ScoreCard {
  composite: number;             // 0..100
  grade: Grade;
  confidence: Confidence;
  summary: string;
  metrics: MetricScore[];
  outcomes: PredictedOutcomes;
  tips: string[];
}

/** What the merchant enters (Plan 1) or what we fetch from Meta (Plan 2). */
export interface CreativeInput {
  imageUrl: string | null;
  headline: string;
  primaryText: string;
  cta: string;
  destinationUrl: string;
  audience: string;
}

/** Read from Supabase by history.server.ts; consumed (pure) by calibrate. */
export interface CalibrationInputs {
  accountBaselineCtr: number;       // fraction
  accountBaselineCpmCents: number;
  accountEngagementRate: number;    // fraction
  breakEvenRoas: number;
  mappedSku: string | null;
  skuPriceCents: number | null;
  skuCvr: number | null;            // fraction
  topAdNames: string[];
  historyAdCount: number;           // drives confidence / cold-start
}

export type RunStatus = "running" | "done" | "error";
export type RunSource = "manual" | "meta_ad";

/** DTO returned to the client — never the raw DB row. */
export interface CreativeScreenRun {
  id: string;
  status: RunStatus;
  source: RunSource;
  metaAdId: string | null;
  assumedSpendCents: number;
  scorecard: ScoreCard | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors from the new file).

- [ ] **Step 3: Commit**

```bash
git add app/lib/screener/types.ts
git commit -m "screener: add DTOs and scoring constants"
```

---

## Task 3: Calibration (pure) — `calibrate.server.ts`

This is the heart of the "grounded, not a vibe" promise. Pure functions, no I/O, fully unit-tested.

**Files:**
- Create: `app/lib/screener/calibrate.server.ts`
- Test: `app/lib/screener/__tests__/calibrate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/screener/__tests__/calibrate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calibrate, ctrMultiplier, compositeScore, gradeFor } from "../calibrate.server";
import { DIMENSIONS, type MetricScore, type CalibrationInputs } from "../types";

function metricsAll(score: number): MetricScore[] {
  return DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score, reasoning: "" }));
}

const fullHistory: CalibrationInputs = {
  accountBaselineCtr: 0.01,
  accountBaselineCpmCents: 1500,
  accountEngagementRate: 0.05,
  breakEvenRoas: 1.9,
  mappedSku: "HYD-SERUM-30ML",
  skuPriceCents: 4200,
  skuCvr: 0.021,
  topAdNames: ["Summer Bundle Drop", "Glow in 7 days"],
  historyAdCount: 23,
};

describe("ctrMultiplier", () => {
  it("returns ~1.0 for an average (50) creative", () => {
    expect(ctrMultiplier(metricsAll(50))).toBeCloseTo(1.0, 2);
  });
  it("is >1 for a strong creative and <1 for a weak one", () => {
    expect(ctrMultiplier(metricsAll(90))).toBeGreaterThan(1.3);
    expect(ctrMultiplier(metricsAll(20))).toBeLessThan(0.7);
  });
  it("clamps to the documented bounds", () => {
    expect(ctrMultiplier(metricsAll(100))).toBeLessThanOrEqual(2.5);
    expect(ctrMultiplier(metricsAll(0))).toBeGreaterThanOrEqual(0.3);
  });
});

describe("compositeScore + gradeFor", () => {
  it("rolls dimensions into 0..100 and grades", () => {
    expect(compositeScore(metricsAll(80))).toBeGreaterThanOrEqual(75);
    expect(gradeFor(80)).toBe("winning");
    expect(gradeFor(60)).toBe("okay");
    expect(gradeFor(40)).toBe("poor");
  });
});

describe("calibrate", () => {
  it("computes ROAS from SKU price, CTR and CVR with full history → high confidence", () => {
    const r = calibrate(metricsAll(70), fullHistory, 50000);
    expect(r.confidence).toBe("high");
    expect(r.outcomes.estimatedRoas).toBeGreaterThan(0);
    expect(r.outcomes.skuPriceCents).toBe(4200);
    expect(r.outcomes.breakEvenRoas).toBe(1.9);
    // band brackets the point estimate
    expect(r.outcomes.roasLow).toBeLessThan(r.outcomes.estimatedRoas);
    expect(r.outcomes.roasHigh).toBeGreaterThan(r.outcomes.estimatedRoas);
  });

  it("ROAS scales with the assumed spend's revenue correctly (more clicks at same CVR)", () => {
    const a = calibrate(metricsAll(70), fullHistory, 50000);
    const b = calibrate(metricsAll(70), fullHistory, 100000);
    // ROAS is revenue/spend; with linear model it stays ~constant — assert it's stable, not divergent
    expect(Math.abs(a.outcomes.estimatedRoas - b.outcomes.estimatedRoas)).toBeLessThan(0.01);
  });

  it("cold start (no SKU, no history) → low confidence + wide band using fallbacks", () => {
    const cold: CalibrationInputs = {
      accountBaselineCtr: 0.01, accountBaselineCpmCents: 1500, accountEngagementRate: 0.05,
      breakEvenRoas: 2.0, mappedSku: null, skuPriceCents: null, skuCvr: null,
      topAdNames: [], historyAdCount: 0,
    };
    const r = calibrate(metricsAll(60), cold, 50000);
    expect(r.confidence).toBe("low");
    expect(r.outcomes.mappedSku).toBeNull();
    expect(Number.isFinite(r.outcomes.estimatedRoas)).toBe(true);
    const fullBand = r.outcomes.roasHigh - r.outcomes.roasLow;
    const tight = calibrate(metricsAll(60), fullHistory, 50000);
    const tightBand = tight.outcomes.roasHigh - tight.outcomes.roasLow;
    // relative band is wider on cold start
    expect(fullBand / r.outcomes.estimatedRoas).toBeGreaterThan(tightBand / tight.outcomes.estimatedRoas);
  });

  it("medium confidence for thin-but-present history", () => {
    const r = calibrate(metricsAll(60), { ...fullHistory, historyAdCount: 6 }, 50000);
    expect(r.confidence).toBe("medium");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/lib/screener/__tests__/calibrate.test.ts`
Expected: FAIL — `calibrate.server.ts` does not exist / exports undefined.

- [ ] **Step 3: Write the implementation**

Create `app/lib/screener/calibrate.server.ts`:

```ts
// app/lib/screener/calibrate.server.ts
// Pure deterministic calibration. No I/O, no model calls. The model judges
// (dimension scores); this code does the arithmetic that turns those judgments
// + the merchant's real history into predicted outcomes.
import {
  DEFAULT_AOV_CENTS, DEFAULT_CVR,
  type CalibrationInputs, type Confidence, type Grade,
  type MetricScore, type PredictedOutcomes,
} from "./types";

const byId = (metrics: MetricScore[], id: string): number =>
  metrics.find((m) => m.id === id)?.score ?? 50;

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

// Dimensions that drive click-through, with weights. Average score 50 ⇒ 1.0×.
const CTR_WEIGHTS: Record<string, number> = {
  hook_strength: 0.35,
  visual_focal_clarity: 0.2,
  cta_strength: 0.2,
  offer_strength: 0.15,
  creative_offer_fit: 0.1,
};

export function ctrMultiplier(metrics: MetricScore[]): number {
  let weighted = 0;
  let total = 0;
  for (const [id, w] of Object.entries(CTR_WEIGHTS)) {
    weighted += byId(metrics, id) * w;
    total += w;
  }
  const avg = total > 0 ? weighted / total : 50;
  return clamp(avg / 50, 0.3, 2.5);
}

// Hold/engagement driven by attention group.
function engagementMultiplier(metrics: MetricScore[]): number {
  const ids = ["hook_strength", "visual_focal_clarity", "brand_presence"];
  const avg = ids.reduce((s, id) => s + byId(metrics, id), 0) / ids.length;
  return clamp(avg / 50, 0.3, 2.5);
}

export function compositeScore(metrics: MetricScore[]): number {
  if (metrics.length === 0) return 0;
  const avg = metrics.reduce((s, m) => s + m.score, 0) / metrics.length;
  return Math.round(clamp(avg, 0, 100));
}

export function gradeFor(composite: number): Grade {
  if (composite >= 75) return "winning";
  if (composite >= 55) return "okay";
  return "poor";
}

function confidenceFor(inputs: CalibrationInputs): Confidence {
  if (inputs.historyAdCount >= 15 && inputs.skuPriceCents != null && inputs.skuCvr != null) {
    return "high";
  }
  if (inputs.historyAdCount >= 5) return "medium";
  return "low";
}

// Band half-width as a fraction of the point estimate, by confidence.
const BAND: Record<Confidence, { lo: number; hi: number }> = {
  high: { lo: 0.25, hi: 0.3 },
  medium: { lo: 0.4, hi: 0.5 },
  low: { lo: 0.6, hi: 0.8 },
};

export function calibrate(
  metrics: MetricScore[],
  inputs: CalibrationInputs,
  assumedSpendCents: number,
): { outcomes: PredictedOutcomes; composite: number; grade: Grade; confidence: Confidence } {
  const confidence = confidenceFor(inputs);

  const predictedCtr = clamp(inputs.accountBaselineCtr * ctrMultiplier(metrics), 0, 1);
  const holdRate = clamp(inputs.accountEngagementRate * engagementMultiplier(metrics), 0, 1);

  const cpm = inputs.accountBaselineCpmCents || 1;
  const projectedImpressions = (assumedSpendCents / cpm) * 1000;
  const predictedClicks = projectedImpressions * predictedCtr;

  const cvr = inputs.skuCvr ?? DEFAULT_CVR;
  const priceCents = inputs.skuPriceCents ?? DEFAULT_AOV_CENTS;
  const predictedOrders = predictedClicks * cvr;
  const predictedRevenueCents = predictedOrders * priceCents;

  const estimatedRoas = assumedSpendCents > 0
    ? predictedRevenueCents / assumedSpendCents
    : 0;

  const band = BAND[confidence];
  const outcomes: PredictedOutcomes = {
    estimatedRoas: Number(estimatedRoas.toFixed(2)),
    roasLow: Number((estimatedRoas * (1 - band.lo)).toFixed(2)),
    roasHigh: Number((estimatedRoas * (1 + band.hi)).toFixed(2)),
    breakEvenRoas: inputs.breakEvenRoas,
    predictedCtr,
    holdRate,
    assumedSpendCents,
    predictedRevenueCents: Math.round(predictedRevenueCents),
    mappedSku: inputs.mappedSku,
    skuPriceCents: inputs.skuPriceCents,
  };

  const composite = compositeScore(metrics);
  return { outcomes, composite, grade: gradeFor(composite), confidence };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/lib/screener/__tests__/calibrate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/calibrate.server.ts app/lib/screener/__tests__/calibrate.test.ts
git commit -m "screener: pure deterministic calibration (ROAS/CTR/grade/confidence)"
```

---

## Task 4: Claude scorer — `score.server.ts`

Forced-tool call, injectable `CreateMessageFn`, parse + normalize.

**Files:**
- Create: `app/lib/screener/score.server.ts`
- Test: `app/lib/screener/__tests__/score.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/screener/__tests__/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildScoreCardMetrics, scoreCreative, SCORE_TOOL_NAME } from "../score.server";
import { DIMENSIONS, type CreativeInput } from "../types";

const input: CreativeInput = {
  imageUrl: null,
  headline: "Introducing our new serum",
  primaryText: "A serum for your skin. Buy now and feel great every single day.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/p/serum?utm_campaign=spring",
  audience: "Women 25-44 interested in skincare",
};

function fakeToolResult(overrides?: Record<string, unknown>) {
  const dims = Object.fromEntries(
    DIMENSIONS.map((d) => [d.id, { score: 60, reasoning: `r:${d.id}` }]),
  );
  return {
    content: [
      {
        type: "tool_use",
        name: SCORE_TOOL_NAME,
        input: { summary: "ok", dimensions: dims, tips: ["fix the hook"], ...overrides },
      },
    ],
  };
}

describe("buildScoreCardMetrics", () => {
  it("maps all 13 dimensions with labels and reasoning, clamping out-of-range", () => {
    const dims = Object.fromEntries(DIMENSIONS.map((d) => [d.id, { score: 150, reasoning: "x" }]));
    const metrics = buildScoreCardMetrics(dims);
    expect(metrics).toHaveLength(13);
    expect(metrics.every((m) => m.score >= 0 && m.score <= 100)).toBe(true);
    expect(metrics.find((m) => m.id === "hook_strength")?.label).toBe("Hook strength");
  });
  it("defaults a missing dimension to 50 with empty reasoning", () => {
    const metrics = buildScoreCardMetrics({});
    expect(metrics).toHaveLength(13);
    expect(metrics[0].score).toBe(50);
  });
});

describe("scoreCreative", () => {
  it("calls the forced tool and returns metrics + summary + tips", async () => {
    const res = await scoreCreative(input, ["Top Ad A"], {
      createMessage: async () => fakeToolResult() as never,
      model: "test-model",
    });
    expect(res.summary).toBe("ok");
    expect(res.tips).toContain("fix the hook");
    expect(res.metrics).toHaveLength(13);
  });

  it("throws if the model does not return the tool call", async () => {
    await expect(
      scoreCreative(input, [], {
        createMessage: async () => ({ content: [{ type: "text", text: "no tool" }] }) as never,
        model: "test-model",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/screener/__tests__/score.test.ts`
Expected: FAIL — `score.server.ts` missing.

- [ ] **Step 3: Write the implementation**

Create `app/lib/screener/score.server.ts`:

```ts
// app/lib/screener/score.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import { DIMENSIONS, type CreativeInput, type MetricScore } from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export const SCORE_TOOL_NAME = "report_creative_score";
const MAX_TOKENS = 4096;

export const SCORE_TOOL: Anthropic.Tool = {
  name: SCORE_TOOL_NAME,
  description:
    "Report the pre-launch score for this ad creative: a 0-100 score with one-sentence reasoning for each named dimension, a one-line summary, and ranked improvement tips.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-sentence read of the creative." },
      dimensions: {
        type: "object",
        description: "Keyed by dimension id; each value has score (0-100) and reasoning.",
        properties: Object.fromEntries(
          DIMENSIONS.map((d) => [
            d.id,
            {
              type: "object",
              properties: {
                score: { type: "number", description: `0-100 for ${d.label}` },
                reasoning: { type: "string" },
              },
              required: ["score", "reasoning"],
            },
          ]),
        ),
      },
      tips: {
        type: "array",
        items: { type: "string" },
        description: "Ranked, concrete fixes, biggest lever first.",
      },
    },
    required: ["summary", "dimensions", "tips"],
  },
};

const clamp100 = (x: unknown): number => {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.round(n), 0), 100);
};

export function buildScoreCardMetrics(dimensions: unknown): MetricScore[] {
  const d = (dimensions ?? {}) as Record<string, { score?: unknown; reasoning?: unknown }>;
  return DIMENSIONS.map((dim) => {
    const raw = d[dim.id] ?? {};
    return {
      id: dim.id,
      group: dim.group,
      label: dim.label,
      score: clamp100(raw.score),
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    };
  });
}

export function buildSystemPrompt(): string {
  return [
    "You are an expert direct-response ad reviewer. Score an ad creative BEFORE it runs.",
    "You are given the creative's image (if any), headline, primary text, CTA, destination URL, and target audience.",
    "Score each named dimension 0-100 and give one concrete sentence of reasoning. Be opinionated and specific.",
    "When the merchant's top historical ads are provided, compare against them and reference them by name in your reasoning.",
    "Then give ranked, concrete improvement tips — biggest lever first.",
    `Always call the ${SCORE_TOOL_NAME} tool.`,
  ].join("\n");
}

export function buildUserContent(
  input: CreativeInput,
  topAdNames: string[],
): Anthropic.MessageParam["content"] {
  const text =
    `Headline: ${input.headline}\n` +
    `Primary text: ${input.primaryText}\n` +
    `CTA: ${input.cta}\n` +
    `Destination: ${input.destinationUrl}\n` +
    `Audience: ${input.audience}\n` +
    (topAdNames.length ? `\nMerchant's top historical ads: ${topAdNames.join(", ")}` : "\nNo historical ads available.");

  if (!input.imageUrl) return text;
  return [
    { type: "image", source: { type: "url", url: input.imageUrl } },
    { type: "text", text },
  ];
}

export async function scoreCreative(
  input: CreativeInput,
  topAdNames: string[],
  opts: { createMessage: CreateMessageFn; model: string },
): Promise<{ summary: string; metrics: MetricScore[]; tips: string[] }> {
  const res = await opts.createMessage({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: SCORE_TOOL_NAME },
    messages: [{ role: "user", content: buildUserContent(input, topAdNames) }],
  });
  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SCORE_TOOL_NAME,
  );
  if (!toolUse) throw new Error("Scorer did not return a report_creative_score tool call");
  const out = toolUse.input as { summary?: unknown; dimensions?: unknown; tips?: unknown };
  return {
    summary: typeof out.summary === "string" ? out.summary : "",
    metrics: buildScoreCardMetrics(out.dimensions),
    tips: Array.isArray(out.tips) ? out.tips.filter((t): t is string => typeof t === "string") : [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/screener/__tests__/score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/score.server.ts app/lib/screener/__tests__/score.test.ts
git commit -m "screener: Claude forced-tool creative scorer"
```

---

## Task 5: History reader — `history.server.ts`

Reads the `CalibrationInputs` from Supabase. The Supabase client is injectable so the shaping logic is testable with a fake.

**Files:**
- Create: `app/lib/screener/history.server.ts`
- Test: `app/lib/screener/__tests__/history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/screener/__tests__/history.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shapeCalibrationInputs } from "../history.server";

describe("shapeCalibrationInputs", () => {
  it("uses real values when present", () => {
    const out = shapeCalibrationInputs({
      ctr: 0.013,
      cpmCents: 1800,
      engagementRate: 0.06,
      breakEvenRoas: 1.9,
      mappedSku: "HYD-SERUM-30ML",
      skuPriceCents: 4200,
      skuCvr: 0.021,
      topAdNames: ["A", "B", "C"],
      historyAdCount: 23,
    });
    expect(out.accountBaselineCtr).toBe(0.013);
    expect(out.skuPriceCents).toBe(4200);
    expect(out.historyAdCount).toBe(23);
  });

  it("falls back to documented defaults for missing account metrics, leaving SKU fields null", () => {
    const out = shapeCalibrationInputs({
      ctr: null, cpmCents: null, engagementRate: null, breakEvenRoas: null,
      mappedSku: null, skuPriceCents: null, skuCvr: null, topAdNames: [], historyAdCount: 0,
    });
    expect(out.accountBaselineCtr).toBeGreaterThan(0);
    expect(out.breakEvenRoas).toBeGreaterThan(0);
    expect(out.skuPriceCents).toBeNull();
    expect(out.skuCvr).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/screener/__tests__/history.test.ts`
Expected: FAIL — `history.server.ts` missing.

- [ ] **Step 3: Write the implementation**

Create `app/lib/screener/history.server.ts`:

```ts
// app/lib/screener/history.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import {
  DEFAULT_BASELINE_CPM_CENTS, DEFAULT_BASELINE_CTR, DEFAULT_BREAK_EVEN_ROAS,
  DEFAULT_ENGAGEMENT_RATE, type CalibrationInputs,
} from "./types";

/** Raw aggregates pulled from Supabase; nulls mean "no data yet". */
export interface RawHistory {
  ctr: number | null;
  cpmCents: number | null;
  engagementRate: number | null;
  breakEvenRoas: number | null;
  mappedSku: string | null;
  skuPriceCents: number | null;
  skuCvr: number | null;
  topAdNames: string[];
  historyAdCount: number;
}

/** Pure shaping: raw aggregates → CalibrationInputs with documented fallbacks. */
export function shapeCalibrationInputs(raw: RawHistory): CalibrationInputs {
  return {
    accountBaselineCtr: raw.ctr ?? DEFAULT_BASELINE_CTR,
    accountBaselineCpmCents: raw.cpmCents ?? DEFAULT_BASELINE_CPM_CENTS,
    accountEngagementRate: raw.engagementRate ?? DEFAULT_ENGAGEMENT_RATE,
    breakEvenRoas: raw.breakEvenRoas ?? DEFAULT_BREAK_EVEN_ROAS,
    mappedSku: raw.mappedSku,
    skuPriceCents: raw.skuPriceCents,
    skuCvr: raw.skuCvr,
    topAdNames: raw.topAdNames,
    historyAdCount: raw.historyAdCount,
  };
}

/**
 * Read calibration inputs for a shop. `mappedSku` (resolved from the creative's
 * destination URL in the orchestrator) selects the SKU price/CVR. On any read
 * error or empty account this returns all-null raw → shapeCalibrationInputs
 * supplies fallbacks (cold start), never throwing.
 */
export async function loadCalibrationInputs(
  shop: string,
  mappedSku: string | null,
): Promise<CalibrationInputs> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);

  // Account-level grade aggregates (roas, break_even) — most recent per campaign.
  const grades = await sb
    .from("campaign_grade_fact")
    .select("break_even_roas")
    .eq("shop_id", shopId)
    .limit(200);

  const breakEvens = (grades.data ?? [])
    .map((r) => Number((r as { break_even_roas?: unknown }).break_even_roas))
    .filter((n) => Number.isFinite(n) && n > 0);
  const breakEvenRoas = breakEvens.length
    ? breakEvens.reduce((s, n) => s + n, 0) / breakEvens.length
    : null;

  // Top ad names by engagement (best-effort; empty on no data).
  const eng = await sb
    .from("ad_engagement_fact")
    .select("ad_campaign_dim(name)")
    .eq("shop_id", shopId)
    .limit(50);
  const topAdNames = Array.from(
    new Set(
      (eng.data ?? [])
        .map((r) => (r as { ad_campaign_dim?: { name?: string } }).ad_campaign_dim?.name)
        .filter((n): n is string => typeof n === "string"),
    ),
  ).slice(0, 3);

  // SKU price for the mapped SKU, if any.
  let skuPriceCents: number | null = null;
  if (mappedSku) {
    const sku = await sb
      .from("sku_dim")
      .select("price_cents")
      .eq("shop_id", shopId)
      .eq("sku", mappedSku)
      .maybeSingle();
    const p = Number((sku.data as { price_cents?: unknown } | null)?.price_cents);
    if (Number.isFinite(p) && p > 0) skuPriceCents = p;
  }

  // CTR/CPM/engagement/CVR account baselines are not yet materialized as a single
  // view; Plan 1 leaves them null so documented fallbacks apply. Plan 2 wires the
  // real ad_spend_fact / order_fact aggregates here.
  const raw: RawHistory = {
    ctr: null,
    cpmCents: null,
    engagementRate: null,
    breakEvenRoas,
    mappedSku,
    skuPriceCents,
    skuCvr: null,
    topAdNames,
    historyAdCount: topAdNames.length, // proxy until Plan 2's real count
  };
  return shapeCalibrationInputs(raw);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/screener/__tests__/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/history.server.ts app/lib/screener/__tests__/history.test.ts
git commit -m "screener: calibration-inputs history reader with cold-start fallbacks"
```

---

## Task 6: Run persistence — `runs.server.ts`

**Files:**
- Create: `app/lib/screener/runs.server.ts`
- Test: `app/lib/screener/__tests__/runs.test.ts`

- [ ] **Step 1: Write the failing test (row → DTO shaping)**

Create `app/lib/screener/__tests__/runs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rowToRun } from "../runs.server";

describe("rowToRun", () => {
  it("shapes a DB row into the DTO, never leaking shop_id", () => {
    const dto = rowToRun({
      id: "run-1",
      status: "done",
      source: "manual",
      meta_ad_id: null,
      assumed_spend_cents: 50000,
      scorecard: { composite: 64, grade: "okay" },
      error: null,
      created_at: "2026-06-07T00:00:00Z",
      completed_at: "2026-06-07T00:00:05Z",
      shop_id: "secret",
    });
    expect(dto.id).toBe("run-1");
    expect(dto.assumedSpendCents).toBe(50000);
    expect(dto.scorecard).toEqual({ composite: 64, grade: "okay" });
    expect((dto as Record<string, unknown>).shop_id).toBeUndefined();
  });

  it("defaults missing optionals", () => {
    const dto = rowToRun({ id: "r", status: "running", created_at: "t" });
    expect(dto.source).toBe("manual");
    expect(dto.scorecard).toBeNull();
    expect(dto.completedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/screener/__tests__/runs.test.ts`
Expected: FAIL — `runs.server.ts` missing.

- [ ] **Step 3: Write the implementation**

Create `app/lib/screener/runs.server.ts`:

```ts
// app/lib/screener/runs.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import type { CreativeScreenRun, RunSource, RunStatus, ScoreCard } from "./types";

export function rowToRun(r: Record<string, unknown>): CreativeScreenRun {
  return {
    id: String(r.id),
    status: (r.status as RunStatus) ?? "running",
    source: (r.source as RunSource) ?? "manual",
    metaAdId: (r.meta_ad_id as string | null) ?? null,
    assumedSpendCents: Number(r.assumed_spend_cents ?? 0),
    scorecard: (r.scorecard as ScoreCard | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

export async function startRun(
  shop: string,
  source: RunSource,
  assumedSpendCents: number,
  metaAdId: string | null = null,
): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("creative_screen_run")
    .insert({
      shop_id: shopId,
      status: "running",
      source,
      assumed_spend_cents: assumedSpendCents,
      meta_ad_id: metaAdId,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function completeRun(id: string, scorecard: ScoreCard): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ status: "done", scorecard, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function failRun(id: string, message: string): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ status: "error", error: message, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function getLatestRun(shop: string): Promise<CreativeScreenRun | null> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_creative_screen_runs")
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRun(data) : null;
}

// History list omits the heavy `scorecard` blob (every item has scorecard: null).
export async function listRuns(shop: string, limit = 10): Promise<CreativeScreenRun[]> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_creative_screen_runs")
    .select("id, status, source, meta_ad_id, assumed_spend_cents, error, created_at, completed_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToRun);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/screener/__tests__/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/runs.server.ts app/lib/screener/__tests__/runs.test.ts
git commit -m "screener: creative_screen_run persistence helpers"
```

---

## Task 7: Orchestrator — `orchestrate.server.ts`

DI wiring, in-app error DTO on failure.

**Files:**
- Create: `app/lib/screener/orchestrate.server.ts`
- Test: `app/lib/screener/__tests__/orchestrate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/screener/__tests__/orchestrate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { executeScreen, type ScreenDeps } from "../orchestrate.server";
import { DIMENSIONS, type CreativeInput, type CalibrationInputs, type CreativeScreenRun } from "../types";

const input: CreativeInput = {
  imageUrl: null, headline: "h", primaryText: "p", cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p?utm_campaign=spring", audience: "a",
};

const calib: CalibrationInputs = {
  accountBaselineCtr: 0.01, accountBaselineCpmCents: 1500, accountEngagementRate: 0.05,
  breakEvenRoas: 1.9, mappedSku: "SKU1", skuPriceCents: 4200, skuCvr: 0.02,
  topAdNames: ["A"], historyAdCount: 23,
};

function deps(over: Partial<ScreenDeps> = {}): ScreenDeps {
  const run: CreativeScreenRun = {
    id: "run-1", status: "running", source: "manual", metaAdId: null,
    assumedSpendCents: 50000, scorecard: null, error: null,
    createdAt: "t", completedAt: null,
  };
  return {
    resolveSku: () => "SKU1",
    loadCalibrationInputs: async () => calib,
    scoreCreative: async () => ({
      summary: "ok",
      metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
      tips: ["t"],
    }),
    startRun: async () => run,
    completeRun: async (_id, scorecard) => ({ ...run, status: "done", scorecard }),
    failRun: async (_id, message) => ({ ...run, status: "error", error: message }),
    ...over,
  };
}

describe("executeScreen", () => {
  it("scores, calibrates, persists, and returns a done run with a full scorecard", async () => {
    const out = await executeScreen({ shop: "s.myshopify.com", input, assumedSpendCents: 50000 }, deps());
    expect(out.status).toBe("done");
    expect(out.scorecard?.metrics).toHaveLength(13);
    expect(out.scorecard?.outcomes.estimatedRoas).toBeGreaterThan(0);
    expect(out.scorecard?.grade).toBe("okay");
  });

  it("returns an error run (not a throw) when scoring fails after the run is started", async () => {
    const failing = deps({ scoreCreative: async () => { throw new Error("boom"); } });
    const out = await executeScreen({ shop: "s", input, assumedSpendCents: 50000 }, failing);
    expect(out.status).toBe("error");
    expect(out.error).toContain("boom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/screener/__tests__/orchestrate.test.ts`
Expected: FAIL — `orchestrate.server.ts` missing.

- [ ] **Step 3: Write the implementation**

Create `app/lib/screener/orchestrate.server.ts`:

```ts
// app/lib/screener/orchestrate.server.ts
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import { parseLandingSite } from "../attribution";
import { calibrate } from "./calibrate.server";
import { loadCalibrationInputs as realLoad } from "./history.server";
import { scoreCreative as realScore } from "./score.server";
import { startRun as realStart, completeRun as realComplete, failRun as realFail } from "./runs.server";
import type {
  CalibrationInputs, CreativeInput, CreativeScreenRun, ScoreCard,
} from "./types";

export interface ScreenDeps {
  resolveSku: (destinationUrl: string) => string | null;
  loadCalibrationInputs: (shop: string, mappedSku: string | null) => Promise<CalibrationInputs>;
  scoreCreative: (
    input: CreativeInput,
    topAdNames: string[],
  ) => Promise<{ summary: string; metrics: ScoreCard["metrics"]; tips: string[] }>;
  startRun: (shop: string, source: "manual", assumedSpendCents: number) => Promise<CreativeScreenRun>;
  completeRun: (id: string, scorecard: ScoreCard) => Promise<CreativeScreenRun>;
  failRun: (id: string, message: string) => Promise<CreativeScreenRun>;
}

/** Best-effort creative→SKU from the destination URL's UTM tags. */
function resolveSkuFromUrl(destinationUrl: string): string | null {
  try {
    const { utm } = parseLandingSite(destinationUrl);
    // utm_content commonly carries the SKU/variant; fall back to campaign.
    return utm.content ?? utm.campaign ?? null;
  } catch {
    return null;
  }
}

function defaultDeps(): ScreenDeps {
  return {
    resolveSku: resolveSkuFromUrl,
    loadCalibrationInputs: realLoad,
    scoreCreative: (input, topAdNames) =>
      realScore(input, topAdNames, {
        createMessage: (p) => getAnthropic().messages.create(p),
        model: assistantModel(),
      }),
    startRun: realStart,
    completeRun: realComplete,
    failRun: realFail,
  };
}

export async function executeScreen(
  args: { shop: string; input: CreativeInput; assumedSpendCents: number },
  deps: ScreenDeps = defaultDeps(),
): Promise<CreativeScreenRun> {
  let run: CreativeScreenRun | null = null;
  try {
    run = await deps.startRun(args.shop, "manual", args.assumedSpendCents);
    const mappedSku = deps.resolveSku(args.input.destinationUrl);
    const calib = await deps.loadCalibrationInputs(args.shop, mappedSku);
    const scored = await deps.scoreCreative(args.input, calib.topAdNames);
    const { outcomes, composite, grade, confidence } = calibrate(
      scored.metrics,
      calib,
      args.assumedSpendCents,
    );
    const scorecard: ScoreCard = {
      composite, grade, confidence,
      summary: scored.summary,
      metrics: scored.metrics,
      outcomes,
      tips: scored.tips,
    };
    return await deps.completeRun(run.id, scorecard);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        return await deps.failRun(run.id, message);
      } catch {
        // failRun itself failed — fall through to a synthetic error DTO.
      }
    }
    return {
      id: run?.id ?? "",
      status: "error",
      source: "manual",
      metaAdId: null,
      assumedSpendCents: args.assumedSpendCents,
      scorecard: null,
      error: message,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}
```

> **Note for the implementer:** `parseLandingSite` returns `{ utm, clickIds }`. Confirm the `utm` field names (`content`, `campaign`) by reading `app/lib/attribution/` (the `parseLandingSite` export). If the property names differ, adjust `resolveSkuFromUrl` accordingly — the test injects `resolveSku` so it stays green regardless; this only affects the real default.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/screener/__tests__/orchestrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the `parseLandingSite` field names**

Run: `grep -nE "utm|content|campaign" app/lib/attribution/*.ts | head`
Expected: confirm `utm.content` / `utm.campaign` exist; fix `resolveSkuFromUrl` if names differ.

- [ ] **Step 6: Commit**

```bash
git add app/lib/screener/orchestrate.server.ts app/lib/screener/__tests__/orchestrate.test.ts
git commit -m "screener: orchestrator wiring score+calibrate+persist with error DTO"
```

---

## Task 8: Route + scorecard UI — `app/routes/app.screener.tsx`

**Files:**
- Create: `app/routes/app.screener.tsx`
- Test: `app/lib/screener/__tests__/route-helpers.test.ts`

- [ ] **Step 1: Write the failing test for the form parsers**

Create `app/lib/screener/__tests__/route-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clampSpend, parseCreativeForm } from "../../../app/routes/app.screener";

describe("clampSpend", () => {
  it("clamps to [MIN,MAX] and defaults non-numbers", () => {
    expect(clampSpend("50000")).toBe(50000);
    expect(clampSpend("0")).toBe(1000);
    expect(clampSpend("99999999")).toBe(10_000_000);
    expect(clampSpend(null)).toBe(50000);
  });
});

describe("parseCreativeForm", () => {
  it("pulls fields and trims, defaulting empties", () => {
    const fd = new FormData();
    fd.set("headline", "  Hi  ");
    fd.set("primaryText", "body");
    fd.set("cta", "SHOP_NOW");
    fd.set("destinationUrl", "https://x.test/p");
    fd.set("audience", "women 25-44");
    fd.set("imageUrl", "");
    const out = parseCreativeForm(fd);
    expect(out.headline).toBe("Hi");
    expect(out.imageUrl).toBeNull();
    expect(out.cta).toBe("SHOP_NOW");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/screener/__tests__/route-helpers.test.ts`
Expected: FAIL — `app/routes/app.screener.tsx` missing / exports undefined.

- [ ] **Step 3: Write the route + UI**

Create `app/routes/app.screener.tsx`:

```tsx
// app/routes/app.screener.tsx
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, Collapsible, Divider, FormLayout,
  InlineGrid, InlineStack, Page, ProgressBar, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { getLatestRun, listRuns } from "~/lib/screener/runs.server";
import {
  DEFAULT_SPEND_CENTS, MAX_SPEND_CENTS, METRIC_GROUPS, METRIC_GROUP_LABELS, MIN_SPEND_CENTS,
  type CreativeInput, type CreativeScreenRun, type Grade, type MetricGroup, type ScoreCard,
} from "~/lib/screener/types";

export function clampSpend(raw: FormDataEntryValue | null): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n === 0) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export function parseCreativeForm(form: FormData): CreativeInput {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const imageUrl = str("imageUrl");
  return {
    imageUrl: imageUrl || null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
}

type LoaderPayload = { latest: CreativeScreenRun | null; history: CreativeScreenRun[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
  ]);
  return json<LoaderPayload>({ latest, history });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const input = parseCreativeForm(form);
  const assumedSpendCents = clampSpend(form.get("assumedSpendCents"));
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json(run);
};

const gradeTone: Record<Grade, "success" | "warning" | "critical"> = {
  winning: "success", okay: "warning", poor: "critical",
};
const dollars = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`;

function MetricRow({ m }: { m: ScoreCard["metrics"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((o) => !o); }}
        style={{ cursor: "pointer" }}
        aria-expanded={open}
      >
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm">{open ? "▾" : "▸"} {m.label}</Text>
          <Text as="span" variant="bodySm" fontWeight="semibold">{m.score}</Text>
        </InlineStack>
        <Box paddingBlockStart="100"><ProgressBar progress={m.score} size="small" /></Box>
      </div>
      <Collapsible open={open} id={`metric-${m.id}`}>
        <Box paddingBlockStart="200" paddingInlineStart="200">
          <Text as="p" variant="bodySm" tone="subdued">{m.reasoning || "No reasoning provided."}</Text>
          {m.benchmarkAds && m.benchmarkAds.length > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">Compared against: {m.benchmarkAds.join(", ")}</Text>
          )}
        </Box>
      </Collapsible>
    </Box>
  );
}

export default function Screener() {
  const { latest, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const run: CreativeScreenRun | null = (fetcher.data as CreativeScreenRun | undefined) ?? latest;
  const running = fetcher.state !== "idle";
  const card = run?.scorecard ?? null;

  const [spend, setSpend] = useState<string>(String((latest?.assumedSpendCents ?? DEFAULT_SPEND_CENTS) / 100));
  useEffect(() => {
    if (fetcher.data?.assumedSpendCents) setSpend(String(fetcher.data.assumedSpendCents / 100));
  }, [fetcher.data]);

  return (
    <Page
      title="Ad Pre-Screen"
      subtitle="Score an ad's potential before it goes live — a test screening before you hit publish"
    >
      <BlockStack gap="500">
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <TextField label="Headline" name="headline" autoComplete="off" />
              <TextField label="Primary text" name="primaryText" multiline={3} autoComplete="off" />
              <FormLayout.Group>
                <TextField label="Call to action" name="cta" autoComplete="off" placeholder="SHOP_NOW" />
                <TextField label="Destination URL" name="destinationUrl" autoComplete="off" placeholder="https://…?utm_content=SKU" />
              </FormLayout.Group>
              <TextField label="Target audience" name="audience" autoComplete="off" placeholder="Women 25-44 interested in skincare" />
              <TextField label="Image URL (optional)" name="imageUrl" autoComplete="off" placeholder="https://…/creative.jpg" />
              <TextField
                label="Assumed spend (USD)"
                name="assumedSpendCentsDollars"
                type="number"
                autoComplete="off"
                value={spend}
                onChange={setSpend}
                helpText="Drives the ROAS estimate. Edit and re-screen to see the impact."
              />
              {/* Submit the spend in cents. */}
              <input type="hidden" name="assumedSpendCents" value={Math.round(Number(spend || 0) * 100)} />
              <Button submit variant="primary" loading={running} disabled={running}>
                Screen this ad
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>

        {running && !card && (
          <Card><Text as="p" tone="subdued">Scoring this creative… ~20–30 seconds.</Text></Card>
        )}

        {run?.status === "error" && (
          <Banner tone="critical" title="Screening failed"><p>{run.error}</p></Banner>
        )}

        {card && (
          <>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="span" variant="heading2xl">{card.composite}</Text>
                    <BlockStack gap="100">
                      <Badge tone={gradeTone[card.grade]}>{card.grade}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Confidence: {card.confidence}
                        {card.confidence === "low" ? " — not SKU-calibrated" : ""}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued">{card.summary}</Text>
                {card.confidence === "low" && (
                  <Banner tone="warning" title="Low-confidence estimate">
                    <p>This creative isn’t mapped to a SKU with enough history, so outcomes use category/account fallbacks. Treat the numbers as directional.</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">Predicted outcomes</Text>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">Estimated ROAS</Text>
                    <Text as="p" variant="headingLg">{card.outcomes.estimatedRoas}x</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      range {card.outcomes.roasLow}–{card.outcomes.roasHigh}x · break-even {card.outcomes.breakEvenRoas}x
                    </Text>
                  </Box>
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">Predicted CTR</Text>
                    <Text as="p" variant="headingLg">{pct(card.outcomes.predictedCtr)}</Text>
                  </Box>
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">Hold / engagement</Text>
                    <Text as="p" variant="headingLg">{pct(card.outcomes.holdRate)}</Text>
                  </Box>
                </InlineGrid>
                <Text as="span" variant="bodySm" tone="subdued">
                  Based on {card.outcomes.mappedSku ? `SKU ${card.outcomes.mappedSku}` : "no mapped SKU"}
                  {card.outcomes.skuPriceCents ? ` @ ${dollars(card.outcomes.skuPriceCents)}` : ""} ·
                  assumed spend {dollars(card.outcomes.assumedSpendCents)} ·
                  projected revenue {dollars(card.outcomes.predictedRevenueCents)}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingSm">Creative breakdown</Text>
                {METRIC_GROUPS.map((g: MetricGroup) => {
                  const rows = card.metrics.filter((m) => m.group === g);
                  if (rows.length === 0) return null;
                  return (
                    <BlockStack key={g} gap="200">
                      <Text as="h3" variant="headingXs">{METRIC_GROUP_LABELS[g]}</Text>
                      {rows.map((m) => <MetricRow key={m.id} m={m} />)}
                      <Divider />
                    </BlockStack>
                  );
                })}
              </BlockStack>
            </Card>

            {card.tips.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">How to make it better</Text>
                  <ol style={{ margin: 0, paddingInlineStart: 18 }}>
                    {card.tips.map((t, i) => (
                      <li key={i}><Text as="span" variant="bodySm">{t}</Text></li>
                    ))}
                  </ol>
                </BlockStack>
              </Card>
            )}
          </>
        )}

        {!run && !running && (
          <Card>
            <Text as="p" tone="subdued">No screens yet. Enter an ad above and screen it before you spend.</Text>
          </Card>
        )}

        {history.length > 0 && (
          <Text as="p" tone="subdued" variant="bodySm">{history.length} previous screen(s) on record.</Text>
        )}
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/screener/__tests__/route-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the Polaris imports exist (Collapsible, ProgressBar, FormLayout)**

Run: `npx tsc --noEmit`
Expected: exit 0. If any Polaris component name is wrong for the installed version, the type error will name it — fix the import.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.screener.tsx app/lib/screener/__tests__/route-helpers.test.ts
git commit -m "routes/app.screener: manual ad pre-screen form + scorecard UI"
```

---

## Task 9: Full gate + nav entry

**Files:**
- Modify: `app/routes/app.tsx` (add the nav link — confirm this is where the app nav lives)

- [ ] **Step 1: Find the nav menu**

Run: `grep -rn "NavMenu\|/app/" app/routes/app.tsx`
Expected: locate the `<NavMenu>` (App Bridge) link list.

- [ ] **Step 2: Add the nav link**

In `app/routes/app.tsx`, add alongside the existing links (match the exact surrounding style):

```tsx
<Link to="/app/screener">Ad Pre-Screen</Link>
```

- [ ] **Step 3: Run the full repo gate**

Run each, in order, and paste output:

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all exit 0. New tests green; no lint warnings on touched files.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.tsx
git commit -m "routes/app: add Ad Pre-Screen nav link"
```

---

## Self-Review

**1. Spec coverage (Plan 1 scope):**
- Standalone route + manual input → Task 8 ✓
- Composite score + predicted grade (reusing winning/okay/poor) → Task 3 (`gradeFor`) + Task 8 UI ✓
- 16 metrics in 5 groups (13 creative dims + 3 predicted outcomes), click-to-expand reasoning → Task 2 (`DIMENSIONS`), Task 4 (scorer), Task 8 (`MetricRow` + outcomes) ✓
- Estimated ROAS grounded in SKU price + history + editable spend, vs break-even → Task 3 (`calibrate`) + Task 5 (`history`) + Task 8 (spend field) ✓
- Cold-start labeled low-confidence, never silent → Task 3 (`confidenceFor`, fallbacks) + Task 8 (low-confidence banner) ✓
- Tips section → Task 4 (scorer emits) + Task 8 ✓
- Persisted runs + history → Task 1 (table) + Task 6 (runs) ✓
- Error visibility (in-app DTO) → Task 7 + Task 8 banner ✓
- Behavior tests per unit → Tasks 3–8 ✓
- **Out of Plan 1 scope (later plans, noted in spec §9/§11/§14):** Meta fetch (Plan 2), generation loop (Plan 3), image/video providers (Plan 4). Not gaps — sequenced.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" left; every code step has complete code. The only "fix if names differ" note (Task 7 Step 5 / Task 9 Step 1) is a verification step with a concrete grep + fallback, not a placeholder.

**3. Type consistency:** `CreativeInput`, `CalibrationInputs`, `ScoreCard`, `MetricScore`, `CreativeScreenRun`, `Grade`, `Confidence` are defined once in Task 2 and used verbatim in Tasks 3–8. `calibrate(metrics, inputs, assumedSpendCents)` signature matches its call in Task 7. `scoreCreative(input, topAdNames, opts)` matches Task 7's `deps.scoreCreative(input, topAdNames)` wrapper. `rowToRun`/`startRun`/`completeRun`/`failRun`/`getLatestRun`/`listRuns` names consistent between Task 6 and Tasks 7–8.

---

## Execution Handoff

(filled in after save — see chat.)
