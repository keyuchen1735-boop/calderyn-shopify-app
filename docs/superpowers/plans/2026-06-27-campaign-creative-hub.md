# Campaign Creative Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute the four phases **in order** (1 → 4); each phase must end green on the pre-commit gate before the next begins.

**Goal:** Merge the ad Screener (Creative Predictor) and Generator into the Campaigns feature so every campaign carries a blended **Calderyn score** (`0.7·performance + 0.3·creative`), shows how to improve, can regenerate its weak creatives, can have new creatives dropped in to screen, and can push an improved creative to Meta as a paused draft — on **both** surfaces (dashboard SPA + embedded admin).

**Architecture:** A new **pure** server module `app/lib/campaign-score/` computes the blended score once — aggregate the per-ad screener scorecards (creative half) and blend with the engine's performance grade (performance half) — consumed identically by both surfaces (single source of truth, like `campaign-grade.ts`). Regeneration reuses the existing `app/lib/screener/` generate → re-score loop. The Meta paused-draft push is a new `push_creative_draft` ExecutableKind routed through the existing action executor, so it inherits idempotency, audit history, and undo (delete the draft). Phase 4 removes the now-redundant Predictor/Generator tabs and the dead code they leave behind.

**Tech Stack:** Remix (Vite) + React 18; Shopify Polaris (embedded admin) and a non-Polaris dashboard SPA; TypeScript (strict); vitest with dependency-injected fakes (never import the Anthropic SDK or hit real Meta in tests); Supabase (service-role server client); Meta Graph API v21.0 via `metaClientForShop`. Source spec: `docs/superpowers/specs/2026-06-27-campaign-creative-hub-design.md`.

**Feature isolation (CLAUDE.md):** do all work in a dedicated worktree `../calderyn-campaign-creative-hub` on branch `feat/campaign-creative-hub`. Symlink `node_modules` and `.env.local` from the main checkout so the gate runs (`ln -s …/node_modules`, `ln -s …/.env.local`). Remove the worktree after merge.

**Phase dependency:** 1 (score lib + surfacing) → 2 (creatives port + regenerate + drop-in) → 3 (Meta paused-draft push) → 4 (remove old tabs / dead code). Every phase ships on **both** surfaces and ends with `npm run typecheck` + `npm run lint` + `npm run build` + `npm run test` all exit 0 (paste output, never assert — rule 12).

**Two cross-phase notes the executor must hold (rule 7):**
- **Embedded score indicator is a Polaris `Badge`, not `ScorePill` (deliberate).** The design's locked contract says ScorePill replaces GradePill "on both surfaces," but `ScorePill` is the dashboard's non-Polaris primitive; the embedded admin must use Polaris (App Store review / CLAUDE.md). Both surfaces render the **same** `CampaignCalderynScore` DTO — the embedded side maps `band → Polaris tone`. This is the single intentional deviation from the literal contract; it is called out for sign-off, not a defect.
- **The creative half rides the screener's fallback calibration.** Real account history (the prior handoff's "Increment B": live CTR/CPM/CVR/ad-count) is not wired, so the creative score is advisory. Out of scope here — do not block on it.

---

## File structure (authoritative per-phase Files blocks live in each phase below)

**Created (28)** — grouped:
- **Score module (pure + resolver):** `app/lib/campaign-score/{types.ts, aggregate.server.ts, blend.server.ts, resolve.server.ts}` (Phase 1)
- **UI:** `app/components/dashboard/score-pill.ts` (Phase 1), `app/components/dashboard/AdScorecardPanel.tsx` (Phase 2)
- **Screener reuse:** `app/lib/screener/{campaign-regen.server.ts, campaign-creatives-load.server.ts}` (Phase 2)
- **Meta write + executor:** `app/lib/meta/ad-create.server.ts`, `app/lib/actions/push-draft.server.ts` (Phase 3)
- **Routes — dashboard API:** `app/routes/dashboard.api.campaigns.$id.{creatives,score,regenerate,screen}.tsx` (Phase 2)
- **Routes — embedded resource actions:** `app/routes/app.campaigns.$campaignId.{regenerate,screen}.tsx` (Phase 2)
- **Migration:** `supabase/migrations/20260627121000_integration_credentials_scopes.sql` (Phase 3; single-file — `integration_credentials` is not in the engine-schema fixture, so **no** `tests/engine/schema/migrations` mirror)
- **Tests (~10):** alongside each module under `__tests__/` (vitest)

**Deleted (7, all Phase 4):** `app/routes/app.screener.tsx`, `app/routes/app.generator.tsx`, `app/routes/dashboard.api.screener.tsx`, `app/components/dashboard/screens/Predictor.tsx`, `app/components/dashboard/screens/Generator.tsx`, `app/lib/screener/__tests__/generator-route.test.ts`, `app/lib/dashboard/__tests__/adapt-screen-run.test.ts`. **Kept:** all of `app/lib/screener/**` (now consumed inside Campaigns) and the `ScreenCreativePayload` type (reused by `screenCampaignCreative`).

**High-traffic modified files (touched across multiple phases):**
- `app/components/dashboard/screens/Campaigns.tsx` — Phases 1, 2, 3 (ScorePill row + detail sections → Creatives/Regenerate/Screen → Push button)
- `app/routes/app.campaigns.$campaignId.tsx` — Phases 1, 2, 3 (embedded mirror of the above)
- `app/lib/dashboard/client.ts` — Phases 1, 2, 3, 4 (DTO threading → new fetchers → push dispatch → dead-fn pruning)
- `app/lib/types.ts` — Phases 1, 3 (`calderynScore` DTO field → push capability)
- `app/lib/actions/execute.server.ts` + `app/lib/actions/undo.server.ts` — Phase 3 (`push_creative_draft` kind + undo)

---

## Phase 1: Calderyn score (lib + list/detail surfacing)

**Goal:** Ship the pure, server-side Calderyn score module (`aggregate` → `blend` → `resolve`), the shared `ScorePill` primitive, and the score surfacing (list pill + detail "Score breakdown" / "How to improve") on **both** surfaces — dashboard SPA and embedded admin — with full TDD on every pure unit and the DI resolver.

**Preconditions:** all work happens in the feature worktree `../calderyn-campaign-creative-hub` on branch `feat/campaign-creative-hub` (per CLAUDE.md feature isolation; created in the parent plan). Every path below is relative to that worktree root.

**Design decisions surfaced (rule 7 — read before coding):**
- **D1 — active/paused filter lives in `resolve.server.ts`, not `aggregateAdScorecards`.** `AdScorecard` (in `app/lib/screener/campaign-ads.server.ts:11`) carries no active/paused flag (its `status` is the *scoring* status `"done"|"error"`). So `aggregateAdScorecards` is pure over whatever `AdScorecard[]` it is handed; it averages scored cards (`status === "done" && scorecard != null`). `resolveCampaignScore` is what excludes paused ads — it only loads cached scorecards for the campaign's **active** ad ids, so paused ads never reach the aggregate. The "all paused" case therefore reduces to "resolve passes `[]` → `creativeComposite: null`".
- **D2 — authoritative coverage total comes from `resolve`, not `aggregate`.** The cache-only loader (`loadCachedAdScorecards`) *omits* unscored ads, so `aggregate.coverage.total` only counts the rows it was given. `resolveCampaignScore` overrides `total` with the real active-ad count when it calls `blendScore`, so `adsTotal` reflects active ads and `adsCovered` reflects scored active ads.
- **D3 — creative-half availability differs per surface in Phase 1 (stated single-sided timing per CLAUDE.md).** The **embedded detail** loader already fetches `creatives` (with per-ad status) and cached `scorecards`, so it computes the **full** P+C+weakDimensions+tips score in Phase 1 with zero extra I/O (it injects the already-loaded scorecards via DI). The **dashboard loaders** and the **embedded list** loader compute a **performance-led** score in Phase 1 (`ads: []` → creative half resolves only where creatives are already loaded; the dashboard creatives fetch is ported in **Phase 2**). Both lists (dashboard + embedded) render the score as the row's primary indicator (band-driven color); both detail headers carry the same indicator. The dashboard's "How to improve" shows an honest empty/"score pending" state until Phase 2. This matches the spec's own §11 phasing and §11 "List performance" risk acceptance.
- **D4 — surface-native indicator, one DTO.** Per CLAUDE.md, the dashboard SPA uses the new `ScorePill` (non-Polaris) primitive; the embedded admin (App Store review constraint) renders the *same* `CampaignCalderynScore` DTO through a Polaris `<Badge>` whose tone is mapped from `band`. The band→tone map is a small per-route const on the embedded side (mirrors the existing `DIRECTION_BADGE` per-route-const precedent in `app.campaigns.$campaignId.tsx`).

**Files**
- Create: `app/lib/campaign-score/types.ts`
- Create: `app/lib/campaign-score/aggregate.server.ts`
- Create: `app/lib/campaign-score/blend.server.ts`
- Create: `app/lib/campaign-score/resolve.server.ts`
- Create: `app/components/dashboard/score-pill.ts`
- Modify: `app/components/dashboard/ui.tsx` (add `ScorePill` next to `GradePill`)
- Modify: `app/lib/types.ts` (`Campaign` DTO: `calderynScore`)
- Modify: `app/components/dashboard/view-models.ts` (`CampaignVM`: `calderynScore`)
- Modify: `app/lib/dashboard/client.ts` (`adaptCampaign` threading)
- Modify: `app/routes/dashboard.api.campaigns._index.tsx` (list loader attaches score)
- Modify: `app/routes/dashboard.api.campaigns.$id.tsx` (detail loader attaches score)
- Modify: `app/components/dashboard/screens/Campaigns.tsx` (row pill swap + detail sections)
- Modify: `app/routes/app.campaigns._index.tsx` (embedded list loader attaches score; row Badge — both render paths)
- Modify: `app/routes/app.campaigns.$campaignId.tsx` (detail loader computes score; header badge + detail cards)
- Test: `app/lib/campaign-score/__tests__/types.test.ts`
- Test: `app/lib/campaign-score/__tests__/aggregate.test.ts`
- Test: `app/lib/campaign-score/__tests__/blend.test.ts`
- Test: `app/lib/campaign-score/__tests__/resolve.test.ts`
- Test: `app/components/dashboard/__tests__/score-pill.test.ts`
- Test: `app/lib/dashboard/__tests__/adapt-campaign.test.ts`

---

### Task 1.1: Lock the score constants + DTO (`types.ts`)

**Files**
- Create: `app/lib/campaign-score/types.ts`
- Test: `app/lib/campaign-score/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test.** It pins the locked numeric contract so it can't silently drift.

```ts
// app/lib/campaign-score/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import {
  PERF_WEIGHT,
  CREATIVE_WEIGHT,
  STRONG_MIN,
  FAIR_MIN,
  PERF_ANCHOR,
} from "../types";

describe("campaign-score constants", () => {
  it("locks the blend weighting, band thresholds, and perf anchor", () => {
    expect(PERF_WEIGHT).toBe(0.7);
    expect(CREATIVE_WEIGHT).toBe(0.3);
    expect(PERF_WEIGHT + CREATIVE_WEIGHT).toBe(1);
    expect(STRONG_MIN).toBe(75);
    expect(FAIR_MIN).toBe(55);
    expect(PERF_ANCHOR).toBe(50);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/lib/campaign-score/__tests__/types.test.ts
```

Expected failure: `Error: Failed to load url ../types` (the module does not exist yet) → the suite errors out.

- [ ] **Step 3: Write the minimal implementation.**

```ts
// app/lib/campaign-score/types.ts
// The Calderyn score DTO + its tunable constants. Pure types/values — safe to
// import on the server (aggregate/blend/resolve) and in browser type positions
// (CampaignVM, the Campaign DTO). No I/O, no .server dependency.

export interface CampaignCalderynScore {
  value: number | null; // blended 0–100, null when band === "nodata"
  band: "strong" | "fair" | "weak" | "nodata";
  performance: number | null; // P
  creative: number | null; // C
  confidence: "high" | "medium" | "low";
  weakDimensions: { label: string; score: number; adId: string }[];
  tips: string[];
  adsCovered: number;
  adsTotal: number;
}

// Blend weighting — performance-led (locked design decision §2.6).
export const PERF_WEIGHT = 0.7;
export const CREATIVE_WEIGHT = 0.3;

// Band thresholds on the blended 0–100 value.
export const STRONG_MIN = 75; // value >= STRONG_MIN => "strong"
export const FAIR_MIN = 55; // value >= FAIR_MIN => "fair", else "weak"

// Performance normalization: break-even ROAS anchors at 50; a 2× return
// saturates at 100. P = clamp(round(PERF_ANCHOR * roas / breakEven), 0, 100).
export const PERF_ANCHOR = 50;
```

- [ ] **Step 4: Run the test and see it pass.**

```bash
npx vitest run app/lib/campaign-score/__tests__/types.test.ts
```

Expected: `Test Files 1 passed (1)`, `Tests 1 passed (1)`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/campaign-score/types.ts app/lib/campaign-score/__tests__/types.test.ts
git commit -m "lib/campaign-score: add CampaignCalderynScore DTO + locked constants"
```

---

### Task 1.2: `aggregateAdScorecards` — pure creative-half fold

**Files**
- Create: `app/lib/campaign-score/aggregate.server.ts`
- Test: `app/lib/campaign-score/__tests__/aggregate.test.ts`

- [ ] **Step 1: Write the failing test.** Covers zero ads, mean of scored ads with an error row excluded (covered/total), weak-dimension collection tagged with `adId` and sorted ascending, and tip dedup by title.

```ts
// app/lib/campaign-score/__tests__/aggregate.test.ts
import { describe, it, expect } from "vitest";
import { aggregateAdScorecards } from "../aggregate.server";
import type { AdScorecard } from "~/lib/screener/campaign-ads.server";
import type { ScoreCard, MetricScore } from "~/lib/screener/types";

function metric(label: string, score: number): MetricScore {
  return { id: label.toLowerCase().replace(/\s+/g, "_"), group: "attention", label, score, reasoning: "" };
}
function card(composite: number, metrics: MetricScore[], tips: ScoreCard["tips"]): ScoreCard {
  return {
    composite,
    grade: "okay",
    confidence: "high",
    summary: "",
    metrics,
    outcomes: {
      estimatedRoas: 0, roasLow: 0, roasHigh: 0, breakEvenRoas: 0,
      predictedCtr: 0, holdRate: 0, assumedSpendCents: 0, predictedRevenueCents: 0,
      mappedSku: null, skuPriceCents: null,
    },
    tips,
  };
}
function done(adId: string, composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): AdScorecard {
  return { adId, status: "done", scorecard: card(composite, metrics, tips), error: null };
}
function errored(adId: string): AdScorecard {
  return { adId, status: "error", scorecard: null, error: "boom" };
}

describe("aggregateAdScorecards", () => {
  it("returns null composite + zero coverage for zero ads", () => {
    expect(aggregateAdScorecards([])).toEqual({
      creativeComposite: null, weakDimensions: [], tips: [], coverage: { covered: 0, total: 0 },
    });
  });

  it("means scored composites; errors are excluded from the mean but counted in total", () => {
    const agg = aggregateAdScorecards([done("a1", 80), done("a2", 60), errored("a3")]);
    expect(agg.creativeComposite).toBe(70);
    expect(agg.coverage).toEqual({ covered: 2, total: 3 });
  });

  it("collects weak dimensions (<65) across ads, tagged with adId, sorted ascending", () => {
    const agg = aggregateAdScorecards([
      done("a1", 70, [metric("Hook strength", 40), metric("CTA strength", 90)]),
      done("a2", 55, [metric("Headline clarity", 50)]),
    ]);
    expect(agg.weakDimensions).toEqual([
      { label: "Hook strength", score: 40, adId: "a1" },
      { label: "Headline clarity", score: 50, adId: "a2" },
    ]);
  });

  it("dedupes tips across ads by normalized title", () => {
    const agg = aggregateAdScorecards([
      done("a1", 70, [], ["Tighten the hook", "Add social proof"]),
      done("a2", 70, [], ["Tighten the hook"]),
    ]);
    expect(agg.tips).toEqual(["Tighten the hook", "Add social proof"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/lib/campaign-score/__tests__/aggregate.test.ts
```

Expected failure: `Error: Failed to load url ../aggregate.server` (module not created yet).

- [ ] **Step 3: Write the minimal implementation.** No non-null assertions (keeps `eslint --max-warnings=0` clean) — narrow once via `flatMap`.

```ts
// app/lib/campaign-score/aggregate.server.ts
// PURE (no I/O): fold a campaign's per-ad creative scorecards into a single
// creative half (mean composite), plus the aggregated weak dimensions and tips
// that drive the "How to improve" section. Errored/unscored cards are excluded
// from the mean but counted in coverage.total (rule 12 — surface the gap).
// NOTE (D1): paused-ad exclusion happens upstream in resolve.server.ts; this
// function averages whatever AdScorecard[] it is handed.
import type { AdScorecard } from "../screener/campaign-ads.server";
import type { ScoreCard } from "../screener/types";
import { normalizeTip } from "../screener/types";

const WEAK_DIMENSION_MAX = 65; // mirrors generate.server.ts weakMetrics cutoff
const WEAK_DIMENSION_LIMIT = 5;
const TIP_LIMIT = 5;

export function aggregateAdScorecards(ads: AdScorecard[]): {
  creativeComposite: number | null;
  weakDimensions: { label: string; score: number; adId: string }[];
  tips: string[];
  coverage: { covered: number; total: number };
} {
  const total = ads.length;
  const scored: { adId: string; card: ScoreCard }[] = ads.flatMap((a) =>
    a.status === "done" && a.scorecard != null ? [{ adId: a.adId, card: a.scorecard }] : [],
  );
  const coverage = { covered: scored.length, total };

  if (scored.length === 0) {
    return { creativeComposite: null, weakDimensions: [], tips: [], coverage };
  }

  const sum = scored.reduce((acc, s) => acc + s.card.composite, 0);
  const creativeComposite = Math.round(sum / scored.length);

  const weakDimensions = scored
    .flatMap((s) =>
      s.card.metrics
        .filter((m) => m.score < WEAK_DIMENSION_MAX)
        .map((m) => ({ label: m.label, score: m.score, adId: s.adId })),
    )
    .sort((x, y) => x.score - y.score)
    .slice(0, WEAK_DIMENSION_LIMIT);

  const seen = new Set<string>();
  const tips: string[] = [];
  for (const s of scored) {
    for (const t of s.card.tips) {
      const title = normalizeTip(t).title.trim();
      if (title && !seen.has(title)) {
        seen.add(title);
        tips.push(title);
      }
    }
  }

  return { creativeComposite, weakDimensions, tips: tips.slice(0, TIP_LIMIT), coverage };
}
```

- [ ] **Step 4: Run the test and see it pass.**

```bash
npx vitest run app/lib/campaign-score/__tests__/aggregate.test.ts
```

Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/campaign-score/aggregate.server.ts app/lib/campaign-score/__tests__/aggregate.test.ts
git commit -m "lib/campaign-score: pure aggregateAdScorecards (mean composite, weak dims, tips, coverage)"
```

---

### Task 1.3: `blendScore` — pure 0.7/0.3 blend + bands + confidence

**Files**
- Create: `app/lib/campaign-score/blend.server.ts`
- Test: `app/lib/campaign-score/__tests__/blend.test.ts`

- [ ] **Step 1: Write the failing test.** Covers weighting math (0.7/0.3), each one-half-null path, both-null `nodata`, band thresholds at 75/55, the `perfIsNodata`/missing-half confidence ladder, and the coverage→adsCovered/adsTotal passthrough.

```ts
// app/lib/campaign-score/__tests__/blend.test.ts
import { describe, it, expect } from "vitest";
import { blendScore } from "../blend.server";

const cov = (covered: number, total: number) => ({ covered, total });

describe("blendScore", () => {
  it("weights 0.7 performance / 0.3 creative when both present", () => {
    const s = blendScore({ performance: 80, creative: 40, coverage: cov(2, 2), perfIsNodata: false });
    expect(s.value).toBe(68); // round(0.7*80 + 0.3*40) = 68
    expect(s.band).toBe("fair");
    expect(s.performance).toBe(80);
    expect(s.creative).toBe(40);
    expect(s.confidence).toBe("high");
  });

  it("scores on performance alone when creative is null (a missing half ⇒ low confidence)", () => {
    const s = blendScore({ performance: 82, creative: null, coverage: cov(0, 0), perfIsNodata: false });
    expect(s.value).toBe(82);
    expect(s.band).toBe("strong");
    expect(s.confidence).toBe("low");
  });

  it("scores on creative alone when performance is null", () => {
    const s = blendScore({ performance: null, creative: 40, coverage: cov(2, 2), perfIsNodata: false });
    expect(s.value).toBe(40);
    expect(s.band).toBe("weak");
    expect(s.confidence).toBe("medium");
  });

  it("is nodata with a null value when both halves are null", () => {
    const s = blendScore({ performance: null, creative: null, coverage: cov(0, 0), perfIsNodata: true });
    expect(s.value).toBeNull();
    expect(s.band).toBe("nodata");
    expect(s.confidence).toBe("low");
  });

  it("applies band thresholds at 75 (strong) and 55 (fair)", () => {
    const band = (v: number) =>
      blendScore({ performance: null, creative: v, coverage: cov(1, 1), perfIsNodata: false }).band;
    expect(band(75)).toBe("strong");
    expect(band(74)).toBe("fair");
    expect(band(55)).toBe("fair");
    expect(band(54)).toBe("weak");
  });

  it("passes coverage through to adsCovered/adsTotal and leaves weakDimensions/tips empty", () => {
    const s = blendScore({ performance: 80, creative: 60, coverage: cov(2, 3), perfIsNodata: false });
    expect(s.adsCovered).toBe(2);
    expect(s.adsTotal).toBe(3);
    expect(s.weakDimensions).toEqual([]);
    expect(s.tips).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/lib/campaign-score/__tests__/blend.test.ts
```

Expected failure: `Error: Failed to load url ../blend.server`.

- [ ] **Step 3: Write the minimal implementation.**

```ts
// app/lib/campaign-score/blend.server.ts
// PURE (no I/O): blend the performance half (P) and creative half (C) into the
// CampaignCalderynScore. All score arithmetic lives here (rule 5 — deterministic
// code does the math, the model does none). weakDimensions/tips are filled by
// resolve from the aggregate; blend starts them empty.
import type { CampaignCalderynScore } from "./types";
import { PERF_WEIGHT, CREATIVE_WEIGHT, STRONG_MIN, FAIR_MIN } from "./types";

export function blendScore(input: {
  performance: number | null;
  creative: number | null;
  coverage: { covered: number; total: number };
  perfIsNodata: boolean;
}): CampaignCalderynScore {
  const { performance, creative, coverage, perfIsNodata } = input;

  let value: number | null;
  if (performance != null && creative != null) {
    value = Math.round(PERF_WEIGHT * performance + CREATIVE_WEIGHT * creative);
  } else if (performance != null) {
    value = Math.round(performance);
  } else if (creative != null) {
    value = Math.round(creative);
  } else {
    value = null;
  }

  return {
    value,
    band: bandFor(value),
    performance,
    creative,
    confidence: confidenceFor(performance, creative, coverage, perfIsNodata),
    weakDimensions: [],
    tips: [],
    adsCovered: coverage.covered,
    adsTotal: coverage.total,
  };
}

function bandFor(value: number | null): CampaignCalderynScore["band"] {
  if (value == null) return "nodata";
  if (value >= STRONG_MIN) return "strong";
  if (value >= FAIR_MIN) return "fair";
  return "weak";
}

// Confidence is driven by ad coverage and whether each half is real. A missing
// or nodata half is never treated as "real", so it caps confidence (spec §3:
// "a low-confidence banner shows when coverage is thin or a half is missing").
function confidenceFor(
  performance: number | null,
  creative: number | null,
  coverage: { covered: number; total: number },
  perfIsNodata: boolean,
): CampaignCalderynScore["confidence"] {
  const ratio = coverage.total > 0 ? coverage.covered / coverage.total : 0;
  const perfReal = performance != null && !perfIsNodata;
  const creativeReal = creative != null;
  if (perfReal && creativeReal && ratio >= 0.8) return "high";
  if ((perfReal || creativeReal) && ratio >= 0.4) return "medium";
  return "low";
}
```

- [ ] **Step 4: Run the test and see it pass.**

```bash
npx vitest run app/lib/campaign-score/__tests__/blend.test.ts
```

Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/campaign-score/blend.server.ts app/lib/campaign-score/__tests__/blend.test.ts
git commit -m "lib/campaign-score: pure blendScore (0.7/0.3 blend, bands, confidence)"
```

---

### Task 1.4: `resolveCampaignScore` — DI resolver (cached scorecards + grade row)

**Files**
- Create: `app/lib/campaign-score/resolve.server.ts`
- Test: `app/lib/campaign-score/__tests__/resolve.test.ts`

> The resolver value-imports `loadCachedAdScorecards` from `app/lib/screener/campaign-ads.server.ts` (for `defaultDeps()`). That chain (`campaign-ads.server` → `orchestrate.server`/`runs.server`) performs **no module-scope I/O** — every `getSupabase()` / Anthropic client is constructed lazily inside functions — so importing `resolve.server.ts` under the node-only vitest harness is safe (the existing `screener/__tests__/{campaign-ads,orchestrate,runs}.test.ts` import the same chain). The tests inject a fake loader via `deps`, so the real loader is never invoked.

- [ ] **Step 1: Write the failing test.** A fake cached-scorecard loader + a `CampaignGradeRow` exercises: active-only ad loading (D1), P-normalization (anchor 50, 2× saturation), D2 coverage total, nodata→`P=null`, never-throws on loader failure, and the `gradeRowFromPerformance` helper used by the embedded loader.

```ts
// app/lib/campaign-score/__tests__/resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveCampaignScore, gradeRowFromPerformance } from "../resolve.server";
import type { AdScorecard } from "~/lib/screener/campaign-ads.server";
import type { ScoreCard, MetricScore } from "~/lib/screener/types";
import type { CampaignGradeRow } from "~/lib/types";
import { gradeFromRow } from "~/lib/campaign-grade";

function card(composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): ScoreCard {
  return {
    composite, grade: "okay", confidence: "high", summary: "", metrics,
    outcomes: {
      estimatedRoas: 0, roasLow: 0, roasHigh: 0, breakEvenRoas: 0,
      predictedCtr: 0, holdRate: 0, assumedSpendCents: 0, predictedRevenueCents: 0,
      mappedSku: null, skuPriceCents: null,
    },
    tips,
  };
}
function done(adId: string, composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): AdScorecard {
  return { adId, status: "done", scorecard: card(composite, metrics, tips), error: null };
}
const grade = (over: Partial<CampaignGradeRow> = {}): CampaignGradeRow => ({
  campaign_id: "c1", name: "C", grade: "", roas: 4, break_even_roas: 2,
  spend_cents: 10000, revenue_cents: 40000, day_bucket: "2026-06-27", ...over,
});

describe("resolveCampaignScore", () => {
  it("blends P and cached C, loading ONLY active ad ids; adsTotal = active count", async () => {
    const loader = vi.fn(async (_shop: string, ids: string[]) => ids.map((id) => done(id, 80)));
    const score = await resolveCampaignScore(
      "shop",
      { id: "c1", ads: [{ adId: "a1", status: "active" }, { adId: "a2", status: "paused" }] },
      grade(),
      { loadCachedAdScorecards: loader },
    );
    expect(loader).toHaveBeenCalledWith("shop", ["a1"]);
    expect(score.performance).toBe(100); // clamp(round(50*4/2),0,100) = 100
    expect(score.creative).toBe(80);
    expect(score.value).toBe(94); // round(0.7*100 + 0.3*80)
    expect(score.band).toBe("strong");
    expect(score.adsCovered).toBe(1);
    expect(score.adsTotal).toBe(1);
  });

  it("skips the loader and returns performance-only when there are no active ads", async () => {
    const loader = vi.fn(async () => [] as AdScorecard[]);
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "p", status: "paused" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(loader).not.toHaveBeenCalled();
    expect(score.creative).toBeNull();
    expect(score.performance).toBe(100);
    expect(score.value).toBe(100);
  });

  it("maps a nodata grade row (spend, zero attributed revenue) to P = null", async () => {
    const loader = vi.fn(async (_s: string, ids: string[]) => ids.map((id) => done(id, 60)));
    const row = grade({ roas: 0, revenue_cents: 0, spend_cents: 10000 });
    expect(gradeFromRow(row)).toBe("nodata");
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, row, { loadCachedAdScorecards: loader },
    );
    expect(score.performance).toBeNull();
    expect(score.creative).toBe(60);
    expect(score.value).toBe(60);
  });

  it("never throws when the cached loader rejects — creative half degrades to null", async () => {
    const loader = vi.fn(async () => { throw new Error("supabase down"); });
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(score.creative).toBeNull();
    expect(score.performance).toBe(100);
  });

  it("forwards aggregated weakDimensions + tips from active scored ads", async () => {
    const m: MetricScore = { id: "hook", group: "attention", label: "Hook strength", score: 40, reasoning: "" };
    const loader = vi.fn(async (_s: string, ids: string[]) => ids.map((id) => done(id, 70, [m], ["Tighten the hook"])));
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(score.weakDimensions).toEqual([{ label: "Hook strength", score: 40, adId: "a1" }]);
    expect(score.tips).toEqual(["Tighten the hook"]);
  });

  it("gradeRowFromPerformance yields nodata when spend exists but ROAS is 0", () => {
    const row = gradeRowFromPerformance({ campaignId: "c1", name: "C", roas: 0, breakEvenRoas: 0, spendCents: 5000 });
    expect(row.revenue_cents).toBe(0);
    expect(gradeFromRow(row)).toBe("nodata");
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/lib/campaign-score/__tests__/resolve.test.ts
```

Expected failure: `Error: Failed to load url ../resolve.server`.

- [ ] **Step 3: Write the minimal implementation.** `CampaignLike` and `ResolveScoreDeps` are the new types named in the locked contract.

```ts
// app/lib/campaign-score/resolve.server.ts
// Resolve a campaign's blended Calderyn score from CACHED ad scorecards + its
// grade row. Loads only ACTIVE ads' cached scorecards (D1), supplies the
// authoritative coverage total (D2), maps the performance half from the grade
// row, and blends. Never throws — a failed cache read degrades the creative half
// to null rather than breaking the caller (rule 12). DI via `deps` for tests.
import { gradeFromRow } from "../campaign-grade";
import type { CampaignGradeRow } from "../types";
import type { AdScorecard } from "../screener/campaign-ads.server";
import { loadCachedAdScorecards as realLoadCached } from "../screener/campaign-ads.server";
import { aggregateAdScorecards } from "./aggregate.server";
import { blendScore } from "./blend.server";
import { PERF_ANCHOR } from "./types";
import type { CampaignCalderynScore } from "./types";

/** Minimal campaign shape resolve needs: its id + its ads with active/paused. */
export interface CampaignLike {
  id: string;
  ads: { adId: string; status: "active" | "paused" }[];
}

/** Injected dependency seam (tests pass a fake cached-scorecard loader). */
export interface ResolveScoreDeps {
  loadCachedAdScorecards: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
}

function defaultDeps(): ResolveScoreDeps {
  return { loadCachedAdScorecards: realLoadCached };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Synthesize a CampaignGradeRow from a campaign's live performance numbers (used
 * by the embedded loader, which has CampaignPerformance, not a grade row).
 * revenue = roas × spend, so when there is spend but no usable ROAS the row
 * resolves to "nodata" through gradeFromRow — never a fabricated revenue.
 */
export function gradeRowFromPerformance(args: {
  campaignId: string;
  name: string;
  roas: number;
  breakEvenRoas: number;
  spendCents: number;
}): CampaignGradeRow {
  const roas = Number.isFinite(args.roas) && args.roas > 0 ? args.roas : 0;
  const spendCents = Number.isFinite(args.spendCents) && args.spendCents > 0 ? args.spendCents : 0;
  const breakEven = Number.isFinite(args.breakEvenRoas) && args.breakEvenRoas > 0 ? args.breakEvenRoas : 0;
  return {
    campaign_id: args.campaignId,
    name: args.name,
    grade: "",
    roas,
    break_even_roas: breakEven,
    spend_cents: spendCents,
    revenue_cents: Math.round(roas * spendCents),
    day_bucket: "",
  };
}

export async function resolveCampaignScore(
  shop: string,
  campaign: CampaignLike,
  gradeRow: CampaignGradeRow | undefined,
  deps: ResolveScoreDeps = defaultDeps(),
): Promise<CampaignCalderynScore> {
  // D1: only active ads contribute to the creative half. Paused ads aren't
  // running, so their creatives never enter the aggregate.
  const activeAdIds = campaign.ads
    .filter((a) => a.status === "active")
    .map((a) => a.adId)
    .filter((id) => id.length > 0);

  let scorecards: AdScorecard[] = [];
  if (activeAdIds.length > 0) {
    try {
      scorecards = await deps.loadCachedAdScorecards(shop, activeAdIds);
    } catch {
      scorecards = []; // rule 12: degrade the creative half, never throw.
    }
  }

  const agg = aggregateAdScorecards(scorecards);

  // Performance half. nodata (spend but zero attributed revenue) or a missing /
  // non-positive break-even both yield P = null — never fabricate (rule 12).
  const perfIsNodata = gradeRow ? gradeFromRow(gradeRow) === "nodata" : false;
  let performance: number | null = null;
  if (gradeRow && !perfIsNodata && gradeRow.break_even_roas > 0) {
    performance = clamp(Math.round((PERF_ANCHOR * gradeRow.roas) / gradeRow.break_even_roas), 0, 100);
  }

  const blended = blendScore({
    performance,
    creative: agg.creativeComposite,
    // D2: the cache-only loader omits unscored ads, so the authoritative total
    // is the active-ad count, not agg.coverage.total.
    coverage: { covered: agg.coverage.covered, total: activeAdIds.length },
    perfIsNodata,
  });

  return { ...blended, weakDimensions: agg.weakDimensions, tips: agg.tips };
}
```

- [ ] **Step 4: Run the test and see it pass.**

```bash
npx vitest run app/lib/campaign-score/__tests__/resolve.test.ts
```

Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/campaign-score/resolve.server.ts app/lib/campaign-score/__tests__/resolve.test.ts
git commit -m "lib/campaign-score: resolveCampaignScore (active-only cache load, grade-row P, never throws)"
```

---

### Task 1.5: `ScorePill` primitive (band → color)

**Files**
- Create: `app/components/dashboard/score-pill.ts` (pure, testable band→tone/label)
- Modify: `app/components/dashboard/ui.tsx` (the `ScorePill` component, sibling of `GradePill`)
- Test: `app/components/dashboard/__tests__/score-pill.test.ts`

> The vitest harness is node-only and its glob is `app/**/*.test.ts` (no `.tsx`, no jsdom) — see recon. So the band→color/label *logic* lives in a pure `.ts` (`score-pill.ts`) and is unit-tested; the thin `.tsx` `ScorePill` just calls it and is verified by `tsc`/`build`.

- [ ] **Step 1: Write the failing test.**

```ts
// app/components/dashboard/__tests__/score-pill.test.ts
import { describe, it, expect } from "vitest";
import { scorePillStyle } from "../score-pill";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const s = (over: Partial<CampaignCalderynScore>): CampaignCalderynScore => ({
  value: 70, band: "fair", performance: 70, creative: 70, confidence: "high",
  weakDimensions: [], tips: [], adsCovered: 1, adsTotal: 1, ...over,
});

describe("scorePillStyle", () => {
  it("maps each scored band to its tone and shows 'value · Band'", () => {
    expect(scorePillStyle(s({ value: 82, band: "strong" }))).toEqual({ label: "82 · Strong", tone: "success" });
    expect(scorePillStyle(s({ value: 60, band: "fair" }))).toEqual({ label: "60 · Fair", tone: "warn" });
    expect(scorePillStyle(s({ value: 40, band: "weak" }))).toEqual({ label: "40 · Weak", tone: "critical" });
  });

  it("shows 'Score pending' with a neutral tone when value is null (nodata)", () => {
    expect(scorePillStyle(s({ value: null, band: "nodata" }))).toEqual({ label: "Score pending", tone: "neutral" });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/components/dashboard/__tests__/score-pill.test.ts
```

Expected failure: `Error: Failed to load url ../score-pill`.

- [ ] **Step 3: Write the minimal implementation.** First the pure helper:

```ts
// app/components/dashboard/score-pill.ts
// Pure band → Pill tone/label mapping for the Calderyn ScorePill. Kept in a .ts
// (no React) so the band-drives-color logic is unit-testable under the node-only
// vitest harness. ScorePill (ui.tsx) renders <Pill> from this.
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

export type ScorePillTone = "neutral" | "success" | "critical" | "warn";

const BAND_STYLE: Record<CampaignCalderynScore["band"], { label: string; tone: ScorePillTone }> = {
  strong: { label: "Strong", tone: "success" },
  fair: { label: "Fair", tone: "warn" },
  weak: { label: "Weak", tone: "critical" },
  nodata: { label: "Score pending", tone: "neutral" },
};

export function scorePillStyle(score: CampaignCalderynScore): { label: string; tone: ScorePillTone } {
  const base = BAND_STYLE[score.band];
  if (score.value == null) return { label: base.label, tone: base.tone };
  return { label: `${score.value} · ${base.label}`, tone: base.tone };
}
```

Then add `ScorePill` to `app/components/dashboard/ui.tsx`. Add the two imports near the top of the file (alongside the existing imports):

```tsx
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import { scorePillStyle } from "./score-pill";
```

And insert the component immediately after the existing `GradePill` function (which starts at L160):

```tsx
/**
 * The single primary campaign indicator: the blended Calderyn score (0–100 +
 * band), band-driven color. Replaces GradePill on campaign rows and detail
 * headers. "Score pending" when band is "nodata".
 */
export function ScorePill({ score }: { score: CampaignCalderynScore }) {
  const { label, tone } = scorePillStyle(score);
  return <Pill tone={tone}>{label}</Pill>;
}
```

(`scorePillStyle`'s `ScorePillTone` is a subset of `ui.tsx`'s `PillTone`, so `<Pill tone={tone}>` typechecks.)

- [ ] **Step 4: Run the test and see it pass; confirm the component typechecks.**

```bash
npx vitest run app/components/dashboard/__tests__/score-pill.test.ts
npm run typecheck
```

Expected: `Tests 2 passed (2)`; `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit.**

```bash
git add app/components/dashboard/score-pill.ts app/components/dashboard/ui.tsx app/components/dashboard/__tests__/score-pill.test.ts
git commit -m "components/dashboard/ui: add ScorePill primitive (band-driven color)"
```

---

### Task 1.6: Thread `calderynScore` onto the `Campaign` DTO, `CampaignVM`, and `adaptCampaign`

**Files**
- Modify: `app/lib/types.ts` (`Campaign` interface)
- Modify: `app/components/dashboard/view-models.ts` (`CampaignVM`)
- Modify: `app/lib/dashboard/client.ts` (`adaptCampaign`)
- Test: `app/lib/dashboard/__tests__/adapt-campaign.test.ts`

> `adaptCampaign` is a pure, browser-safe function exported from `client.ts`. Sibling tests already import other adapters from `../client` (e.g. `adapt-screen-run.test.ts`), so importing it under the node harness is safe and established.

- [ ] **Step 1: Write the failing test.**

```ts
// app/lib/dashboard/__tests__/adapt-campaign.test.ts
import { describe, it, expect } from "vitest";
import { adaptCampaign } from "../client";
import type { Campaign } from "~/lib/types";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const base: Campaign = {
  id: "c1", name: "Prospecting", platform: "Meta", status: "active",
  daily_budget_cents: 5000, roas_7d: 2.4, contribution_margin: 0.5, spend_7d: 12000,
};

describe("adaptCampaign — calderynScore threading", () => {
  it("copies calderynScore from the DTO onto the view-model", () => {
    const score: CampaignCalderynScore = {
      value: 72, band: "fair", performance: 80, creative: 50, confidence: "high",
      weakDimensions: [], tips: [], adsCovered: 2, adsTotal: 3,
    };
    const vm = adaptCampaign({ ...base, calderynScore: score }, []);
    expect(vm.calderynScore).toEqual(score);
  });

  it("defaults calderynScore to null when the DTO omits it", () => {
    const vm = adaptCampaign(base, []);
    expect(vm.calderynScore).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/lib/dashboard/__tests__/adapt-campaign.test.ts
```

Expected failure: the module resolves (esbuild strips types — vitest does **not** type-check), so both tests fail at **runtime assertions** because the unmodified `adaptCampaign` never threads the field: `expected undefined to deeply equal { value: 72, … }` and `expected undefined to be null`.

- [ ] **Step 3: Write the minimal implementation.** Add the optional field to the `Campaign` DTO in `app/lib/types.ts` (interface at L106–115). Add the import near the top of `app/lib/types.ts`:

```ts
import type { CampaignCalderynScore } from "./campaign-score/types";
```

and add the field inside the `Campaign` interface (after `spend_7d`):

```ts
  /** Blended Calderyn score, attached server-side by the campaigns API loaders. */
  calderynScore?: CampaignCalderynScore | null;
```

Add the field to `CampaignVM` in `app/components/dashboard/view-models.ts` (after `trend?` at L31). Add the import near the existing type imports at the top:

```ts
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
```

and inside `CampaignVM`:

```ts
  /** Blended Calderyn score; null until resolved server-side. */
  calderynScore: CampaignCalderynScore | null;
```

Thread it in `adaptCampaign` (`app/lib/dashboard/client.ts`, in the returned object at L223–238, after `trend: undefined,`):

```ts
    calderynScore: c.calderynScore ?? null,
```

- [ ] **Step 4: Run the test and see it pass; confirm types.**

```bash
npx vitest run app/lib/dashboard/__tests__/adapt-campaign.test.ts
npm run typecheck
```

Expected: `Tests 2 passed (2)`; `tsc --noEmit` exits 0 (the optional `Campaign.calderynScore` field now makes the test's object literal and `CampaignVM.calderynScore` both legal).

- [ ] **Step 5: Commit.**

```bash
git add app/lib/types.ts app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/lib/dashboard/__tests__/adapt-campaign.test.ts
git commit -m "dashboard: thread calderynScore through Campaign DTO, CampaignVM, adaptCampaign"
```

---

### Task 1.7: Dashboard API loaders attach `calderynScore` (list + detail)

**Files**
- Modify: `app/routes/dashboard.api.campaigns._index.tsx`
- Modify: `app/routes/dashboard.api.campaigns.$id.tsx`

> These Remix loaders need a session + Supabase and aren't covered by the node-only/`.ts`-only vitest harness; the DI logic they call (`resolveCampaignScore`) is already unit-tested in Task 1.4. The red→green signal here is the type system: the loaders reference the new resolver and the `Campaign.calderynScore` field added in Tasks 1.1/1.4/1.6. Per D3 both use `ads: []` (performance-led) in Phase 1. `calderynClient(...).campaigns.list/get` and `.analytics.campaignGrades()` are the real methods (`app/lib/calderyn.server.ts`).

- [ ] **Step 1: Rewrite the list loader** `app/routes/dashboard.api.campaigns._index.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [campaigns, grades] = await Promise.all([
      client.campaigns.list(),
      client.analytics.campaignGrades(),
    ]);
    const gradeById = new Map(grades.map((g) => [g.campaign_id, g]));
    // Performance-led list score: no per-campaign creative fetch on list render
    // (rule 6 cost guard). ads:[] ⇒ resolve does no creative I/O. The creative
    // half resolves on the detail page (Phase 2 ports the dashboard creatives
    // fetch). Uncached/no-grade campaigns resolve to band "nodata" ⇒ ScorePill
    // renders "Score pending".
    const withScore = await Promise.all(
      campaigns.map(async (c) => ({
        ...c,
        calderynScore: await resolveCampaignScore(
          session.shopDomain,
          { id: c.id, ads: [] },
          gradeById.get(c.id),
        ),
      })),
    );
    return { campaigns: withScore };
  });
}
```

Rewrite the detail loader `app/routes/dashboard.api.campaigns.$id.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [campaign, grades] = await Promise.all([
      client.campaigns.get(id),
      client.analytics.campaignGrades(),
    ]);
    const gradeRow = grades.find((g) => g.campaign_id === id);
    // Phase 1: performance-led detail score (creative half + per-ad scorecards
    // land with the dashboard creatives port in Phase 2). ads:[] ⇒ no creative
    // I/O; the score breakdown shows P, confidence, and 0/0 coverage today.
    const calderynScore = await resolveCampaignScore(session.shopDomain, { id, ads: [] }, gradeRow);
    return { campaign: { ...campaign, calderynScore } };
  });
}
```

- [ ] **Step 2: Typecheck (red→green gate).** Before the edits `tsc` flags the missing `resolveCampaignScore` import / the unknown `calderynScore` field; after them it resolves because `Campaign.calderynScore` (Task 1.6) and `resolveCampaignScore` (Task 1.4) now exist:

```bash
npm run typecheck
```

Expected: exits 0 (`{ ...campaign, calderynScore }` and `{ ...c, calderynScore }` satisfy the extended `Campaign` DTO).

- [ ] **Step 3: Confirm the full build.**

```bash
npm run build
```

Expected: `remix vite:build` completes and `verify:client-bundle` passes → exit 0.

- [ ] **Step 4: Commit.**

```bash
git add app/routes/dashboard.api.campaigns._index.tsx app/routes/dashboard.api.campaigns.$id.tsx
git commit -m "routes/dashboard.api.campaigns: resolve calderynScore onto the campaign DTOs"
```

---

### Task 1.8: Dashboard `Campaigns.tsx` — ScorePill on rows + Score-breakdown / How-to-improve in detail

**Files**
- Modify: `app/components/dashboard/screens/Campaigns.tsx`

> `.tsx` screen — verified by `tsc` + `build` (the node-only harness has no DOM). The data it renders (`CampaignVM.calderynScore`) is already unit-tested upstream. `app.campaigns` flows from `fetchCampaigns` → `adaptCampaign` (Task 1.6), which now carries `calderynScore`; the screen's `joined` re-map spreads `...c`, preserving it.

- [ ] **Step 1: Swap the `../ui` import + add a pending-score fallback const.** Both current `GradePill` usages (row + detail header) are being replaced, so **remove `GradePill` from the import** (replacing it with `ScorePill`) — leaving it imported would fail `eslint --max-warnings=0` with `no-unused-vars`. Change the existing import block (L7–18) to:

```tsx
import {
  Card,
  SectionTitle,
  ScorePill,
  PlatformMark,
  Sparkline,
  Pill,
  Btn,
  Segmented,
  Placeholder,
  CountMoney,
  Tooltip,
} from "../ui";
```

Add the type import + a module const near the top (next to `DIR_PILL` at L28):

```tsx
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const PENDING_SCORE: CampaignCalderynScore = {
  value: null, band: "nodata", performance: null, creative: null, confidence: "low",
  weakDimensions: [], tips: [], adsCovered: 0, adsTotal: 0,
};
```

(`gradeFromRow` stays imported — `joined` still computes `CampaignVM.grade`.)

- [ ] **Step 2: Swap the row indicator.** In `CampaignRow` (the status-pill ternary at L77), replace the `GradePill` branch with `ScorePill`:

```tsx
{c.status === "paused" ? (
  <Pill icon="pause">Paused</Pill>
) : (
  <ScorePill score={c.calderynScore ?? PENDING_SCORE} />
)}
```

- [ ] **Step 3: Swap the detail header indicator.** In `CampaignDetail`'s `cd-screen-head` header (the `GradePill` at L219), replace with:

```tsx
<ScorePill score={c.calderynScore ?? PENDING_SCORE} />
```

- [ ] **Step 4: Add the Score-breakdown + How-to-improve sections.** Insert these two blocks inside `CampaignDetail`'s returned tree, after the "Open alerts on this campaign" card block and before the closing guardrails caption `<p className="cd-caption">` (around L417). The "How to improve" card mirrors the existing "Open alerts" `pad={false}` pattern (SectionTitle wrapped in a `cd-pad-x cd-pad-t` div):

```tsx
{(() => {
  const s = c.calderynScore ?? PENDING_SCORE;
  return (
    <Card>
      <SectionTitle>Calderyn score</SectionTitle>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <ScorePill score={s} />
        <span className="cd-caption">Performance {s.performance != null ? s.performance : "—"}</span>
        <span className="cd-caption">Creative {s.creative != null ? s.creative : "—"}</span>
        <Pill>{`Confidence: ${s.confidence}`}</Pill>
        <span className="cd-caption">{`Ads scored ${s.adsCovered}/${s.adsTotal}`}</span>
      </div>
      {(s.performance == null || s.creative == null) && (
        <p className="cd-caption">
          {s.performance == null ? "Performance pending — attribution. " : ""}
          {s.creative == null ? "Open this campaign and connect Meta to score its creatives." : ""}
        </p>
      )}
    </Card>
  );
})()}

{(() => {
  const s = c.calderynScore ?? PENDING_SCORE;
  if (s.weakDimensions.length === 0 && s.tips.length === 0) return null;
  return (
    <Card pad={false}>
      <div className="cd-pad-x cd-pad-t">
        <SectionTitle>How to improve</SectionTitle>
      </div>
      <div className="cd-rows">
        {s.weakDimensions.map((d, i) => (
          <div key={`wd-${d.adId}-${i}`} className="cd-row">
            <span>{d.label}</span>
            <Pill tone="warn">{d.score}</Pill>
          </div>
        ))}
        {s.tips.map((t, i) => (
          <div key={`tip-${i}`} className="cd-row">
            <CDIcon name="sparkle" size={14} />
            <span>{t}</span>
          </div>
        ))}
      </div>
    </Card>
  );
})()}
```

- [ ] **Step 5: Verify (typecheck + build) and commit.**

```bash
npm run typecheck
npm run lint
npm run build
git add app/components/dashboard/screens/Campaigns.tsx
git commit -m "screens/Campaigns: ScorePill on rows + Score-breakdown & How-to-improve detail sections"
```

Expected: all three commands exit 0 (lint clean — `GradePill` no longer imported-but-unused).

---

### Task 1.9: Embedded `app.campaigns._index.tsx` — score Badge on campaign rows (both render paths)

**Files**
- Modify: `app/routes/app.campaigns._index.tsx`

> The embedded list is the other half of the spec's "campaign rows … on BOTH surfaces" requirement. It has **two** render paths — a phone-width `CampaignCard` (Polaris) and a desktop hand-rolled CSS-grid table (`cmpx-*` classes from `app/components/calderyn/calderyn.css`). The score is the row's primary indicator on both. Embedded admin can't use the dashboard `ScorePill` (App Store / Polaris constraint, CLAUDE.md), so it renders the same DTO through a Polaris `<Badge>`; per D3 the list is performance-led (`ads: []`, cost guard rule 6). `.tsx` route — verified by `tsc` + `build`; the resolver is unit-tested in Task 1.4. **No grid-template / CSS change** — the score Badge slots into the existing `cmpx-status` cell next to the Active/Paused tag (no new column).

- [ ] **Step 1: Add imports + a band→Polaris-tone map.** Add near the existing imports (the route already imports `Badge`, `calderynClient`):

```ts
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
```

Add a module-scope const next to the route's other types (e.g. above the loader):

```ts
const SCORE_BADGE_TONE: Record<CampaignCalderynScore["band"], "success" | "warning" | "critical" | undefined> = {
  strong: "success",
  fair: "warning",
  weak: "critical",
  nodata: undefined,
};
```

- [ ] **Step 2: Attach `calderynScore` in the loader.** In `loader`, after the existing `scaleSuggestions` block and immediately before `return json<LoaderPayload>({ campaigns, reallocation, scaleSuggestions, error: null });` (L171), insert the score attach and switch the return to use it. Both `client.campaigns.list` and `client.analytics.campaignGrades` accept the optional `request.signal`:

```ts
    // Performance-led list score (cost guard rule 6): ads:[] ⇒ resolve does zero
    // creative I/O on list render; the full P+C score is computed on the detail
    // page (which already loads creatives). Best-effort: a grade-fetch failure
    // degrades to no badge (band "nodata") — the rows still render (rule 12).
    let campaignsWithScore: Campaign[] = campaigns;
    try {
      const grades = await client.analytics.campaignGrades(request.signal);
      const gradeById = new Map(grades.map((g) => [g.campaign_id, g]));
      campaignsWithScore = await Promise.all(
        campaigns.map(async (c) => ({
          ...c,
          calderynScore: await resolveCampaignScore(
            session.shop,
            { id: c.id, ads: [] },
            gradeById.get(c.id),
          ),
        })),
      );
    } catch {
      campaignsWithScore = campaigns;
    }

    return json<LoaderPayload>({ campaigns: campaignsWithScore, reallocation, scaleSuggestions, error: null });
```

- [ ] **Step 3: Render the score Badge in the mobile `CampaignCard`.** In `CampaignCard` (L683+), inside the status `InlineStack` (L713–731), add the Badge right after the Active/Paused `<Badge>` (L715–717):

```tsx
<Badge tone={c.status === "active" ? "success" : "attention"}>
  {c.status === "active" ? "Active" : "Paused"}
</Badge>
{c.calderynScore?.value != null && (
  <Badge tone={SCORE_BADGE_TONE[c.calderynScore.band]}>
    {`Score ${c.calderynScore.value}`}
  </Badge>
)}
```

- [ ] **Step 4: Render the score Badge in the desktop row.** In the `paged.map((c) => {…})` desktop row (L935+), inside the existing `<div className="cmpx-status">` cell (L958–969), add the Badge after the Active/Paused tag and before the scale/pause suggestion tags:

```tsx
<div className="cmpx-status">
  {paused ? (
    <span className="cmpx-tag cmpx-tag-paused">Paused</span>
  ) : (
    <span className="cmpx-tag cmpx-tag-active">
      <span className="cmpx-tag-dot" />
      Active
    </span>
  )}
  {c.calderynScore?.value != null && (
    <Badge tone={SCORE_BADGE_TONE[c.calderynScore.band]}>
      {`Score ${c.calderynScore.value}`}
    </Badge>
  )}
  {sug === "scale" && <span className="cmpx-tag cmpx-tag-scale">Scale suggested</span>}
  {sug === "pause" && <span className="cmpx-tag cmpx-tag-pause">Pause suggested</span>}
</div>
```

- [ ] **Step 5: Verify (typecheck + lint + build) and commit.**

```bash
npm run typecheck
npm run lint
npm run build
git add app/routes/app.campaigns._index.tsx
git commit -m "routes/app.campaigns._index: resolve + render calderynScore Badge on campaign rows"
```

Expected: all three commands exit 0 (new imports `resolveCampaignScore`/`CampaignCalderynScore` are both used → no unused-import warning).

---

### Task 1.10: Embedded `app.campaigns.$campaignId.tsx` — compute score + header badge + detail cards

**Files**
- Modify: `app/routes/app.campaigns.$campaignId.tsx`

> Embedded admin uses Polaris (not the dashboard `ScorePill`); the score indicator is a Polaris `Badge` whose tone is mapped from the band. The full P+C+weakDimensions+tips score is available here in Phase 1 (D3) because the loader already has `creatives` (with per-ad `status`) and cached `scorecards`. `.tsx` route — verified by `tsc` + `build`; the underlying resolver is unit-tested in Task 1.4. All Polaris components used below (`Badge`, `Text`, `BlockStack`, `InlineStack`, `Card`) are already imported by this route.

- [ ] **Step 1: Add imports + a band→tone map + extend `LoaderPayload`/`emptyPayload`.** Add near the existing imports (the route already imports `loadCachedAdScorecards`/`AdScorecard`, `CampaignPerformance`, Polaris `Badge`/`Text`/`InlineStack`/`BlockStack`/`Card`):

```ts
import {
  resolveCampaignScore,
  gradeRowFromPerformance,
} from "~/lib/campaign-score/resolve.server";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
```

Add a band→Polaris-tone map next to the route's other const maps (e.g. after `DIRECTION_BADGE` at L59):

```tsx
const SCORE_BADGE_TONE: Record<CampaignCalderynScore["band"], "success" | "warning" | "critical" | undefined> = {
  strong: "success",
  fair: "warning",
  weak: "critical",
  nodata: undefined,
};
```

Add the field to `LoaderPayload` (after `direction` at L107):

```ts
  /** Blended Calderyn score for this campaign (full P+C — creatives are loaded). */
  calderynScore: CampaignCalderynScore | null;
```

Add `calderynScore: null,` to the object returned by `emptyPayload` (L316–333, the non-detail payload).

- [ ] **Step 2: Compute the score in `respondForDetail`.** In `respondForDetail` (L287–312), after `const scorecards = await loadCachedScorecards(shop, creatives);` (L299) and before `return json<LoaderPayload>({...})`, add:

```ts
  const gradeRow = gradeRowFromPerformance({
    campaignId: detail.id,
    name: detail.name,
    roas: detail.performance.reportedRoas ?? 0,
    breakEvenRoas: detail.performance.breakEvenRoas ?? 0,
    spendCents: detail.performance.spend7dCents ?? 0,
  });
  const calderynScore = await resolveCampaignScore(
    shop,
    {
      id: detail.id,
      ads: creatives.map((cr) => ({
        adId: cr.adId,
        status: cr.status.toUpperCase() === "PAUSED" ? "paused" : "active",
      })),
    },
    gradeRow,
    // Reuse the scorecards already loaded above — no second cache read (D3).
    { loadCachedAdScorecards: async (_s, ids) => scorecards.filter((sc) => ids.includes(sc.adId)) },
  );
```

and add `calderynScore` to the returned `json<LoaderPayload>({ … })` object (alongside `direction`).

- [ ] **Step 3: Destructure the field; render the header badge + two detail cards.** Add `calderynScore` to the `useLoaderData` destructure in `CampaignDetailPage` (L533–544, alongside `detail`, `scorecards`, etc.).

Replace the `<Page>`'s `titleMetadata` (L567–571) so the status badge and the score badge sit together in an `InlineStack` (the detail header indicator, both surfaces):

```tsx
titleMetadata={
  <InlineStack gap="200" blockAlign="center">
    <Badge tone={detail.status === "active" ? "success" : "attention"}>
      {detail.status === "active" ? "Active" : "Paused"}
    </Badge>
    <Badge tone={SCORE_BADGE_TONE[calderynScore?.band ?? "nodata"]}>
      {calderynScore?.value != null ? `Score ${calderynScore.value}` : "Score pending"}
    </Badge>
  </InlineStack>
}
```

Add the two cards into the page's top-level `<BlockStack gap="400">` (e.g. directly after the "Real performance" card, around L700):

```tsx
<Card>
  <BlockStack gap="200">
    <Text as="h2" variant="headingMd">Calderyn score</Text>
    <InlineStack gap="400" blockAlign="center" wrap>
      <Badge tone={SCORE_BADGE_TONE[calderynScore?.band ?? "nodata"]}>
        {calderynScore?.value != null ? `Score ${calderynScore.value}` : "Score pending"}
      </Badge>
      <Text as="span" tone="subdued">
        Performance {calderynScore?.performance != null ? calderynScore.performance : "—"}
      </Text>
      <Text as="span" tone="subdued">
        Creative {calderynScore?.creative != null ? calderynScore.creative : "—"}
      </Text>
      <Text as="span" tone="subdued">Confidence: {calderynScore?.confidence ?? "low"}</Text>
      <Text as="span" tone="subdued">
        Ads scored {calderynScore?.adsCovered ?? 0}/{calderynScore?.adsTotal ?? 0}
      </Text>
    </InlineStack>
    {(calderynScore?.performance == null || calderynScore?.creative == null) && (
      <Text as="p" tone="subdued">
        {calderynScore?.performance == null ? "Performance pending — attribution. " : ""}
        {calderynScore?.creative == null ? "Connect Meta to score this campaign's creatives." : ""}
      </Text>
    )}
  </BlockStack>
</Card>

{calderynScore && (calderynScore.weakDimensions.length > 0 || calderynScore.tips.length > 0) && (
  <Card>
    <BlockStack gap="200">
      <Text as="h2" variant="headingMd">How to improve</Text>
      {calderynScore.weakDimensions.map((d, i) => (
        <InlineStack key={`wd-${d.adId}-${i}`} gap="200" align="space-between">
          <Text as="span">{d.label}</Text>
          <Badge tone="warning">{String(d.score)}</Badge>
        </InlineStack>
      ))}
      {calderynScore.tips.map((t, i) => (
        <Text as="p" key={`tip-${i}`}>{t}</Text>
      ))}
    </BlockStack>
  </Card>
)}
```

- [ ] **Step 4: Verify (typecheck + lint + build) and commit.**

```bash
npm run typecheck
npm run lint
npm run build
git add app/routes/app.campaigns.$campaignId.tsx
git commit -m "routes/app.campaigns.$campaignId: compute calderynScore; header badge + score/improve cards"
```

Expected: all three commands exit 0.

---

### Task 1.11: Phase verification — full pre-commit gate

**Files**
- None (verification only).

- [ ] **Step 1: Run `/code-review` on the working tree.** Resolve every blocker; downgrade any nit explicitly with a one-line justification. Expected: no unresolved blockers.

- [ ] **Step 2: Patch sanity.**

```bash
git diff --stat
git diff --check
```

Expected: `git diff --check` prints nothing (no whitespace/conflict markers); the stat lists only the Phase 1 files. Confirm by eye: no stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, AI/vibecode provenance, or design-tool markers in the diff.

- [ ] **Step 3: Run the eval pipeline in order.** No schema/migration/GraphQL changes in this phase (reuses existing tables; no `.graphql` edits), so `prisma`/`graphql-codegen` steps are N/A.

```bash
npm run typecheck
npm run lint
npm run build
npm run test
```

Expected:
- `npm run typecheck` (`tsc --noEmit`) → exit 0.
- `npm run lint` (`eslint --cache …`) → exit 0, no warnings on the touched files (notably: `GradePill` is no longer imported-but-unused in `Campaigns.tsx`).
- `npm run build` (`remix vite:build && verify:client-bundle`) → exit 0.
- `npm run test` (`vitest run`) → all suites pass, including the 6 new files: `app/lib/campaign-score/__tests__/{types,aggregate,blend,resolve}.test.ts`, `app/components/dashboard/__tests__/score-pill.test.ts`, `app/lib/dashboard/__tests__/adapt-campaign.test.ts`.

- [ ] **Step 4: Confirm both surfaces shipped (rule 12 — no silent single-sided ship).**
  - **Dashboard:** `Campaigns.tsx` rows + detail header render `ScorePill`; detail shows the "Calderyn score" + "How to improve" sections; the list/detail API loaders (`dashboard.api.campaigns._index.tsx` / `.$id.tsx`) attach `calderynScore`.
  - **Embedded:** `app.campaigns._index.tsx` rows (mobile card + desktop table) render a Polaris score `Badge`; `app.campaigns.$campaignId.tsx` header badge + the two Polaris cards, score computed (full P+C) in the loader.
  - **Stated single-sided timing (D3):** the dashboard's creative half + per-ad "How to improve" content lands in **Phase 2** (dashboard creatives port) — the dashboard list/detail are performance-led in Phase 1, left as the explicit, spec-sequenced TODO, not a silent gap.

- [ ] **Step 5: (No commit.)** All Phase 1 work was committed per-task; do not push or open a PR until explicitly requested (commit hygiene). Phase 1 is complete when every command in Step 3 reports exit 0 with evidence pasted.

---

## Phase 2: Improve panel, Regenerate, Drop-in screening

**Goal:** On BOTH surfaces, give every campaign its per-ad Creatives scorecards, a per-campaign copy **Regenerate** (weakest-ad → ranked winning variants), and a drop-in **Screen a new creative** form — reusing the existing screener engine (`campaign-ads`, `runs`, `score-one`, `pick-generator`, `generate`, `orchestrate`, `media`) and the embedded `app/components/Scorecard`, with all new score logic deterministic and DI-tested.

**Two conflicts surfaced from recon (rule 7) — resolved here, applied in every task below:**
1. The task says "port … using `app/components/Scorecard`". That component is **Polaris-only** and CLAUDE.md forbids Polaris on the dashboard. Resolution: the **embedded** side reuses `app/components/Scorecard` as-is; the **dashboard** side gets a new dashboard-native `AdScorecardPanel` that renders the same screener `ScoreCard` DTO with dashboard primitives (`RingGauge`/`ScoreBar`/`Pill`). Same data contract, different render — "match the contract, not the code."
2. `parseCreativeForm`/`clampSpend`/`isMetaSubmit` live in `app/routes/app.screener.tsx`, which **Phase 4 deletes**. Resolution: every new Phase-2 route defines its **own** local pure parse helper (no import from `app.screener.tsx`), so Phase 4 cleanup cannot break Phase 2.

**Third conflict (browser/server boundary, rule 7) — resolved here:** `app/lib/dashboard/client.ts` is browser-only and its own top-of-file contract (line 8) reads *"It MUST NOT import any \*.server.ts module."* The server-side per-ad shape `AdScorecard` lives in `campaign-ads.server.ts` and `CampaignCreative` in `meta/creatives.server.ts` — both `*.server`. So the client (and the dashboard component) must NOT import those types, **even as `import type`** (no existing browser module does). Resolution: declare browser-safe DTO mirrors (`AdScorecardDTO`, `CampaignCreativeDTO`, `CampaignCreativesDTO`) in `client.ts`, built only from the browser-safe `~/lib/screener/types` (`ScoreCard`, `CreativeInput`, `Variant`). The wire shapes are structurally identical to the server types (JSON is the boundary), so nothing diverges.

**Scope note on "folds into the aggregate" (rule 12, honest):** Phase 1's `resolveCampaignScore` aggregates **cached scorecards keyed to the campaign's Meta ad ids**. A brand-new drop-in creative has no Meta ad id, so it is persisted as a `creative_screen_run` and shown inline immediately, but it folds into the blended campaign score only once it exists as a Meta ad (Phase 3 push → re-score under its ad id). This task implements persist + inline result; it does not silently claim auto-fold for non-Meta creatives.

**Regen is copy-only in this phase** (`pickGenerator("copy", …)`), per task scope ("copyGenerator + a scoreOne gate"). Image regen + Meta push land in Phase 3.

```
Files:
  Create: app/lib/screener/campaign-regen.server.ts
  Create: app/lib/screener/__tests__/campaign-regen.test.ts
  Create: app/lib/screener/campaign-creatives-load.server.ts
  Create: app/lib/screener/__tests__/campaign-creatives-load.test.ts
  Create: app/routes/dashboard.api.campaigns.$id.creatives.tsx
  Create: app/routes/dashboard.api.campaigns.$id.score.tsx
  Create: app/routes/dashboard.api.campaigns.$id.regenerate.tsx
  Create: app/routes/dashboard.api.campaigns.$id.screen.tsx
  Create: app/routes/app.campaigns.$campaignId.regenerate.tsx
  Create: app/routes/app.campaigns.$campaignId.screen.tsx
  Create: app/components/dashboard/AdScorecardPanel.tsx
  Create: app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
  Create: app/routes/__tests__/campaign-regenerate-helpers.test.ts
  Create: app/routes/__tests__/campaign-screen-helpers.test.ts
  Modify: app/lib/dashboard/client.ts                     (browser-safe DTOs + 4 new client fns)
  Modify: app/components/dashboard/screens/Campaigns.tsx  (Creatives + Regenerate + Screen sections)
  Modify: app/routes/app.campaigns.$campaignId.tsx        (Regenerate + Screen sections + fetchers)
  Test:   npx vitest run app/lib/screener/__tests__/campaign-regen.test.ts
  Test:   npx vitest run app/lib/screener/__tests__/campaign-creatives-load.test.ts
  Test:   npx vitest run app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
  Test:   npx vitest run app/routes/__tests__/campaign-regenerate-helpers.test.ts
  Test:   npx vitest run app/routes/__tests__/campaign-screen-helpers.test.ts
```

---

### Task 2.1: Regen orchestration module (`campaign-regen.server.ts`) — pure picker + DI orchestrator

Builds the deterministic core of per-campaign Regenerate: pick the weakest cached ad, seed `generateImprovements` from its persisted run, keep winners, persist via `saveVariants`. No I/O of its own — every dependency is injected, so the LLM never enters the test.

```
Files:
  Create: app/lib/screener/campaign-regen.server.ts
  Create: app/lib/screener/__tests__/campaign-regen.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/screener/__tests__/campaign-regen.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  pickWeakestScoredAd,
  regenerateCampaignCreative,
  type RegenerateDeps,
} from "../campaign-regen.server";
import { DIMENSIONS, type CreativeInput, type CreativeScreenRun, type ScoreCard } from "../types";
import type { AdScorecard } from "../campaign-ads.server";
import type { CreativeGenerator } from "../generate.server";

const creative: CreativeInput = {
  imageUrl: null, headline: "Old headline", primaryText: "Old body", cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p", audience: "a",
};

function card(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "s",
    metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: composite, reasoning: "weak" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1, roasHigh: 3, breakEvenRoas: 2, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000,
      mappedSku: null, skuPriceCents: null,
    },
    tips: [],
  };
}

function adCard(adId: string, composite: number): AdScorecard {
  return { adId, status: "done", scorecard: card(composite), error: null };
}

function seedRun(over: Partial<CreativeScreenRun> = {}): CreativeScreenRun {
  return {
    id: "run-weak", status: "done", source: "meta_ad", metaAdId: "ad-weak",
    assumedSpendCents: 50000, scorecard: card(40), error: null, createdAt: "t",
    completedAt: "t", creativeInput: creative, variants: [], ...over,
  };
}

function fakeGenerator(): CreativeGenerator {
  return {
    mode: "copy",
    available: () => true,
    generate: vi.fn(async () => [
      { input: { ...creative, headline: "Better A" }, rationale: "fix hook" },
      { input: { ...creative, headline: "Better B" }, rationale: "fix cta" },
    ]),
  };
}

function deps(over: Partial<RegenerateDeps> = {}): RegenerateDeps {
  return {
    loadCached: async () => [adCard("ad-strong", 80), adCard("ad-weak", 40)],
    getLatestRunForAd: async () => seedRun(),
    gate: {
      generator: fakeGenerator(),
      // fake scoreOne: "Better A" beats baseline (40); "Better B" regresses.
      scoreOne: async (input: CreativeInput) => ({
        composite: input.headline === "Better A" ? 72 : 30,
        summary: "rescored", metrics: card(0).metrics,
      }),
    },
    styleRefs: ["Winning Ad 1"],
    saveVariants: vi.fn(async (_s: string, runId: string) => seedRun({ id: runId })),
    ...over,
  };
}

describe("pickWeakestScoredAd", () => {
  it("returns the lowest-composite done ad", () => {
    expect(pickWeakestScoredAd([adCard("a", 80), adCard("b", 40), adCard("c", 60)])?.adId).toBe("b");
  });
  it("ignores error rows and returns null when none are scored", () => {
    const err: AdScorecard = { adId: "e", status: "error", scorecard: null, error: "x" };
    expect(pickWeakestScoredAd([err])).toBeNull();
    expect(pickWeakestScoredAd([])).toBeNull();
  });
});

describe("regenerateCampaignCreative", () => {
  it("seeds from the weakest ad, keeps only winners, persists, returns ranked", async () => {
    const d = deps();
    const out = await regenerateCampaignCreative("s.myshopify.com", ["ad-strong", "ad-weak"], d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.weakestAdId).toBe("ad-weak");
    expect(out.runId).toBe("run-weak");
    expect(out.variants).toHaveLength(1);
    expect(out.variants[0].input.headline).toBe("Better A");
    expect(out.variants[0].composite).toBe(72);
    expect(out.variants[0].delta).toBe(32); // 72 - baseline 40
    expect(out.discarded).toBe(1);
    expect(d.saveVariants).toHaveBeenCalledWith("s.myshopify.com", "run-weak", out.variants);
  });

  it("returns no_scored_ads when nothing is cached", async () => {
    const out = await regenerateCampaignCreative("s", ["x"], deps({ loadCached: async () => [] }));
    expect(out).toEqual({ ok: false, reason: "no_scored_ads" });
  });

  it("returns no_seed_run when the weakest ad has no reusable run", async () => {
    const out = await regenerateCampaignCreative("s", ["x"], deps({ getLatestRunForAd: async () => null }));
    expect(out).toEqual({ ok: false, reason: "no_seed_run" });
  });

  it("returns generator_unavailable and never saves when the generator is off", async () => {
    const save = vi.fn();
    const offGen: CreativeGenerator = { mode: "copy", available: () => false, generate: vi.fn() };
    const out = await regenerateCampaignCreative("s", ["x"], deps({
      gate: { generator: offGen, scoreOne: async () => ({ composite: 0, summary: "", metrics: [] }) },
      saveVariants: save,
    }));
    expect(out).toEqual({ ok: false, reason: "generator_unavailable" });
    expect(save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
npx vitest run app/lib/screener/__tests__/campaign-regen.test.ts
```

Expected failure: `Error: Failed to resolve import "../campaign-regen.server"` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation.** Create `app/lib/screener/campaign-regen.server.ts`:

```ts
// app/lib/screener/campaign-regen.server.ts
// Deterministic core of per-campaign Regenerate: from the campaign's CACHED ad
// scorecards, pick the weakest scored ad, re-load its persisted run for the
// original creative + scorecard, run the generate->re-score gate seeded from it,
// keep winners, and persist them onto that run. All I/O is injected (rule 5: the
// math/selection is deterministic code; the model only runs behind the injected
// gate). Never throws on a normal degraded state — it returns a typed reason.
import { generateImprovements, type GateDeps } from "./generate.server";
import type { AdScorecard } from "./campaign-ads.server";
import type { CreativeScreenRun, Variant } from "./types";

export interface RegenerateDeps {
  loadCached: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
  getLatestRunForAd: (shop: string, metaAdId: string) => Promise<CreativeScreenRun | null>;
  gate: GateDeps; // { generator, scoreOne }
  styleRefs: string[];
  saveVariants: (shop: string, runId: string, variants: Variant[]) => Promise<CreativeScreenRun>;
  generate?: typeof generateImprovements;
  count?: number;
}

export type RegenerateResult =
  | {
      ok: true;
      runId: string;
      weakestAdId: string;
      variants: Variant[];
      allScored: Variant[];
      generated: number;
      discarded: number;
    }
  | { ok: false; reason: "no_scored_ads" | "no_seed_run" | "generator_unavailable" };

/** PURE: the worst-scoring cached ad (lowest composite among status:"done"). */
export function pickWeakestScoredAd(cards: AdScorecard[]): AdScorecard | null {
  let best: { card: AdScorecard; composite: number } | null = null;
  for (const c of cards) {
    if (c.status !== "done" || !c.scorecard) continue;
    const composite = c.scorecard.composite;
    if (best === null || composite < best.composite) best = { card: c, composite };
  }
  return best ? best.card : null;
}

export async function regenerateCampaignCreative(
  shop: string,
  adIds: string[],
  deps: RegenerateDeps,
): Promise<RegenerateResult> {
  const cards = await deps.loadCached(shop, adIds);
  const weakest = pickWeakestScoredAd(cards);
  if (!weakest) return { ok: false, reason: "no_scored_ads" };

  const seed = await deps.getLatestRunForAd(shop, weakest.adId);
  if (!seed || seed.status !== "done" || !seed.scorecard || !seed.creativeInput) {
    return { ok: false, reason: "no_seed_run" };
  }

  const generate = deps.generate ?? generateImprovements;
  const result = await generate(
    {
      original: seed.creativeInput,
      originalScorecard: seed.scorecard,
      styleRefs: deps.styleRefs,
      count: deps.count,
    },
    deps.gate,
  );
  if (!result.available) return { ok: false, reason: "generator_unavailable" };

  const saved = await deps.saveVariants(shop, seed.id, result.variants);
  return {
    ok: true,
    runId: saved.id,
    weakestAdId: weakest.adId,
    variants: result.variants,
    allScored: result.allScored,
    generated: result.generated,
    discarded: result.discarded,
  };
}
```

- [ ] **Step 4: Run it and watch it pass.**

```bash
npx vitest run app/lib/screener/__tests__/campaign-regen.test.ts
```

Expected: `Test Files 1 passed`, `Tests 6 passed`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/screener/campaign-regen.server.ts app/lib/screener/__tests__/campaign-regen.test.ts
git commit -m "lib/screener/campaign-regen: weakest-ad seed + DI regenerate orchestrator"
```

---

### Task 2.2: Dashboard creatives+scorecards loader module (`campaign-creatives-load.server.ts`)

The dashboard `CampaignVM` carries no creatives (recon ui-surfaces §9). This module mirrors the embedded loader's creative path (`loadCreatives` + `loadCachedScorecards` in `app.campaigns.$campaignId.tsx`): resolve the campaign's Meta external id from `ad_campaign_dim`, fetch its ad creatives, and merge **cached** scorecards (no Claude). Every failure degrades to an honest result (rule 12, spec §9).

```
Files:
  Create: app/lib/screener/campaign-creatives-load.server.ts
  Create: app/lib/screener/__tests__/campaign-creatives-load.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/screener/__tests__/campaign-creatives-load.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  loadCampaignCreativeScorecards,
  type CreativesLoadDeps,
} from "../campaign-creatives-load.server";
import { DIMENSIONS, type ScoreCard } from "../types";
import type { CampaignCreative } from "../../meta/creatives.server";
import type { AdScorecard } from "../campaign-ads.server";
import type { MetaClient } from "../../meta/campaigns.server";

const fakeMetaClient = {} as MetaClient;

const creativeRow: CampaignCreative = {
  adId: "ad-1", adName: "Ad 1", status: "ACTIVE",
  creative: { imageUrl: null, headline: "h", primaryText: "p", cta: "SHOP_NOW", destinationUrl: "https://x.test/p", audience: "a" },
};

function card(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "s",
    metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1, roasHigh: 3, breakEvenRoas: 2, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000, mappedSku: null, skuPriceCents: null,
    },
    tips: [],
  };
}

function deps(over: Partial<CreativesLoadDeps> = {}): CreativesLoadDeps {
  return {
    resolveMetaId: async () => "120999",
    metaClient: async () => ({ client: fakeMetaClient, adAccountId: "act_1" }),
    listCreatives: async () => [creativeRow],
    loadCached: async () => [{ adId: "ad-1", status: "done", scorecard: card(88), error: null } as AdScorecard],
    ...over,
  };
}

describe("loadCampaignCreativeScorecards", () => {
  it("returns creatives + cached scorecards + clamped spend when connected", async () => {
    const out = await loadCampaignCreativeScorecards("s.myshopify.com", "shop-1", "camp-uuid", 60000, deps());
    expect(out.metaConnected).toBe(true);
    expect(out.creatives).toHaveLength(1);
    expect(out.scorecards[0].scorecard?.composite).toBe(88);
    expect(out.assumedSpendCents).toBe(60000);
    expect(out.creativesError).toBeNull();
  });

  it("reports metaConnected:false with empty creatives when Meta is disconnected", async () => {
    const listCreatives = vi.fn();
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 50000, deps({
      metaClient: async () => null, listCreatives,
    }));
    expect(out.metaConnected).toBe(false);
    expect(out.creatives).toEqual([]);
    expect(out.scorecards).toEqual([]);
    expect(listCreatives).not.toHaveBeenCalled();
  });

  it("surfaces a creative-fetch failure honestly without throwing", async () => {
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 50000, deps({
      listCreatives: async () => { throw new Error("graph boom"); },
    }));
    expect(out.metaConnected).toBe(true);
    expect(out.creatives).toEqual([]);
    expect(out.creativesError).toContain("graph boom");
  });

  it("clamps an out-of-range spend to the screener bounds", async () => {
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 1, deps());
    expect(out.assumedSpendCents).toBe(1000); // MIN_SPEND_CENTS
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
npx vitest run app/lib/screener/__tests__/campaign-creatives-load.test.ts
```

Expected failure: `Failed to resolve import "../campaign-creatives-load.server"`.

- [ ] **Step 3: Write the minimal implementation.** Create `app/lib/screener/campaign-creatives-load.server.ts`:

```ts
// app/lib/screener/campaign-creatives-load.server.ts
// Dashboard mirror of the embedded campaign-detail creative load
// (app.campaigns.$campaignId.tsx loadCreatives + loadCachedScorecards): resolve
// the campaign's Meta external id, list its ad creatives, and merge CACHED per-ad
// scorecards (no scoring here — uncached ads are scored on demand via the score
// endpoint). Never throws: Meta-disconnected / missing-id / fetch-failure each
// degrade to an honest empty result with flags (rule 12, spec §9).
import { getSupabase } from "../supabase.server";
import { metaClientForShop } from "../meta/client.server";
import { listCampaignCreatives, type CampaignCreative } from "../meta/creatives.server";
import { loadCachedAdScorecards, type AdScorecard } from "./campaign-ads.server";
import type { MetaClient } from "../meta/campaigns.server";
import { DEFAULT_SPEND_CENTS, MAX_SPEND_CENTS, MIN_SPEND_CENTS } from "./types";

export interface CampaignCreativesPayload {
  creatives: CampaignCreative[];
  scorecards: AdScorecard[];
  assumedSpendCents: number;
  metaConnected: boolean;
  creativesError: string | null;
}

export interface CreativesLoadDeps {
  resolveMetaId: (shopId: string, campaignId: string) => Promise<string | null>;
  metaClient: (shopDomain: string) => Promise<{ client: MetaClient; adAccountId: string } | null>;
  listCreatives: (client: MetaClient, externalId: string) => Promise<CampaignCreative[]>;
  loadCached: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
}

// campaign UUID (ad_campaign_dim.id) → Meta campaign external id, shop-scoped.
// Same lookup the executor uses (execute.server ownership/resolve).
async function resolveMetaIdReal(shopId: string, campaignId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("ad_campaign_dim")
    .select("external_id")
    .eq("id", campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.external_id as string | null) ?? null;
}

function defaultDeps(): CreativesLoadDeps {
  return {
    resolveMetaId: resolveMetaIdReal,
    metaClient: metaClientForShop,
    listCreatives: listCampaignCreatives,
    loadCached: loadCachedAdScorecards,
  };
}

function clampSpend(raw: number): number {
  const n = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export async function loadCampaignCreativeScorecards(
  shopDomain: string,
  shopId: string,
  campaignId: string,
  assumedSpendCents: number,
  deps: CreativesLoadDeps = defaultDeps(),
): Promise<CampaignCreativesPayload> {
  const spend = clampSpend(assumedSpendCents);
  const conn = await deps.metaClient(shopDomain);
  if (!conn) {
    return { creatives: [], scorecards: [], assumedSpendCents: spend, metaConnected: false, creativesError: null };
  }
  const externalId = await deps.resolveMetaId(shopId, campaignId);
  if (!externalId) {
    return { creatives: [], scorecards: [], assumedSpendCents: spend, metaConnected: true, creativesError: null };
  }
  let creatives: CampaignCreative[] = [];
  let creativesError: string | null = null;
  try {
    creatives = await deps.listCreatives(conn.client, externalId);
  } catch (err) {
    creativesError = err instanceof Error ? err.message : String(err);
  }
  let scorecards: AdScorecard[] = [];
  if (creatives.length > 0) {
    try {
      scorecards = await deps.loadCached(shopDomain, creatives.map((c) => c.adId));
    } catch {
      scorecards = [];
    }
  }
  return { creatives, scorecards, assumedSpendCents: spend, metaConnected: true, creativesError };
}
```

- [ ] **Step 4: Run it and watch it pass.**

```bash
npx vitest run app/lib/screener/__tests__/campaign-creatives-load.test.ts
```

Expected: `Tests 4 passed`.

- [ ] **Step 5: Commit.**

```bash
git add app/lib/screener/campaign-creatives-load.server.ts app/lib/screener/__tests__/campaign-creatives-load.test.ts
git commit -m "lib/screener/campaign-creatives-load: dashboard creative+cached-scorecard loader"
```

---

### Task 2.3: Dashboard resource routes — score one ad + list creatives (pure `parseScoreBody` TDD)

Two dashboard endpoints mirroring the embedded `app.campaigns.$campaignId.score.tsx` (score on demand) and the embedded loader's creative path. The pure `parseScoreBody` (JSON analogue of `parseScoreForm`) is the TDD target.

```
Files:
  Create: app/routes/dashboard.api.campaigns.$id.score.tsx
  Create: app/routes/dashboard.api.campaigns.$id.creatives.tsx
  Create: app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/routes/__tests__/dashboard-campaign-score-helpers.test.ts` (dashboard routes do NOT import `shopify.server`, so no mock is needed):

```ts
import { describe, it, expect } from "vitest";
import { parseScoreBody } from "../dashboard.api.campaigns.$id.score";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS, MAX_SPEND_CENTS } from "~/lib/screener/types";

describe("parseScoreBody", () => {
  it("rejects a missing/blank adId", () => {
    expect(parseScoreBody({}).ok).toBe(false);
    expect(parseScoreBody({ adId: "   " }).ok).toBe(false);
  });

  it("builds a CreativeInput, coerces fields, defaults spend", () => {
    const r = parseScoreBody({ adId: "ad-1", headline: "H", primaryText: "P", cta: "BUY", destinationUrl: "https://x.test/p", audience: "a" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adId).toBe("ad-1");
    expect(r.creative).toEqual({ imageUrl: null, headline: "H", primaryText: "P", cta: "BUY", destinationUrl: "https://x.test/p", audience: "a" });
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });

  it('treats imageUrl "" and "null" as null, keeps a real url', () => {
    expect(parseScoreBody({ adId: "a", imageUrl: "" }).ok && (parseScoreBody({ adId: "a", imageUrl: "" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe(null);
    expect((parseScoreBody({ adId: "a", imageUrl: "null" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe(null);
    expect((parseScoreBody({ adId: "a", imageUrl: "https://img.test/x.png" }) as { creative: { imageUrl: string | null } }).creative.imageUrl).toBe("https://img.test/x.png");
  });

  it("clamps spend to [MIN, MAX]", () => {
    expect((parseScoreBody({ adId: "a", assumedSpendCents: 1 }) as { assumedSpendCents: number }).assumedSpendCents).toBe(MIN_SPEND_CENTS);
    expect((parseScoreBody({ adId: "a", assumedSpendCents: 99_999_999 }) as { assumedSpendCents: number }).assumedSpendCents).toBe(MAX_SPEND_CENTS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
npx vitest run app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
```

Expected failure: `Failed to resolve import "../dashboard.api.campaigns.$id.score"`.

- [ ] **Step 3: Write the minimal implementation.** Create `app/routes/dashboard.api.campaigns.$id.score.tsx`:

```tsx
// app/routes/dashboard.api.campaigns.$id.score.tsx
// Dashboard mirror of app.campaigns.$campaignId.score.tsx: POST JSON for one ad,
// cache-check + score + persist via loadOrScoreAdScorecards, return its
// AdScorecard. requireSameOrigin (CSRF) + requireDashboardSession (shop scope).
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { loadOrScoreAdScorecards } from "~/lib/screener/campaign-ads.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

export type ParsedScoreBody =
  | { ok: true; adId: string; creative: CreativeInput; assumedSpendCents: number }
  | { ok: false; error: string };

function clampSpend(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

// PURE: untrusted JSON body → { adId, creative, assumedSpendCents }. Mirrors the
// embedded parseScoreForm: non-empty adId required, imageUrl ""/"null" → null,
// every other field coerced to string, spend clamped to bounds.
export function parseScoreBody(body: Record<string, unknown>): ParsedScoreBody {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const adId = str("adId").trim();
  if (!adId) return { ok: false, error: "adId is required" };
  const imageUrlRaw = str("imageUrl").trim();
  const creative: CreativeInput = {
    imageUrl: imageUrlRaw === "" || imageUrlRaw === "null" ? null : imageUrlRaw,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta"),
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
  return { ok: true, adId, creative, assumedSpendCents: clampSpend(body.assumedSpendCents) };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const parsed = parseScoreBody(body);
  if (!parsed.ok) return jsonError(422, "invalid_request", parsed.error);

  return dashboardJson(async () => {
    const [scorecard] = await loadOrScoreAdScorecards(
      session.shopDomain,
      [{ adId: parsed.adId, creative: parsed.creative }],
      parsed.assumedSpendCents,
    );
    return { scorecard };
  });
}
```

- [ ] **Step 4: Write the creatives loader route.** Create `app/routes/dashboard.api.campaigns.$id.creatives.tsx`:

```tsx
// app/routes/dashboard.api.campaigns.$id.creatives.tsx
// GET → the campaign's Meta ad creatives + CACHED per-ad scorecards (no scoring).
// The dashboard CampaignDetail calls this on open, like fetchCampaignDirection.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCampaignCreativeScorecards } from "~/lib/screener/campaign-creatives-load.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const spend = Number(url.searchParams.get("assumedSpendCents")) || DEFAULT_SPEND_CENTS;
  return dashboardJson(async () =>
    loadCampaignCreativeScorecards(session.shopDomain, session.shopId, String(params.id), spend),
  );
}
```

- [ ] **Step 5: Run the helper test and watch it pass.**

```bash
npx vitest run app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
```

Expected: `Tests 4 passed`.

- [ ] **Step 6: Commit.**

```bash
git add app/routes/dashboard.api.campaigns.\$id.score.tsx app/routes/dashboard.api.campaigns.\$id.creatives.tsx app/routes/__tests__/dashboard-campaign-score-helpers.test.ts
git commit -m "routes/dashboard.api.campaigns: score-one-ad + creatives endpoints (parseScoreBody)"
```

---

### Task 2.4: Embedded + dashboard Regenerate routes (pure `parseRegenForm`/`parseRegenBody` TDD)

Two resource routes that call the Task 2.1 orchestrator. The embedded route imports `authenticate` (so its test mocks `shopify.server`, like `route-helpers.test.ts`); the dashboard route does not.

```
Files:
  Create: app/routes/app.campaigns.$campaignId.regenerate.tsx
  Create: app/routes/dashboard.api.campaigns.$id.regenerate.tsx
  Create: app/routes/__tests__/campaign-regenerate-helpers.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/routes/__tests__/campaign-regenerate-helpers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// app.campaigns.$campaignId.regenerate imports shopify.server (authenticate),
// which calls shopifyApp({ appUrl }) at module load and throws without
// SHOPIFY_APP_URL — stub it exactly like route-helpers.test.ts. From
// app/routes/__tests__/ the module path is "../../shopify.server".
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock */
import { parseRegenForm } from "../app.campaigns.$campaignId.regenerate";
import { parseRegenBody } from "../dashboard.api.campaigns.$id.regenerate";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS } from "~/lib/screener/types";
/* eslint-enable import/first */

describe("parseRegenForm (embedded, FormData)", () => {
  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }
  it("parses a JSON adIds array and defaults spend", () => {
    const r = parseRegenForm(fd({ adIds: JSON.stringify(["a", "b"]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adIds).toEqual(["a", "b"]);
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("drops blanks and rejects when no adIds remain", () => {
    expect(parseRegenForm(fd({ adIds: JSON.stringify(["", "  "]) })).ok).toBe(false);
    expect(parseRegenForm(fd({})).ok).toBe(false);
    expect(parseRegenForm(fd({ adIds: "not json" })).ok).toBe(false);
  });
  it("clamps spend", () => {
    const r = parseRegenForm(fd({ adIds: JSON.stringify(["a"]), assumedSpendCents: "1" }));
    expect(r.ok && r.assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
});

describe("parseRegenBody (dashboard, JSON)", () => {
  it("parses adIds array and defaults spend", () => {
    const r = parseRegenBody({ adIds: ["a", "b"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adIds).toEqual(["a", "b"]);
    expect(r.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("rejects empty/non-array adIds", () => {
    expect(parseRegenBody({}).ok).toBe(false);
    expect(parseRegenBody({ adIds: [] }).ok).toBe(false);
    expect(parseRegenBody({ adIds: "a" }).ok).toBe(false);
  });
  it("clamps spend", () => {
    const r = parseRegenBody({ adIds: ["a"], assumedSpendCents: 1 });
    expect(r.ok && r.assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
npx vitest run app/routes/__tests__/campaign-regenerate-helpers.test.ts
```

Expected failure: `Failed to resolve import "../app.campaigns.$campaignId.regenerate"`.

- [ ] **Step 3: Write the embedded route.** Create `app/routes/app.campaigns.$campaignId.regenerate.tsx`:

```tsx
// app/routes/app.campaigns.$campaignId.regenerate.tsx
// Action-only resource route at /app/campaigns/:campaignId/regenerate (mirrors the
// existing app.campaigns.$campaignId.score.tsx resource pattern). Runs the copy
// regenerate loop seeded from the campaign's weakest scored ad and returns ranked
// winning variants. Reuses the screener gate (gateScoreDeps), copy generator
// (pickGenerator("copy")), and the DI orchestrator. Failures surface in the JSON
// payload (rule 12), never the error boundary.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type Variant,
} from "~/lib/screener/types";
import { loadCachedAdScorecards } from "~/lib/screener/campaign-ads.server";
import { getLatestRunForAd, saveVariants } from "~/lib/screener/runs.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { regenerateCampaignCreative } from "~/lib/screener/campaign-regen.server";

export type RegenActionPayload =
  | { ok: true; runId: string; weakestAdId: string; variants: Variant[] }
  | { ok: false; error: { code: string; message: string } };

function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || String(raw).trim() === "") return DEFAULT_SPEND_CENTS;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export type ParsedRegen =
  | { ok: true; adIds: string[]; assumedSpendCents: number }
  | { ok: false; error: { code: string; message: string } };

// PURE: FormData → { adIds, assumedSpendCents }. adIds posted as a JSON array.
export function parseRegenForm(form: FormData): ParsedRegen {
  let adIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(form.get("adIds") ?? "[]"));
    if (Array.isArray(parsed)) {
      adIds = parsed.filter((a): a is string => typeof a === "string" && a.trim() !== "");
    }
  } catch {
    adIds = [];
  }
  if (adIds.length === 0) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "adIds is required" } };
  }
  return { ok: true, adIds, assumedSpendCents: clampSpend(form.get("assumedSpendCents")) };
}

function reasonMessage(reason: "no_scored_ads" | "no_seed_run" | "generator_unavailable"): string {
  if (reason === "no_scored_ads") return "Score this campaign's ads first, then regenerate.";
  if (reason === "no_seed_run") return "Couldn't find a scored creative to improve yet.";
  return "Copy generation is unavailable right now.";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseRegenForm(form);
  if (!parsed.ok) return json<RegenActionPayload>({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const { calib, scoreOne, claudeDeps } = await gateScoreDeps(session.shop, parsed.assumedSpendCents);
    const generator = pickGenerator("copy", claudeDeps);
    const result = await regenerateCampaignCreative(session.shop, parsed.adIds, {
      loadCached: loadCachedAdScorecards,
      getLatestRunForAd,
      gate: { generator, scoreOne },
      styleRefs: calib.topAdNames,
      saveVariants,
      generate: generateImprovements,
    });
    if (!result.ok) {
      return json<RegenActionPayload>({
        ok: false,
        error: { code: result.reason.toUpperCase(), message: reasonMessage(result.reason) },
      });
    }
    return json<RegenActionPayload>({
      ok: true,
      runId: result.runId,
      weakestAdId: result.weakestAdId,
      variants: result.variants,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json<RegenActionPayload>({ ok: false, error: { code: "REGEN_FAILED", message } }, { status: 500 });
  }
};
```

- [ ] **Step 4: Write the dashboard route.** Create `app/routes/dashboard.api.campaigns.$id.regenerate.tsx`:

```tsx
// app/routes/dashboard.api.campaigns.$id.regenerate.tsx
// Dashboard mirror of the embedded regenerate route. Same orchestrator, same
// copy gate; JSON in / JSON out with the dashboard envelope. The orchestrator's
// typed {ok:false, reason} is returned as-is (200) so the dashboard UI can map it.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
} from "~/lib/screener/types";
import { loadCachedAdScorecards } from "~/lib/screener/campaign-ads.server";
import { getLatestRunForAd, saveVariants } from "~/lib/screener/runs.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { regenerateCampaignCreative } from "~/lib/screener/campaign-regen.server";

export type ParsedRegen =
  | { ok: true; adIds: string[]; assumedSpendCents: number }
  | { ok: false; error: { code: string; message: string } };

export function parseRegenBody(body: Record<string, unknown>): ParsedRegen {
  const adIds = Array.isArray(body.adIds)
    ? (body.adIds as unknown[]).filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  if (adIds.length === 0) {
    return { ok: false, error: { code: "invalid_request", message: "adIds is required" } };
  }
  const raw = Math.round(Number(body.assumedSpendCents));
  const assumedSpendCents = Number.isFinite(raw)
    ? Math.min(Math.max(raw, MIN_SPEND_CENTS), MAX_SPEND_CENTS)
    : DEFAULT_SPEND_CENTS;
  return { ok: true, adIds, assumedSpendCents };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const parsed = parseRegenBody(body);
  if (!parsed.ok) return jsonError(422, parsed.error.code, parsed.error.message);

  return dashboardJson(async () => {
    const { calib, scoreOne, claudeDeps } = await gateScoreDeps(session.shopDomain, parsed.assumedSpendCents);
    const generator = pickGenerator("copy", claudeDeps);
    const result = await regenerateCampaignCreative(session.shopDomain, parsed.adIds, {
      loadCached: loadCachedAdScorecards,
      getLatestRunForAd,
      gate: { generator, scoreOne },
      styleRefs: calib.topAdNames,
      saveVariants,
      generate: generateImprovements,
    });
    return result;
  });
}
```

- [ ] **Step 5: Run the helper test and watch it pass.**

```bash
npx vitest run app/routes/__tests__/campaign-regenerate-helpers.test.ts
```

Expected: `Tests 6 passed`.

- [ ] **Step 6: Commit.**

```bash
git add app/routes/app.campaigns.\$campaignId.regenerate.tsx app/routes/dashboard.api.campaigns.\$id.regenerate.tsx app/routes/__tests__/campaign-regenerate-helpers.test.ts
git commit -m "routes/campaigns: per-campaign copy Regenerate (both surfaces) via campaign-regen orchestrator"
```

---

### Task 2.5: Embedded + dashboard drop-in Screen routes (pure `parseCampaignScreenForm`/`parseScreenBody` TDD)

Two resource routes that screen a fresh creative scoped to the campaign via `executeScreen` (source defaults `"manual"`), enforcing the mandatory-media + SSRF guards (`validateCreativeMedia` / `validateCreativeMediaUrls`).

```
Files:
  Create: app/routes/app.campaigns.$campaignId.screen.tsx
  Create: app/routes/dashboard.api.campaigns.$id.screen.tsx
  Create: app/routes/__tests__/campaign-screen-helpers.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/routes/__tests__/campaign-screen-helpers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock */
import { parseCampaignScreenForm } from "../app.campaigns.$campaignId.screen";
import { parseScreenBody } from "../dashboard.api.campaigns.$id.screen";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS } from "~/lib/screener/types";
/* eslint-enable import/first */

describe("parseCampaignScreenForm (embedded, FormData)", () => {
  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }
  it("builds a CreativeInput, defaults cta to SHOP_NOW, defaults spend", () => {
    const { input, assumedSpendCents } = parseCampaignScreenForm(
      fd({ headline: "H", primaryText: "P", destinationUrl: "https://x.test/p", audience: "a", mediaKind: "image", imageUrl: "data:image/png;base64,AAAA" }),
    );
    expect(input.cta).toBe("SHOP_NOW");
    expect(input.mediaKind).toBe("image");
    expect(input.imageUrl).toBe("data:image/png;base64,AAAA");
    expect(assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("parses video frame urls JSON and clamps spend", () => {
    const { input, assumedSpendCents } = parseCampaignScreenForm(
      fd({ mediaKind: "video", videoFrameUrls: JSON.stringify(["data:image/png;base64,A"]), videoDurationSec: "8", assumedSpendCents: "1" }),
    );
    expect(input.videoFrameUrls).toEqual(["data:image/png;base64,A"]);
    expect(input.videoDurationSec).toBe(8);
    expect(assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
  it("falls back to no frames on malformed JSON", () => {
    const { input } = parseCampaignScreenForm(fd({ mediaKind: "video", videoFrameUrls: "{bad" }));
    expect(input.videoFrameUrls).toEqual([]);
  });
});

describe("parseScreenBody (dashboard, JSON)", () => {
  it("delegates to creativeInputFromJson and clamps spend", () => {
    const { input, assumedSpendCents } = parseScreenBody({ headline: "H", mediaKind: "image", imageUrl: "data:image/png;base64,A", assumedSpendCents: 1 });
    expect(input.headline).toBe("H");
    expect(input.cta).toBe("SHOP_NOW");
    expect(assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
  it("defaults spend when absent", () => {
    expect(parseScreenBody({}).assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
npx vitest run app/routes/__tests__/campaign-screen-helpers.test.ts
```

Expected failure: `Failed to resolve import "../app.campaigns.$campaignId.screen"`.

- [ ] **Step 3: Write the embedded route.** Create `app/routes/app.campaigns.$campaignId.screen.tsx`:

```tsx
// app/routes/app.campaigns.$campaignId.screen.tsx
// Action-only resource route at /app/campaigns/:campaignId/screen. Drop-in
// "screen a new creative" for the campaign: parse the manual form, enforce the
// mandatory-media + SSRF guards, run executeScreen (persists a creative_screen_run),
// and return the run. Mirrors the manual fallthrough of app.screener.tsx but
// without importing it (that route is removed in Phase 4).
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { validateCreativeMedia, validateCreativeMediaUrls } from "~/lib/screener/media.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || String(raw).trim() === "") return DEFAULT_SPEND_CENTS;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

// PURE: FormData → { input, assumedSpendCents }. cta defaults SHOP_NOW; mediaKind
// only "image"|"video" else null; videoFrameUrls JSON-parsed (bad JSON → []).
export function parseCampaignScreenForm(form: FormData): {
  input: CreativeInput;
  assumedSpendCents: number;
} {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const mediaKind = str("mediaKind");
  let videoFrameUrls: string[] = [];
  try {
    const parsed: unknown = JSON.parse(str("videoFrameUrls") || "[]");
    if (Array.isArray(parsed)) {
      videoFrameUrls = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    videoFrameUrls = [];
  }
  const duration = Number(str("videoDurationSec"));
  const input: CreativeInput = {
    imageUrl: str("imageUrl") || null,
    mediaKind: mediaKind === "image" || mediaKind === "video" ? mediaKind : null,
    videoFrameUrls,
    videoDurationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
  return { input, assumedSpendCents: clampSpend(form.get("assumedSpendCents")) };
}

export type ScreenActionPayload =
  | { ok: true; run: Awaited<ReturnType<typeof executeScreen>> }
  | { ok: false; error: { code: string; message: string } };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const { input, assumedSpendCents } = parseCampaignScreenForm(form);

  const mediaError = validateCreativeMedia(input);
  if (mediaError) {
    return json<ScreenActionPayload>({ ok: false, error: { code: "MEDIA_REQUIRED", message: mediaError } });
  }
  const urlError = validateCreativeMediaUrls(input);
  if (urlError) {
    return json<ScreenActionPayload>({ ok: false, error: { code: "MEDIA_URL", message: urlError } });
  }
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json<ScreenActionPayload>({ ok: true, run });
};
```

- [ ] **Step 4: Write the dashboard route.** Create `app/routes/dashboard.api.campaigns.$id.screen.tsx`:

```tsx
// app/routes/dashboard.api.campaigns.$id.screen.tsx
// Dashboard mirror of dashboard.api.screener's POST, campaign-scoped. Drop-in
// "screen a new creative": JSON body → creativeInputFromJson → media + SSRF
// guards → executeScreen (persists a creative_screen_run). Campaign scoping
// rides on the destinationUrl UTM today (executeScreen has no campaignId arg);
// the persisted run folds into the blended score only once the creative exists
// as a Meta ad (Phase 3) — see phase note.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import {
  creativeInputFromJson,
  validateCreativeMedia,
  validateCreativeMediaUrls,
} from "~/lib/screener/media.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

export function parseScreenBody(body: Record<string, unknown>): {
  input: CreativeInput;
  assumedSpendCents: number;
} {
  const input = creativeInputFromJson(body);
  const raw = Math.round(Number(body.assumedSpendCents));
  const assumedSpendCents = Number.isFinite(raw)
    ? Math.min(Math.max(raw, MIN_SPEND_CENTS), MAX_SPEND_CENTS)
    : DEFAULT_SPEND_CENTS;
  return { input, assumedSpendCents };
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  void params.id; // campaign-scoped path; scoping rides on destinationUrl UTM (phase note)

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const { input, assumedSpendCents } = parseScreenBody(body);

  const mediaError = validateCreativeMedia(input);
  if (mediaError) return jsonError(422, "missing_creative_media", mediaError);
  const urlError = validateCreativeMediaUrls(input);
  if (urlError) return jsonError(422, "disallowed_media_url", urlError);

  return dashboardJson(async () => ({
    run: await executeScreen({ shop: session.shopDomain, input, assumedSpendCents }),
  }));
}
```

- [ ] **Step 5: Run the helper test and watch it pass.**

```bash
npx vitest run app/routes/__tests__/campaign-screen-helpers.test.ts
```

Expected: `Tests 5 passed`.

- [ ] **Step 6: Commit.**

```bash
git add app/routes/app.campaigns.\$campaignId.screen.tsx app/routes/dashboard.api.campaigns.\$id.screen.tsx app/routes/__tests__/campaign-screen-helpers.test.ts
git commit -m "routes/campaigns: drop-in Screen-a-new-creative (both surfaces) via executeScreen"
```

---

### Task 2.6: Dashboard client functions for the four new endpoints

Add the browser-side fetchers in `app/lib/dashboard/client.ts`, mirroring the existing `fetchCampaignDirection`/`screenCreative` style (`apiGet`/`apiSend`, both already exported). `client.ts` is browser-only and its top-of-file contract (line 8) forbids importing any `*.server` module — so the per-ad / creative wire shapes are declared as **browser-safe DTOs** here, built only from the browser-safe `~/lib/screener/types`. They are structurally identical to the server `AdScorecard` (`campaign-ads.server`) / `CampaignCreative` (`meta/creatives.server`) shapes; JSON is the only boundary, so nothing diverges.

```
Files:
  Modify: app/lib/dashboard/client.ts
```

- [ ] **Step 1: Widen the existing top-of-file screener types import.** In `app/lib/dashboard/client.ts`, replace the existing single-type import (currently `import type { CreativeScreenRun } from "~/lib/screener/types";`) with:

```ts
import type { CreativeScreenRun, ScoreCard, CreativeInput, Variant } from "~/lib/screener/types";
```

(`ScoreCard`, `CreativeInput`, and `Variant` are all defined in the browser-safe `~/lib/screener/types` — no `*.server` import is introduced. Keep this at the TOP of the file with the other imports; ESLint `import/first` forbids mid-file `import` statements.)

- [ ] **Step 2: Append the DTOs + client functions.** Add to the END of the "creative screener (Predictor)" section of `client.ts` (after `adaptScreenRun`, ~line 974). No `import` statements here — only declarations:

```ts
// --- campaign creatives + per-campaign regenerate / screen ------------------
// Browser-safe DTO mirrors of the server-side AdScorecard / CampaignCreative
// shapes. client.ts must not import any *.server module (top-of-file contract),
// so the wire shapes are re-declared here from the browser-safe screener/types.

export interface AdScorecardDTO {
  adId: string;
  status: "done" | "error";
  scorecard: ScoreCard | null;
  error: string | null;
}

export interface CampaignCreativeDTO {
  adId: string;
  adName: string;
  status: string;
  creative: CreativeInput;
}

export interface CampaignCreativesDTO {
  creatives: CampaignCreativeDTO[];
  scorecards: AdScorecardDTO[];
  assumedSpendCents: number;
  metaConnected: boolean;
  creativesError: string | null;
}

export async function fetchCampaignCreatives(
  campaignId: string,
  assumedSpendCents?: number,
): Promise<CampaignCreativesDTO> {
  const q = assumedSpendCents ? `?assumedSpendCents=${assumedSpendCents}` : "";
  return apiGet<CampaignCreativesDTO>(
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/creatives${q}`,
  );
}

export async function scoreCampaignAd(
  campaignId: string,
  payload: {
    adId: string;
    headline: string;
    primaryText: string;
    cta: string;
    destinationUrl: string;
    audience: string;
    imageUrl: string | null;
    assumedSpendCents: number;
  },
): Promise<AdScorecardDTO> {
  const data = await apiSend<{ scorecard: AdScorecardDTO }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/score`,
    payload,
  );
  return data.scorecard;
}

export type RegenerateDTO =
  | { ok: true; runId: string; weakestAdId: string; variants: Variant[]; allScored: Variant[]; generated: number; discarded: number }
  | { ok: false; reason: string };

export async function regenerateCampaign(
  campaignId: string,
  adIds: string[],
  assumedSpendCents: number,
): Promise<RegenerateDTO> {
  return apiSend<RegenerateDTO>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/regenerate`,
    { adIds, assumedSpendCents },
  );
}

export async function screenCampaignCreative(
  campaignId: string,
  payload: ScreenCreativePayload,
): Promise<CreativeScreenRun> {
  const data = await apiSend<{ run: CreativeScreenRun }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/screen`,
    payload,
  );
  return data.run;
}
```

(`ScreenCreativePayload`, `CreativeScreenRun`, `apiGet`, `apiSend` already exist/are exported in `client.ts`; `Variant`/`ScoreCard`/`CreativeInput` are imported in Step 1.)

- [ ] **Step 3: Typecheck the client module.**

```bash
npm run typecheck
```

Expected: exit 0 (no errors). The new functions are unused until Task 2.7 — that is fine (exported symbols are not flagged unused).

- [ ] **Step 4: Commit.**

```bash
git add app/lib/dashboard/client.ts
git commit -m "lib/dashboard/client: browser-safe creative DTOs + fetchCampaignCreatives/scoreCampaignAd/regenerateCampaign/screenCampaignCreative"
```

---

### Task 2.7: Dashboard-native `AdScorecardPanel` + Creatives/Regenerate/Screen sections in `Campaigns.tsx`

Render the three new CampaignDetail sections on the dashboard, mirroring the embedded `CreativeWithScorecard`/`AdScorecardSlot` behavior with dashboard primitives (conflict resolution #1). This is UI glue: the underlying logic is already unit-tested (Tasks 2.1–2.5), and the data contract is exercised in client tests; correctness here is enforced by `typecheck` + `lint` + `build` — the repo does not unit-test JSX (e.g. the embedded `CreativeWithScorecard` has no test). Forcing a test that asserts on markup would test nothing useful (rule 9).

```
Files:
  Create: app/components/dashboard/AdScorecardPanel.tsx
  Modify: app/components/dashboard/screens/Campaigns.tsx
```

- [ ] **Step 1: Create the dashboard-native scorecard component.** Create `app/components/dashboard/AdScorecardPanel.tsx`:

```tsx
// app/components/dashboard/AdScorecardPanel.tsx
// Dashboard render of one ad's predictive ScoreCard. The dashboard uses its own
// design system, so instead of the Polaris Scorecard this renders the same score
// data with the dashboard's primitives. Pure render — no server import;
// ~/lib/screener/types is a types-only module.
import {
  METRIC_GROUPS,
  METRIC_GROUP_LABELS,
  normalizeTip,
  type MetricGroup,
  type ScoreCard,
} from "~/lib/screener/types";
import { RingGauge, ScoreBar, Pill } from "./ui";

const GRADE_TONE: Record<string, "success" | "warn" | "critical"> = {
  winning: "success",
  okay: "warn",
  poor: "critical",
};
const GRADE_LABEL: Record<string, string> = {
  winning: "Winning",
  okay: "Okay",
  poor: "Poor",
};

export default function AdScorecardPanel({ card }: { card: ScoreCard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <RingGauge value={card.composite} />
        <div className="flex flex-col gap-1">
          <Pill tone={GRADE_TONE[card.grade] ?? "neutral"}>
            {GRADE_LABEL[card.grade] ?? card.grade}
          </Pill>
          <span className="cd-caption">Confidence: {card.confidence}</span>
        </div>
      </div>
      <p className="cd-body">{card.summary}</p>
      {METRIC_GROUPS.map((g: MetricGroup) => {
        const rows = card.metrics.filter((m) => m.group === g);
        if (rows.length === 0) return null;
        return (
          <div key={g} className="flex flex-col gap-2">
            <span style={{ fontWeight: 600 }}>{METRIC_GROUP_LABELS[g]}</span>
            {rows.map((m) => (
              <div key={m.id} className="flex flex-col gap-0.5">
                <span className="cd-body">{m.label}</span>
                <ScoreBar score={m.score} />
              </div>
            ))}
          </div>
        );
      })}
      {card.tips.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span style={{ fontWeight: 600 }}>How to improve it</span>
          {card.tips.map((t, i) => {
            const d = normalizeTip(t);
            return (
              <p key={i} className="cd-body">
                {i + 1}. {d.detail ? `${d.title} — ${d.detail}` : d.title}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the new sections into `CampaignDetail`.** In `app/components/dashboard/screens/Campaigns.tsx`:

  1. Add imports (the `react` hooks `useEffect`/`useState` are already imported at line 1; the `../ui` primitives `Card`, `SectionTitle`, `Btn`, `Placeholder`, `Pill` are already imported — do NOT re-add them). Add:

  ```tsx
  import AdScorecardPanel from "../AdScorecardPanel";
  import type { Variant, CreativeScreenRun } from "~/lib/screener/types";
  ```

  and extend the existing `~/lib/dashboard/client` import (line 21) with:

  ```tsx
  fetchCampaignCreatives,
  scoreCampaignAd,
  regenerateCampaign,
  screenCampaignCreative,
  type CampaignCreativesDTO,
  type CampaignCreativeDTO,
  type AdScorecardDTO,
  type RegenerateDTO,
  type ScreenCreativePayload,
  ```

  2. Inside the `CampaignDetail` component body (above its `return`, alongside the existing `status`/`busy`/`direction` state at lines 128–130), add the data + handlers:

```tsx
  const [creativeData, setCreativeData] = useState<CampaignCreativesDTO | null>(null);
  const [scored, setScored] = useState<Record<string, AdScorecardDTO>>({});
  const [scoring, setScoring] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [regenBusy, setRegenBusy] = useState(false);
  const [screenRun, setScreenRun] = useState<CreativeScreenRun | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetchCampaignCreatives(c.id)
      .then((d) => { if (live) setCreativeData(d); })
      .catch(() => { if (live) setCreativeData({ creatives: [], scorecards: [], assumedSpendCents: 0, metaConnected: false, creativesError: null }); });
    return () => { live = false; };
  }, [c.id]);

  const cachedByAd: Record<string, AdScorecardDTO> = {};
  for (const s of creativeData?.scorecards ?? []) cachedByAd[s.adId] = s;

  const scoreAd = async (ad: CampaignCreativeDTO) => {
    setScoring(ad.adId);
    try {
      const sc = await scoreCampaignAd(c.id, {
        adId: ad.adId,
        headline: ad.creative.headline,
        primaryText: ad.creative.primaryText,
        cta: ad.creative.cta,
        destinationUrl: ad.creative.destinationUrl,
        audience: ad.creative.audience,
        imageUrl: ad.creative.imageUrl,
        assumedSpendCents: creativeData?.assumedSpendCents ?? 50000,
      });
      setScored((m) => ({ ...m, [ad.adId]: sc }));
    } catch {
      app.toast("Couldn't score this ad — try again.", "x", "critical");
    } finally {
      setScoring(null);
    }
  };

  const runRegen = async () => {
    const adIds = (creativeData?.creatives ?? []).map((x) => x.adId).filter(Boolean);
    if (adIds.length === 0) { app.toast("No creatives to regenerate yet.", "x", "critical"); return; }
    setRegenBusy(true);
    try {
      const res: RegenerateDTO = await regenerateCampaign(c.id, adIds, creativeData?.assumedSpendCents ?? 50000);
      if (res.ok) {
        setVariants(res.variants);
        app.toast(res.variants.length > 0 ? `Generated ${res.variants.length} stronger variant(s).` : "No variant beat the original.", "sparkle", "success");
      } else {
        app.toast("Regenerate unavailable — score this campaign's ads first.", "x", "critical");
      }
    } catch {
      app.toast("Regenerate failed — try again.", "x", "critical");
    } finally {
      setRegenBusy(false);
    }
  };
```

  3. Insert the three section `Card`s into the returned JSX, after the existing `cd-stat-grid` block (recon ui-surfaces §1: dashboard `CampaignDetail` insertion point is after the stat grid), using the already-imported `Card`/`SectionTitle`/`Btn`/`Placeholder`/`Pill`:

```tsx
      {/* Creatives — per-ad predictive scorecards (cached now; score on demand) */}
      <Card pad={false}>
        <SectionTitle>Creatives</SectionTitle>
        <div style={{ padding: 16 }}>
          {!creativeData ? (
            <Placeholder icon="scan" title="Loading creatives…" />
          ) : !creativeData.metaConnected ? (
            <Placeholder icon="megaphone" title="Connect Meta to score creatives" sub="No score is fabricated until your ad account is connected." />
          ) : creativeData.creatives.length === 0 ? (
            <Placeholder icon="megaphone" title="No ads on this campaign yet" />
          ) : (
            <div className="flex flex-col gap-6">
              {creativeData.creatives.map((ad) => {
                const sc = scored[ad.adId] ?? cachedByAd[ad.adId];
                return (
                  <div key={ad.adId} className="flex flex-col gap-2">
                    <span style={{ fontWeight: 600 }}>{ad.adName || ad.adId}</span>
                    {sc && sc.status === "done" && sc.scorecard ? (
                      <AdScorecardPanel card={sc.scorecard} />
                    ) : sc && sc.status === "error" ? (
                      <span className="cd-caption">Analysis unavailable: {sc.error}</span>
                    ) : (
                      <Btn icon="scan" disabled={scoring === ad.adId} onClick={() => scoreAd(ad)}>
                        {scoring === ad.adId ? "Scoring…" : "Score this ad"}
                      </Btn>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Regenerate — copy variants seeded from the weakest scored ad */}
      <Card>
        <SectionTitle>Regenerate copy</SectionTitle>
        <p className="cd-body">Rewrites the campaign&apos;s weakest creative, re-scores each rewrite, and keeps only ones that beat it.</p>
        <div style={{ marginTop: 10 }}>
          <Btn icon="sparkle" kind="primary" disabled={regenBusy} onClick={runRegen}>
            {regenBusy ? "Generating…" : "Regenerate"}
          </Btn>
        </div>
        {variants.length > 0 && (
          <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
            {variants.map((v, i) => (
              <div key={i} style={{ background: "var(--cd-surface-2, #f5f5f5)", borderRadius: 12, padding: "12px 14px" }}>
                <div className="flex items-center gap-2">
                  <Pill tone="accent">{v.mode}</Pill>
                  <span style={{ fontWeight: 600 }}>{v.composite}</span>
                  <span className="cd-caption" style={{ color: "var(--cd-success, #1a7f37)" }}>+{v.delta}</span>
                </div>
                <p className="cd-body" style={{ marginTop: 6 }}>&ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}</p>
                <p className="cd-caption">{v.rationale}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Screen a new creative — drop-in scoring scoped to this campaign */}
      <Card>
        <SectionTitle>Screen a new creative</SectionTitle>
        <ScreenNewCreative
          busy={screenBusy}
          run={screenRun}
          onSubmit={async (payload) => {
            setScreenBusy(true);
            try {
              setScreenRun(await screenCampaignCreative(c.id, payload));
            } catch {
              app.toast("Couldn't screen that creative — check the image URL and try again.", "x", "critical");
            } finally {
              setScreenBusy(false);
            }
          }}
        />
      </Card>
```

  4. Add a small `ScreenNewCreative` internal component to `Campaigns.tsx` (mirrors the Predictor manual fields; submits an https/`data:` image URL so the SSRF guard passes — no client-side media processing needed for v1). It uses inline untyped `onChange` handlers, matching the Predictor convention (the dashboard screens never type events with `React.ChangeEvent`, and `React` is not in scope here):

```tsx
function ScreenNewCreative({
  busy,
  run,
  onSubmit,
}: {
  busy: boolean;
  run: CreativeScreenRun | null;
  onSubmit: (payload: ScreenCreativePayload) => void;
}) {
  const [f, setF] = useState({ headline: "", primaryText: "", cta: "SHOP_NOW", destinationUrl: "", audience: "", imageUrl: "" });
  return (
    <div className="flex flex-col gap-3">
      <label className="cd-field"><span>Headline</span><input className="cd-input" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} /></label>
      <label className="cd-field"><span>Primary text</span><textarea className="cd-input" rows={3} value={f.primaryText} onChange={(e) => setF({ ...f, primaryText: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="cd-field"><span>Call to action</span><input className="cd-input" value={f.cta} onChange={(e) => setF({ ...f, cta: e.target.value })} /></label>
        <label className="cd-field"><span>Audience</span><input className="cd-input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></label>
      </div>
      <label className="cd-field"><span>Where the click goes</span><input className="cd-input" value={f.destinationUrl} onChange={(e) => setF({ ...f, destinationUrl: e.target.value })} /></label>
      <label className="cd-field"><span>Image URL (https)</span><input className="cd-input" value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></label>
      <div>
        <Btn icon="scan" kind="primary" disabled={busy || !f.imageUrl} onClick={() => onSubmit({ ...f, mediaKind: "image", assumedSpendCents: 50000 })}>
          {busy ? "Scoring…" : "Score creative"}
        </Btn>
      </div>
      {run?.scorecard && <AdScorecardPanel card={run.scorecard} />}
      {run && run.status === "error" && <span className="cd-caption">Couldn&apos;t score: {run.error}</span>}
    </div>
  );
}
```

  (`app.toast(text, icon?, tone?)` is the real signature — confirmed at `Campaigns.tsx:184`; the `cd-field`/`cd-input`/`grid grid-cols-2 gap-3` class names match `Predictor.tsx`.)

- [ ] **Step 3: Typecheck + lint the touched files.**

```bash
npm run typecheck && npx eslint --max-warnings=0 app/components/dashboard/AdScorecardPanel.tsx app/components/dashboard/screens/Campaigns.tsx
```

Expected: exit 0. Fix any unused-import or type errors at the source (do not add `eslint-disable` or `any`).

- [ ] **Step 4: Commit.**

```bash
git add app/components/dashboard/AdScorecardPanel.tsx app/components/dashboard/screens/Campaigns.tsx
git commit -m "dashboard/Campaigns: per-ad scorecards + Regenerate + Screen-new-creative sections"
```

---

### Task 2.8: Embedded `CampaignDetailPage` — Regenerate + Screen-a-new-creative sections

Add the two new merchant actions to the embedded campaign detail (the per-ad Creatives section already exists there). UI glue posting to the Task 2.4 / 2.5 resource routes via `useFetcher` (same pattern as the existing `AdScorecardSlot` fetcher); enforced by `typecheck` + `lint` + `build` (the embedded route has no JSX unit test today).

```
Files:
  Modify: app/routes/app.campaigns.$campaignId.tsx
```

- [ ] **Step 1: Add the missing imports.** In `app/routes/app.campaigns.$campaignId.tsx`:

  - The `react` import (line 1) currently has `import { useEffect, useRef } from "react";` — add `useState`: `import { useEffect, useRef, useState } from "react";`.
  - The Polaris import (lines 6–18) is missing `Box`, `FormLayout`, and `TextField` — add all three to that import list. (`Badge`, `Banner`, `BlockStack`, `Button`, `Card`, `InlineStack`, `Spinner`, `Text` are already imported; `useFetcher` and `Scorecard` are already imported per recon ui-surfaces §5.)
  - Add the new resource-route payload types:

```tsx
import type { RegenActionPayload } from "./app.campaigns.$campaignId.regenerate";
import type { ScreenActionPayload } from "./app.campaigns.$campaignId.screen";
```

- [ ] **Step 2: Add the Regenerate `<Card>` component** to `app/routes/app.campaigns.$campaignId.tsx`. It posts the loader's creative ad ids to the regenerate resource route:

```tsx
function RegenerateCard({
  campaignIdParam,
  adIds,
  assumedSpendCents,
}: {
  campaignIdParam: string;
  adIds: string[];
  assumedSpendCents: number;
}) {
  const fetcher = useFetcher<RegenActionPayload>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const variants = data && data.ok ? data.variants : [];
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">Regenerate copy</Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Rewrites the campaign&apos;s weakest creative, re-scores each rewrite, and keeps only ones that beat it.
        </Text>
        <fetcher.Form
          method="post"
          action={`/app/campaigns/${encodeURIComponent(campaignIdParam)}/regenerate`}
        >
          <input type="hidden" name="adIds" value={JSON.stringify(adIds)} />
          <input type="hidden" name="assumedSpendCents" value={String(assumedSpendCents)} />
          <Button submit variant="primary" loading={busy} disabled={busy || adIds.length === 0}>
            Regenerate
          </Button>
        </fetcher.Form>
        {data && !data.ok && <Banner tone="warning">{data.error.message}</Banner>}
        {variants.map((v, i) => (
          <div key={i} style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 12, padding: "12px 14px" }}>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="info">{v.mode}</Badge>
              <Text as="span" variant="bodyMd" fontWeight="semibold">{String(v.composite)}</Text>
              <Text as="span" variant="bodySm" tone="success">{`+${v.delta}`}</Text>
            </InlineStack>
            <Box paddingBlockStart="150">
              <Text as="p" variant="bodyMd">&ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}</Text>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">{v.rationale}</Text>
          </div>
        ))}
      </BlockStack>
    </Card>
  );
}
```

  Render it in the page tree (inside `CampaignDetailPage`'s `<BlockStack gap="400">`, after the "Ad creatives" card), using the loader data already destructured there via `useLoaderData<typeof loader>()` (`detail`, `creatives`, `assumedSpendCents`, `campaignIdParam` per recon ui-surfaces §5):

```tsx
{detail && (
  <RegenerateCard
    campaignIdParam={campaignIdParam}
    adIds={creatives.map((c) => c.adId).filter(Boolean)}
    assumedSpendCents={assumedSpendCents}
  />
)}
```

- [ ] **Step 3: Add the Screen-a-new-creative `<Card>` component**, mirroring the screener manual form but posting to the screen resource route and rendering the embedded `Scorecard` on success:

```tsx
function ScreenNewCreativeCard({ campaignIdParam }: { campaignIdParam: string }) {
  const fetcher = useFetcher<ScreenActionPayload>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const card = data && data.ok && data.run.scorecard ? data.run.scorecard : null;
  const [imageUrl, setImageUrl] = useState("");
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">Screen a new creative</Text>
        <fetcher.Form
          method="post"
          action={`/app/campaigns/${encodeURIComponent(campaignIdParam)}/screen`}
        >
          <FormLayout>
            <TextField label="Headline" name="headline" autoComplete="off" />
            <TextField label="Primary text" name="primaryText" multiline={3} autoComplete="off" />
            <FormLayout.Group>
              <TextField label="Call to action" name="cta" autoComplete="off" placeholder="Shop now" />
              <TextField label="Audience" name="audience" autoComplete="off" />
            </FormLayout.Group>
            <TextField label="Where the click goes" name="destinationUrl" autoComplete="off" />
            <TextField label="Image URL (https)" name="imageUrl" autoComplete="off" value={imageUrl} onChange={setImageUrl} />
            <input type="hidden" name="mediaKind" value="image" />
            <Button submit variant="primary" loading={busy} disabled={busy || !imageUrl}>
              Score creative
            </Button>
          </FormLayout>
        </fetcher.Form>
        {data && !data.ok && <Banner tone="critical">{data.error.message}</Banner>}
        {data && data.ok && data.run.status === "error" && (
          <Banner tone="critical">{data.run.error}</Banner>
        )}
        {card && <Scorecard card={card} />}
      </BlockStack>
    </Card>
  );
}
```

  Render it after `RegenerateCard`:

```tsx
{detail && <ScreenNewCreativeCard campaignIdParam={campaignIdParam} />}
```

  (`Scorecard` takes `{ card: ScoreCard }`; `data.run.scorecard` narrows to `ScoreCard`. Polaris `TextField`'s `onChange` passes the new value string directly, so `onChange={setImageUrl}` is correct.)

- [ ] **Step 4: Typecheck + lint the touched file.**

```bash
npm run typecheck && npx eslint --max-warnings=0 app/routes/app.campaigns.\$campaignId.tsx
```

Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add app/routes/app.campaigns.\$campaignId.tsx
git commit -m "routes/app.campaigns.\$campaignId: Regenerate + Screen-new-creative cards"
```

---

### Task 2.9: Phase verification — full pre-commit gate

Run the CLAUDE.md pre-commit gate end-to-end and confirm green before declaring Phase 2 done. No Prisma/SQLite schema change and no `.graphql`/Admin-query change occurred in this phase (all data rides the existing `creative_screen_run` table and Supabase views), so `npx prisma validate`, `npx prisma migrate diff`, and `npm run graphql-codegen` are **not** applicable here (recon tests-build §6). No new Supabase migration was added, so the `tests/engine/schema/migrations/` byte-identical mirror convention does not apply this phase.

```
Files:
  (no new files — verification only)
```

- [ ] **Step 1: Code review.** Run `/code-review` on the working tree. Resolve every blocker; downgrade any nit with a one-line written justification.

- [ ] **Step 2: Patch sanity.**

```bash
git diff --stat
git diff --check
```

Expected: `git diff --check` prints nothing (no whitespace/conflict errors). Manually confirm the diff contains no stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, or AI/vibecode/provenance markers in browser-visible source (the new browser-facing files — `AdScorecardPanel.tsx`, `Campaigns.tsx` edits — keep comments technical and product-neutral; no internal-doc or design-tool references).

- [ ] **Step 3: Typecheck.**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Lint.**

```bash
npm run lint
```

Expected: exit 0 with zero warnings on the touched files (`--max-warnings=0` for the new code).

- [ ] **Step 5: Build (includes the browser-artifact verifier).**

```bash
npm run build
```

Expected: exit 0 — Remix + Vite build completes and `scripts/verify-client-bundle.mjs` passes. (This is also the gate that would catch any accidental `*.server` import leaking into a browser bundle — Task 2.6's browser-safe DTOs are why `client.ts`/`Campaigns.tsx` stay clean.)

- [ ] **Step 6: Full test suite.**

```bash
npm run test
```

Expected: exit 0 — all suites pass, including the five new specs:
`campaign-regen.test.ts`, `campaign-creatives-load.test.ts`, `dashboard-campaign-score-helpers.test.ts`, `campaign-regenerate-helpers.test.ts`, `campaign-screen-helpers.test.ts`.

- [ ] **Step 7: Confirm both surfaces shipped.** Verify the diff contains the embedded routes (`app.campaigns.$campaignId.{regenerate,screen}.tsx` + edits to `app.campaigns.$campaignId.tsx`) **and** the dashboard routes (`dashboard.api.campaigns.$id.{creatives,score,regenerate,screen}.tsx` + `Campaigns.tsx` + `AdScorecardPanel.tsx` + `client.ts`). Dashboard parity is satisfied for all three sub-features (Creatives, Regenerate, Screen) — no single-sided ship. If any gate step fails, stop and fix the root cause — do not `--no-verify`, `eslint-disable`, or narrow types to pass (rule 12).

---

## Phase 3: Meta paused-draft push via the action executor

**Goal:** Push a regenerated winning variant back to Meta as a `status:"PAUSED"` draft ad, routed through the existing action executor so it inherits idempotency, audit history, and undo — on both the dashboard and embedded surfaces. The UI exposes a per-variant "Push to Meta as paused draft" button that is disabled (with a reconnect prompt) when the stored Meta token lacks `ads_management`, and every failure produces a toast plus a failed audit row (never a silent success).

**Files**
```
Create: supabase/migrations/20260627121000_integration_credentials_scopes.sql
Create: app/lib/__tests__/integration-scope.test.ts
Create: app/lib/meta/ad-create.server.ts
Create: app/lib/meta/__tests__/ad-create.test.ts
Create: app/lib/actions/push-draft.server.ts
Create: app/lib/actions/__tests__/push-draft.test.ts
Create: app/lib/actions/__tests__/execute-push-draft.test.ts
Create: app/lib/actions/__tests__/undo-push-draft.test.ts
Create: app/routes/__tests__/dashboard-campaign-action-push.test.ts
Modify: app/lib/integration-status.ts                (hasAdsManagementScope, grantedScopesFromPermissions)
Modify: app/routes/auth.meta.$.tsx                   (persist granted scopes at OAuth callback)
Modify: app/lib/meta/creatives.server.ts             (listCampaignAdSets + MetaAdSet)
Modify: app/lib/types.ts                             (ActionKind += "push_creative_draft")
Modify: app/lib/actions/execute.server.ts            (ExecutableKind, ExecuteInput.creative, ExecuteDeps, push branch)
Modify: app/lib/actions/undo.server.ts               (push_creative_draft undo branch + deps seam)
Modify: app/routes/dashboard.api.campaigns.$id.action.tsx   (push_creative_draft branch)
Modify: app/routes/dashboard.api.analytics.tsx       (import getSupabase; meta_can_push_drafts in envelope)
Modify: app/lib/dashboard/client.ts                  (pushCreativeDraft + metaCanPushDrafts on fetchAnalytics)
Modify: app/components/dashboard/screens/Campaigns.tsx     (per-variant push button + disabled state)
Modify: app/routes/app.campaigns.$campaignId.tsx     (loader flag, action branch, per-variant push button)
```

> **Task ordering (rule 8 — read/define before use):** the capability helpers (`hasAdsManagementScope`) are defined in **Task 3.2** because `app/lib/meta/ad-create.server.ts` (Task 3.3) imports `hasAdsManagementScope`. A later definition would make Task 3.3's test fail at module load with "does not provide an export named hasAdsManagementScope" — there is no temporary stub.

> **Migration mirror note (rule 12):** `integration_credentials` is NOT part of the engine schema test fixture — verified: `grep -rl integration_credentials tests/engine/schema/migrations/` returns nothing, while the base table lives at `supabase/migrations/20260601010000_integration_credentials.sql`. Per the repo convention (only engine-schema-relevant tables get a byte-identical mirror), the scopes migration is **single-file** — do not create a `tests/engine/schema/migrations/` mirror, and state this in the commit.

> **Locked-contract gaps resolved in this phase (rule 7 — surfaced, not averaged):**
> 1. **No stored `page_id`.** Meta requires `object_story_spec.page_id` to create a link-data creative; it is stored nowhere. `createPausedAd` resolves it internally via `GET /{adAccountId}/promote_pages?fields=id` (first page) and fails loudly if none exists. The locked contract signature (`createPausedAd(client, { adAccountId, adSetId, creative })`) is unchanged.
> 2. **No ad-set fetch existed.** Added `listCampaignAdSets` (Task 3.1); the executor picks the campaign's first deliverable ad set.
> 3. **Executor only has `shopId`, not `shopDomain`.** Added `metaWriteClientForShopId(shopId)` mirroring `metaActionAdapterForShop`'s cred lookup (`app/lib/meta/actions.server.ts:76-104`).
> 4. **`MetaClient` has no DELETE verb.** Undo deletes the draft via the writable `status:"DELETED"` configured-status (`POST /{adId}`), reusing the existing `post()` — no widening of the shared type.
> 5. **Granted OAuth scopes were never stored.** `auth.meta.$.tsx` stores them at the callback (`GET /me/permissions`) into a new `scopes` column so the UI gate is deterministic without a live Graph call (Task 3.2).
> 6. **Two `check` helpers diverge (rule 7).** `campaigns.server.ts` exports a `check` that throws a plain `Error`; `actions.server.ts` has a *non-exported* retriable-aware `check`. Write paths need retriable classification, so `ad-create.server.ts` defines its own retriable-aware `check` (duplicating `META_PERMANENT_CODES`) — the same self-contained pattern `actions.server.ts` already uses.

---

### Task 3.1: Resolve a campaign's ad sets (`listCampaignAdSets`)

**Files**
```
Modify: app/lib/meta/creatives.server.ts
Create: app/lib/meta/__tests__/ad-create.test.ts   (shared file; this task adds the listCampaignAdSets describe block)
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/meta/__tests__/ad-create.test.ts` (mirrors the `fakeClient` pattern in `app/lib/meta/__tests__/campaigns.test.ts`):

```ts
import { describe, it, expect, vi } from "vitest";
import { listCampaignAdSets } from "../creatives.server";
import type { MetaClient } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("listCampaignAdSets", () => {
  it("requests the campaign's ad sets and maps id/name/status", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "as1", name: "Prospecting", status: "ACTIVE" },
        { id: "as2", name: "Retarget", status: "PAUSED" },
      ],
    }));
    const rows = await listCampaignAdSets(fakeClient({ get }), "120");
    expect(get).toHaveBeenCalledWith("/120/adsets", { fields: "id,name,status" });
    expect(rows).toEqual([
      { id: "as1", name: "Prospecting", status: "ACTIVE" },
      { id: "as2", name: "Retarget", status: "PAUSED" },
    ]);
  });

  it("rejects a non-numeric campaign id (injection guard)", async () => {
    await expect(listCampaignAdSets(fakeClient(), "../evil")).rejects.toThrow(/Invalid Meta campaign id/);
  });

  it("throws on a Graph error payload", async () => {
    const get = vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } }));
    await expect(listCampaignAdSets(fakeClient({ get }), "120")).rejects.toThrow(/Unknown id/);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/lib/meta/__tests__/ad-create.test.ts
```
Expected failure: `Failed to resolve import "../creatives.server"` for `listCampaignAdSets` — i.e. `listCampaignAdSets is not exported`.

- [ ] **Step 3: Write the minimal implementation.** Append to `app/lib/meta/creatives.server.ts` (after `listCampaignCreatives`), mirroring its numeric-id guard + `check` + `.data` map. `str` is the local helper (line 23) and `check`/`MetaClient`/`MetaResponse` are already imported from `./campaigns.server` (line 5); `check` returns the response (`campaigns.server.ts:36-45`), so `const body = check(await client.get(...))` is valid:

```ts
export interface MetaAdSet {
  id: string;
  name: string;
  status: string; // raw Meta status, e.g. "ACTIVE" | "PAUSED"
}

type RawAdSet = { id?: string; name?: string; status?: string };

// I/O — GET /{campaignId}/adsets. A created ad must belong to an ad set, but no
// other module fetches them; this is the source for the executor's draft target.
// Single page (no paging): a campaign with >25 ad sets would be truncated.
export async function listCampaignAdSets(
  client: MetaClient,
  campaignId: string,
): Promise<MetaAdSet[]> {
  // Injection safety: campaignId must be a Meta numeric id (same guard as
  // listCampaignCreatives). NEVER interpolate untrusted text into the path.
  if (!/^\d+$/.test(campaignId)) {
    throw new Error("Invalid Meta campaign id");
  }
  const body = check(await client.get(`/${campaignId}/adsets`, { fields: "id,name,status" }));
  const data = (body.data as RawAdSet[]) ?? [];
  return data.map((a) => ({
    id: str(a.id),
    name: str(a.name),
    status: str(a.status) || "UNKNOWN",
  }));
}
```

- [ ] **Step 4: Run it and see it pass.**
```bash
npx vitest run app/lib/meta/__tests__/ad-create.test.ts
```
Expected: `3 passed` for the `listCampaignAdSets` block.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/meta/creatives.server.ts app/lib/meta/__tests__/ad-create.test.ts
git commit -m "meta/creatives: add listCampaignAdSets to resolve a campaign's ad sets"
```

---

### Task 3.2: Capability detection — store + parse the `ads_management` scope

**Files**
```
Create: supabase/migrations/20260627121000_integration_credentials_scopes.sql
Create: app/lib/__tests__/integration-scope.test.ts
Modify: app/lib/integration-status.ts
Modify: app/routes/auth.meta.$.tsx
```

This task lands the "store + parse" side of the capability gate (pure helpers + migration + OAuth persistence) **before** `ad-create.server.ts` (Task 3.3) imports `hasAdsManagementScope`. The consumer `metaDraftPushEnabled` and its test arrive in Task 3.3.

- [ ] **Step 1: Write the failing test.** Create `app/lib/__tests__/integration-scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hasAdsManagementScope, grantedScopesFromPermissions } from "../integration-status";

describe("hasAdsManagementScope", () => {
  it("is true when ads_management is present", () => {
    expect(hasAdsManagementScope("ads_read,ads_management")).toBe(true);
    expect(hasAdsManagementScope(" ads_management , ads_read ")).toBe(true);
  });
  it("is false when absent, empty, or null", () => {
    expect(hasAdsManagementScope("ads_read")).toBe(false);
    expect(hasAdsManagementScope("")).toBe(false);
    expect(hasAdsManagementScope(null)).toBe(false);
    expect(hasAdsManagementScope(undefined)).toBe(false);
  });
});

describe("grantedScopesFromPermissions", () => {
  it("keeps only granted permissions, comma-joined", () => {
    const perms = {
      data: [
        { permission: "ads_management", status: "granted" },
        { permission: "ads_read", status: "granted" },
        { permission: "email", status: "declined" },
      ],
    };
    expect(grantedScopesFromPermissions(perms)).toBe("ads_management,ads_read");
  });
  it("returns '' on a malformed payload", () => {
    expect(grantedScopesFromPermissions(null)).toBe("");
    expect(grantedScopesFromPermissions({})).toBe("");
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/lib/__tests__/integration-scope.test.ts
```
Expected failure: `hasAdsManagementScope`/`grantedScopesFromPermissions` not exported from `../integration-status`.

- [ ] **Step 3: Write the minimal implementation.**

Append to `app/lib/integration-status.ts` (pure; the file is already "pure, safe on both surfaces" — these add no I/O):
```ts
/** True when a stored, comma-joined OAuth scope string carries ads_management
 *  (required to create ad creatives/ads). Pure; safe on both surfaces. */
export function hasAdsManagementScope(scopes: string | null | undefined): boolean {
  if (!scopes) return false;
  return scopes.split(",").map((s) => s.trim()).includes("ads_management");
}

/** Reduce a Graph GET /me/permissions payload to a comma-joined list of the
 *  GRANTED permissions. Defensive: a malformed payload yields "". */
export function grantedScopesFromPermissions(perms: unknown): string {
  const data = (perms as { data?: Array<{ permission?: unknown; status?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return "";
  return data
    .filter((p) => p?.status === "granted" && typeof p?.permission === "string")
    .map((p) => String(p.permission))
    .join(",");
}
```

Create `supabase/migrations/20260627121000_integration_credentials_scopes.sql`:
```sql
-- Persist the granted OAuth scopes for an integration so the app can tell
-- whether a Meta token carries ads_management (required to create paused-draft
-- ads) WITHOUT a live Graph call on every render. Populated at the OAuth
-- callback from GET /me/permissions; null on pre-existing rows (treated as no
-- scope by hasAdsManagementScope, so the push button stays safely disabled).
alter table public.integration_credentials
  add column if not exists scopes text;
```

In `app/routes/auth.meta.$.tsx`, persist the granted scopes. Add the import alongside the existing imports:
```ts
import { grantedScopesFromPermissions } from "~/lib/integration-status";
```
The route already defines `const GRAPH_VERSION = "v21.0";` (line 17) and `accessToken` (line 58). Immediately after the ad-account resolution block (i.e. after `const adAccountId = accountId ? ...` on line 75, right before `const now = ...` on line 77), fetch + reduce the granted permissions. A failure must NOT block pairing:
```ts
  // Capture the actually-granted scopes so the UI can gate the creative-draft
  // push deterministically. Best-effort: a permissions read failure leaves
  // scopes "" (push stays disabled) rather than failing the connection.
  let grantedScopes = "";
  try {
    const permsRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
    );
    grantedScopes = grantedScopesFromPermissions(await permsRes.json());
  } catch {
    grantedScopes = "";
  }
```
Add `scopes: grantedScopes,` to the `integration_credentials` upsert object (alongside `external_account_id: adAccountId,` / `updated_at: now,` on lines 86-87):
```ts
      external_account_id: adAccountId,
      scopes: grantedScopes,
      updated_at: now,
```

- [ ] **Step 4: Run it and see it pass.**
```bash
npx vitest run app/lib/__tests__/integration-scope.test.ts
```
Expected: `5 passed`. (No `npx prisma validate`/`migrate diff` — this is a Supabase/Postgres migration, separate from the Prisma/SQLite session store, per the recon. The OAuth route change is verified by `typecheck`/`build` in Task 3.8; its only new logic is the already-tested pure `grantedScopesFromPermissions`.)

- [ ] **Step 5: Commit.**
```bash
git add supabase/migrations/20260627121000_integration_credentials_scopes.sql app/lib/integration-status.ts app/routes/auth.meta.$.tsx app/lib/__tests__/integration-scope.test.ts
git commit -m "integrations: store + parse granted Meta scopes for the creative-draft gate

No engine-schema mirror: integration_credentials is not in tests/engine/schema/migrations."
```

---

### Task 3.3: Meta write helpers — `createPausedAd`, `deleteAd`, write-client + capability wiring

**Files**
```
Create: app/lib/meta/ad-create.server.ts
Modify: app/lib/meta/__tests__/ad-create.test.ts
Modify: app/lib/__tests__/integration-scope.test.ts   (append metaDraftPushEnabled describe)
```

- [ ] **Step 1: Write the failing tests.**

Prepend to `app/lib/meta/__tests__/ad-create.test.ts` (above the Task 3.1 block; reuses the hoisted `fakeClient` function declaration and the hoisted `vitest` imports):

```ts
import { createPausedAd, deleteAd } from "../ad-create.server";
import type { CreativeInput } from "~/lib/screener/types";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off everything this week.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

describe("createPausedAd", () => {
  it("resolves a page, creates a creative, then a PAUSED ad, returning the new ad id", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/act_1/promote_pages" ? { data: [{ id: "page_55" }] } : { data: [] },
    );
    const post = vi.fn(async (path: string) => {
      if (path === "/act_1/adcreatives") return { id: "crea_9" };
      if (path === "/as1/ads") return { id: "ad_777" };
      return {};
    });

    const res = await createPausedAd(fakeClient({ get, post }), {
      adAccountId: "act_1",
      adSetId: "as1",
      creative: CREATIVE,
    });

    expect(get).toHaveBeenCalledWith("/act_1/promote_pages", { fields: "id" });
    // 1) creative carries the resolved page_id + link_data built from the variant
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/act_1/adcreatives",
      expect.objectContaining({
        object_story_spec: expect.stringContaining('"page_id":"page_55"'),
      }),
    );
    expect((post.mock.calls[0][1] as Record<string, string>).object_story_spec).toContain(
      '"link":"https://shop.example.com/sale"',
    );
    // 2) ad references the creative, is PAUSED, and joins the supplied ad set
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/as1/ads",
      expect.objectContaining({
        adset_id: "as1",
        status: "PAUSED",
        creative: expect.stringContaining('"creative_id":"crea_9"'),
      }),
    );
    expect(res).toEqual({ adId: "ad_777" });
  });

  it("fails loudly when the ad account has no usable Facebook Page", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    await expect(
      createPausedAd(fakeClient({ get }), { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE }),
    ).rejects.toThrow(/no Facebook Page/i);
  });

  it("throws on a permanent Graph error (permission denied) from the creative call", async () => {
    const get = vi.fn(async () => ({ data: [{ id: "page_55" }] }));
    const post = vi.fn(async () => ({ error: { message: "Permission denied", code: 200 } }));
    await expect(
      createPausedAd(fakeClient({ get, post }), { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE }),
    ).rejects.toThrow(/Permission denied/);
  });
});

describe("deleteAd", () => {
  it("deletes an ad by setting the writable status to DELETED", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await deleteAd(fakeClient({ post }), "ad_777");
    expect(post).toHaveBeenCalledWith("/ad_777", { status: "DELETED" });
  });

  it("throws on a Graph error payload", async () => {
    const post = vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } }));
    await expect(deleteAd(fakeClient({ post }), "ad_777")).rejects.toThrow(/Unknown id/);
  });
});
```

Append to `app/lib/__tests__/integration-scope.test.ts` (distinct `vi` import — no duplicate identifiers with the Task 3.2 `{ describe, it, expect }`):
```ts
import { vi } from "vitest";
import { metaDraftPushEnabled } from "../meta/ad-create.server";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("metaDraftPushEnabled", () => {
  function fakeSb(scopes: string | null, error = false): SupabaseClient {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      error ? { data: null, error: { message: "x" } } : { data: { scopes }, error: null },
    );
    return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  }
  it("true when the stored token carries ads_management", async () => {
    expect(await metaDraftPushEnabled(fakeSb("ads_management,ads_read"), "shop")).toBe(true);
  });
  it("false when ads_management is missing", async () => {
    expect(await metaDraftPushEnabled(fakeSb("ads_read"), "shop")).toBe(false);
  });
  it("false when the lookup errors (no false-enable)", async () => {
    expect(await metaDraftPushEnabled(fakeSb(null, true), "shop")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
```bash
npx vitest run app/lib/meta/__tests__/ad-create.test.ts app/lib/__tests__/integration-scope.test.ts
```
Expected failure: `Failed to resolve import "../ad-create.server"` (the module does not exist yet).

- [ ] **Step 3: Write the minimal implementation.** Create `app/lib/meta/ad-create.server.ts`:

```ts
// Create a PAUSED "draft" ad on Meta and delete it again (for undo). Writes go
// through the retriable-aware `check` + `withRetry` so brief throttles back off
// and Meta-permanent errors (token/permission) fail terminally — the executor's
// try/catch then classifies via isRetriableFailure. The MetaClient is injected
// so tests pass a fake post/get (mirrors meta/__tests__/campaigns.test.ts).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { ActionError } from "../ads/actions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaClient, type MetaResponse } from "./campaigns.server";
import { throttleMetaClient } from "./throttle.server";
import { hasAdsManagementScope } from "../integration-status";
import type { CreativeInput } from "~/lib/screener/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Mirrors the canonical list in meta/actions.server.ts. That module's `check` is
// NOT exported, so this write module keeps its own retriable-aware copy by repo
// convention (campaigns.server + actions.server already each define their own).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    const codeStr = code != null ? ` (code ${code})` : "";
    throw new ActionError("meta", `${r.error.message}${codeStr}`, {
      retriable: !(code != null && META_PERMANENT_CODES.has(code)),
    });
  }
  return r;
}

export interface MetaWriteConn {
  client: MetaClient;
  adAccountId: string; // "act_<id>"
}

/** First usable Facebook Page for the ad account; required for object_story_spec.
 *  Not stored anywhere today, so resolved live. Fails loudly when none exists. */
async function resolvePageId(client: MetaClient, adAccountId: string): Promise<string> {
  const body = check(await client.get(`/${adAccountId}/promote_pages`, { fields: "id" }));
  const page = ((body.data as Array<{ id?: string }>) ?? [])[0];
  const pageId = page?.id ? String(page.id) : "";
  if (!pageId) {
    throw new Error("Meta ad account has no Facebook Page to attach the creative; reconnect Meta with a Page selected");
  }
  return pageId;
}

/**
 * Create a paused draft ad: POST /{adAccountId}/adcreatives, then
 * POST /{adSetId}/ads with status PAUSED. Returns the new ad id for undo.
 * Signature matches the locked contract: (client, { adAccountId, adSetId, creative }).
 */
export async function createPausedAd(
  client: MetaClient,
  args: { adAccountId: string; adSetId: string; creative: CreativeInput },
): Promise<{ adId: string }> {
  const { adAccountId, adSetId, creative } = args;
  const pageId = await resolvePageId(client, adAccountId);
  const cta = creative.cta || "SHOP_NOW";

  const linkData: Record<string, unknown> = {
    message: creative.primaryText,
    link: creative.destinationUrl,
    name: creative.headline,
    call_to_action: { type: cta, value: { link: creative.destinationUrl } },
  };
  if (creative.imageUrl) linkData.picture = creative.imageUrl;
  const objectStorySpec = JSON.stringify({ page_id: pageId, link_data: linkData });

  const creativeRes = await withRetry(
    async () =>
      check(
        await client.post(`/${adAccountId}/adcreatives`, {
          name: creative.headline || "Calderyn draft creative",
          object_story_spec: objectStorySpec,
        }),
      ),
    DEFAULT_RETRY,
  );
  const creativeId = String((creativeRes as { id?: unknown }).id ?? "");
  if (!creativeId) throw new Error("Meta did not return a creative id");

  const adRes = await withRetry(
    async () =>
      check(
        await client.post(`/${adSetId}/ads`, {
          name: creative.headline || "Calderyn draft ad",
          adset_id: adSetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
        }),
      ),
    DEFAULT_RETRY,
  );
  const adId = String((adRes as { id?: unknown }).id ?? "");
  if (!adId) throw new Error("Meta did not return an ad id");
  return { adId };
}

/** Delete a draft ad for undo. MetaClient has no DELETE verb, so we set the
 *  writable configured status to DELETED — the ad leaves the active account set. */
export async function deleteAd(client: MetaClient, adId: string): Promise<void> {
  await withRetry(async () => {
    check(await client.post(`/${adId}`, { status: "DELETED" }));
  }, DEFAULT_RETRY);
}

/** Resolve a Meta write client by shopId (the executor only has shopId, not the
 *  shop domain). Mirrors metaActionAdapterForShop's cred lookup. */
export async function metaWriteClientForShopId(shopId: string): Promise<MetaWriteConn | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const adAccountId = (data.external_account_id as string | null) ?? "";
  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      return (await fetch(`${GRAPH_BASE}${path}?${qs}`).then((r) => r.json())) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      return (await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }).then((r) => r.json())) as MetaResponse;
    },
  };
  return { client: throttleMetaClient(client, shopId), adAccountId };
}

/** True when the stored Meta token carries ads_management (required to create
 *  ads). DI'd sb for tests. Read failure / missing scopes ⇒ false (no false-enable). */
export async function metaDraftPushEnabled(sb: SupabaseClient, shopId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("integration_credentials")
    .select("scopes")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) return false;
  return hasAdsManagementScope((data?.scopes as string | null) ?? null);
}
```

- [ ] **Step 4: Run them and see them pass.**
```bash
npx vitest run app/lib/meta/__tests__/ad-create.test.ts app/lib/__tests__/integration-scope.test.ts
```
Expected: `ad-create.test.ts` → `8 passed` (5 createPausedAd/deleteAd + 3 listCampaignAdSets); `integration-scope.test.ts` → `8 passed` (5 pure + 3 metaDraftPushEnabled).

- [ ] **Step 5: Commit.**
```bash
git add app/lib/meta/ad-create.server.ts app/lib/meta/__tests__/ad-create.test.ts app/lib/__tests__/integration-scope.test.ts
git commit -m "meta/ad-create: createPausedAd + deleteAd + shopId write-client + draft-push capability"
```

---

### Task 3.4: Push-draft pure helpers — idempotency key + creative validation

**Files**
```
Create: app/lib/actions/push-draft.server.ts
Create: app/lib/actions/__tests__/push-draft.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/actions/__tests__/push-draft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pushCreativeDraftKey, parsePushDraftCreative } from "../push-draft.server";
import type { CreativeInput } from "~/lib/screener/types";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off everything.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

describe("pushCreativeDraftKey", () => {
  it("is deterministic for the same campaign + variant", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).toBe(pushCreativeDraftKey("camp-1", CREATIVE));
  });

  it("differs when the campaign differs", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).not.toBe(pushCreativeDraftKey("camp-2", CREATIVE));
  });

  it("differs when any variant field differs", () => {
    const other = { ...CREATIVE, headline: "Winter Sale" };
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).not.toBe(pushCreativeDraftKey("camp-1", other));
  });

  it("is independent of object key insertion order", () => {
    const reordered: CreativeInput = {
      audience: "",
      destinationUrl: "https://shop.example.com/sale",
      cta: "SHOP_NOW",
      primaryText: "50% off everything.",
      headline: "Summer Sale",
      imageUrl: "https://cdn.example.com/a.jpg",
    };
    expect(pushCreativeDraftKey("camp-1", reordered)).toBe(pushCreativeDraftKey("camp-1", CREATIVE));
  });

  it("is prefixed and a sha256 hex digest", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).toMatch(/^push_creative_draft:[a-f0-9]{64}$/);
  });
});

describe("parsePushDraftCreative", () => {
  it("accepts a well-formed creative payload", () => {
    const res = parsePushDraftCreative({
      headline: "  Summer Sale ",
      primaryText: "50% off.",
      cta: "SHOP_NOW",
      destinationUrl: "https://shop.example.com/sale",
      imageUrl: "https://cdn.example.com/a.jpg",
      audience: "warm",
    });
    expect(res).toEqual({
      ok: true,
      creative: {
        headline: "Summer Sale",
        primaryText: "50% off.",
        cta: "SHOP_NOW",
        destinationUrl: "https://shop.example.com/sale",
        imageUrl: "https://cdn.example.com/a.jpg",
        audience: "warm",
      },
    });
  });

  it("defaults a blank cta to SHOP_NOW and null imageUrl", () => {
    const res = parsePushDraftCreative({
      headline: "H",
      primaryText: "P",
      destinationUrl: "https://shop.example.com/x",
    });
    expect(res).toMatchObject({ ok: true, creative: { cta: "SHOP_NOW", imageUrl: null, audience: "" } });
  });

  it("rejects a missing headline", () => {
    const res = parsePushDraftCreative({ primaryText: "P", destinationUrl: "https://x.com" });
    expect(res).toEqual({ ok: false, error: "missing_headline" });
  });

  it("rejects a missing/non-http destination url", () => {
    expect(parsePushDraftCreative({ headline: "H", destinationUrl: "" })).toEqual({
      ok: false,
      error: "missing_destination_url",
    });
    expect(parsePushDraftCreative({ headline: "H", destinationUrl: "javascript:alert(1)" })).toEqual({
      ok: false,
      error: "missing_destination_url",
    });
  });

  it("rejects a non-object body", () => {
    expect(parsePushDraftCreative(null)).toEqual({ ok: false, error: "invalid_creative" });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/lib/actions/__tests__/push-draft.test.ts
```
Expected failure: `Failed to resolve import "../push-draft.server"`.

- [ ] **Step 3: Write the minimal implementation.** Create `app/lib/actions/push-draft.server.ts`:

```ts
// Pure helpers shared by both push_creative_draft routes: a deterministic
// idempotency key derived from the campaign + serialized variant (so a retry of
// the SAME variant dedups, while a distinct variant gets a distinct key), and a
// boundary validator for the inbound creative payload (rule: validate FormData/
// JSON shapes at the action boundary — never trust them).

import { createHash } from "node:crypto";
import type { CreativeInput } from "~/lib/screener/types";

/** Stable serialization in a FIXED field order (not JSON.stringify of the whole
 *  object, whose key order is caller-dependent). */
function serializeVariant(creative: CreativeInput): string {
  return [
    creative.headline,
    creative.primaryText,
    creative.cta,
    creative.destinationUrl,
    creative.imageUrl ?? "",
    creative.audience,
  ].join("\u0000");
}

export function pushCreativeDraftKey(campaignId: string, creative: CreativeInput): string {
  const payload = `${campaignId}\u0000${serializeVariant(creative)}`;
  return `push_creative_draft:${createHash("sha256").update(payload).digest("hex")}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export type ParsedPushDraft =
  | { ok: true; creative: CreativeInput }
  | { ok: false; error: string };

export function parsePushDraftCreative(raw: unknown): ParsedPushDraft {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "invalid_creative" };
  const b = raw as Record<string, unknown>;
  const headline = str(b.headline);
  if (!headline) return { ok: false, error: "missing_headline" };
  const destinationUrl = str(b.destinationUrl);
  if (!/^https?:\/\//i.test(destinationUrl)) return { ok: false, error: "missing_destination_url" };
  const imageRaw = str(b.imageUrl);
  return {
    ok: true,
    creative: {
      headline,
      primaryText: str(b.primaryText),
      cta: str(b.cta) || "SHOP_NOW",
      destinationUrl,
      imageUrl: imageRaw.length > 0 ? imageRaw : null,
      audience: str(b.audience),
    },
  };
}
```

- [ ] **Step 4: Run it and see it pass.**
```bash
npx vitest run app/lib/actions/__tests__/push-draft.test.ts
```
Expected: `12 passed`.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/actions/push-draft.server.ts app/lib/actions/__tests__/push-draft.test.ts
git commit -m "actions/push-draft: deterministic idempotency key + creative boundary validator"
```

---

### Task 3.5: Route `push_creative_draft` through the executor

**Files**
```
Modify: app/lib/types.ts
Modify: app/lib/actions/execute.server.ts
Create: app/lib/actions/__tests__/execute-push-draft.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/actions/__tests__/execute-push-draft.test.ts` (self-contained fake `sb`, modeled on `execute.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction, type ExecuteDeps } from "../execute.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreativeInput } from "~/lib/screener/types";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

function fakeSb(opts: { idempotent?: { audit_id: string }; campaign?: Record<string, unknown> | null }) {
  const calls = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.update = vi.fn((payload: unknown) => {
      calls.updates.push({ table, payload });
      return chain;
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === "action_idempotency") return { data: opts.idempotent ?? null, error: null };
      if (table === "ad_campaign_dim") return { data: opts.campaign ?? null, error: null };
      if (table === "action_audit") return { data: { id: "aud1", outcome: "succeeded" }, error: null };
      return { data: null, error: null };
    });
    chain.single = vi.fn(async () => ({ data: { id: "aud1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const metaCampaign = { id: CAMP, shop_id: SHOP, external_id: "120", platform: "meta", status: "active", daily_budget_cents: 5000 };

function fakeDeps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    resolveMetaWriteClient: vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" })),
    listCampaignAdSets: vi.fn(async () => [{ id: "as1", name: "Prospecting", status: "ACTIVE" }]),
    createPausedAd: vi.fn(async () => ({ adId: "ad_777" })),
    ...over,
  };
}

describe("executeAction — push_creative_draft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a paused ad and writes a succeeded audit with created_ad_id (no campaign mirror)", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const deps = fakeDeps();
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h1", creative: CREATIVE },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(deps.createPausedAd).toHaveBeenCalledWith({}, { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE });
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect(audit?.rows as Record<string, unknown>).toMatchObject({
      action_kind: "push_creative_draft",
      outcome: "succeeded",
      post_state: { created_ad_id: "ad_777", status: "PAUSED", adset_id: "as1" },
      dollar_impact_at_exec: 0,
    });
    // a creative draft creates a NEW object — it must NOT mutate ad_campaign_dim
    expect(calls.updates.filter((u) => u.table === "ad_campaign_dim")).toEqual([]);
    expect(calls.inserts.some((i) => i.table === "action_idempotency")).toBe(true);
  });

  it("refuses (throws) when the creative is missing", async () => {
    const { sb } = fakeSb({ campaign: metaCampaign });
    await expect(
      executeAction(SHOP, { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h2" }, sb, fakeDeps()),
    ).rejects.toThrow(/creative/i);
  });

  it("is a no-op on a replayed idempotency key (does not create a second ad)", async () => {
    const { sb } = fakeSb({ idempotent: { audit_id: "prev" }, campaign: metaCampaign });
    const deps = fakeDeps();
    const res = await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h1", creative: CREATIVE },
      sb,
      deps,
    );
    expect(res.outcome).toBe("succeeded");
    expect(deps.createPausedAd).not.toHaveBeenCalled();
  });

  it("records a failed audit on a non-Meta campaign (no ad created)", async () => {
    const { sb, calls } = fakeSb({ campaign: { ...metaCampaign, platform: "google" } });
    const deps = fakeDeps();
    await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h3", creative: CREATIVE },
      sb,
      deps,
    );
    expect(deps.createPausedAd).not.toHaveBeenCalled();
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).outcome).toBe("failed");
    expect((audit?.rows as Record<string, unknown>).post_state).toBeNull();
  });

  it("records a failed audit (fail-fast) when Meta is not connected", async () => {
    const { sb, calls } = fakeSb({ campaign: metaCampaign });
    const deps = fakeDeps({ resolveMetaWriteClient: vi.fn(async () => null) });
    await executeAction(
      SHOP,
      { alertId: null, kind: "push_creative_draft", campaignId: CAMP, idempotencyKey: "h4", creative: CREATIVE },
      sb,
      deps,
    );
    expect(deps.createPausedAd).not.toHaveBeenCalled();
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/lib/actions/__tests__/execute-push-draft.test.ts
```
Expected failure: `push_creative_draft` is not assignable to `ExecutableKind` / `ExecuteDeps` is not exported / `creative` not in `ExecuteInput` — compile-time TS errors surfaced by vitest.

- [ ] **Step 3: Write the minimal implementation.**

In `app/lib/types.ts`, extend the `ActionKind` union (so `recoveredCentsFromStates(... as ActionKind)` type-checks). It is intentionally NOT added to `VALUE_RECOVERING` in `audit-impact.ts`, so it correctly recovers $0 (verified: `recoveredCentsForAction`/`recoveredCentsFromStates` both early-return 0 for non-recovering kinds):
```ts
  | "adjust_price"
  | "snooze_alert"
  | "push_creative_draft";
```

In `app/lib/actions/execute.server.ts`, add imports after the existing imports (lines 6-12):
```ts
import type { MetaWriteConn } from "../meta/ad-create.server";
import { createPausedAd, metaWriteClientForShopId } from "../meta/ad-create.server";
import { listCampaignAdSets, type MetaAdSet } from "../meta/creatives.server";
import type { MetaClient } from "../meta/campaigns.server";
import type { CreativeInput } from "~/lib/screener/types";
```

Extend `ExecutableKind` (lines 14-18):
```ts
export type ExecutableKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "push_creative_draft";
```

Add the optional `creative` field to `ExecuteInput` (after `triggerReason`, line 29):
```ts
  /** Required for push_creative_draft: the winning variant to publish as a
   *  PAUSED draft ad. Ignored by every other kind. */
  creative?: CreativeInput;
```

Add the DI seam type after `ExecuteInput`:
```ts
/** Injectable Meta-write seams so the executor's push_creative_draft path is
 *  unit-testable without a live Graph client. Defaults wire the real helpers. */
export interface ExecuteDeps {
  resolveMetaWriteClient?: (shopId: string) => Promise<MetaWriteConn | null>;
  listCampaignAdSets?: (client: MetaClient, campaignId: string) => Promise<MetaAdSet[]>;
  createPausedAd?: (
    client: MetaClient,
    args: { adAccountId: string; adSetId: string; creative: CreativeInput },
  ) => Promise<{ adId: string }>;
}
```

Change `executeAction`'s signature (line 178) to accept `deps` (the optional default keeps every existing 3-arg caller — autopilot, retry drain, alert/dashboard routes — source-compatible):
```ts
export async function executeAction(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
  deps: ExecuteDeps = {},
): Promise<ExecutedAudit> {
```

In step 0 (input validation, after the budget guard at lines 185-192), add the creative-presence guard:
```ts
  if (input.kind === "push_creative_draft" && !input.creative) {
    throw new Error(`push_creative_draft for ${input.campaignId} has no creative variant to publish`);
  }
```

After `preState` is computed (immediately after `const preState = ...;` on line 210, BEFORE `const postState =` on line 211), branch out so the push path inherits idempotency + ownership but skips the postState/I5/adapter/mirror campaign-mutation pipeline:
```ts
  // Creative-draft is not a campaign mutation — it creates a NEW ad object, so
  // it has its own post-state shape and skips the campaign mirror. Routed here
  // (after idempotency + ownership) so it still inherits both for free.
  if (input.kind === "push_creative_draft") {
    return executePushCreativeDraft(shopId, input, sb, { camp, externalId, platform }, deps);
  }
```

Add the helper at the end of the file. It fails FAST on a null write client (matching the existing `!adapter` convention at lines 274-278 — "not connected" is permanent, recorded `failed`, never parked `retrying`); only a thrown Meta error inside the try is classified via `isRetriableFailure`:
```ts
async function executePushCreativeDraft(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
  ctx: { camp: { status?: unknown; daily_budget_cents?: unknown }; externalId: string; platform: string },
  deps: ExecuteDeps,
): Promise<ExecutedAudit> {
  const { camp, externalId, platform } = ctx;
  const preState = { status: camp.status, daily_budget_cents: camp.daily_budget_cents };

  let outcome: "succeeded" | "failed" | "retrying" = "succeeded";
  let lastError: string | null = null;
  let postState: Record<string, unknown> | null = null;
  let adSetId: string | null = null;
  let createdAdId: string | null = null;

  if (platform.toLowerCase() !== "meta") {
    // Creative push is Meta-only; refuse on other platforms rather than forcing
    // Google/TikTok adapters to implement ad creation.
    outcome = "failed";
    lastError = `push_creative_draft is only supported on Meta (campaign platform: ${platform})`;
  } else {
    const resolveClient = deps.resolveMetaWriteClient ?? metaWriteClientForShopId;
    const listAdSets = deps.listCampaignAdSets ?? listCampaignAdSets;
    const create = deps.createPausedAd ?? createPausedAd;
    const conn = await resolveClient(shopId);
    if (!conn) {
      // No integration / token — permanent until reconnect, so fail fast rather
      // than burn the retry budget (mirrors the adapter-null path above).
      outcome = "failed";
      lastError = "Meta not connected";
    } else {
      try {
        const adsets = await listAdSets(conn.client, externalId);
        const target =
          adsets.find((a) => a.status === "ACTIVE") ??
          adsets.find((a) => a.status === "PAUSED") ??
          adsets[0];
        if (!target) throw new Error(`campaign ${externalId} has no ad set to receive the draft`);
        adSetId = target.id;
        const { adId } = await create(conn.client, {
          adAccountId: conn.adAccountId,
          adSetId,
          creative: input.creative as CreativeInput,
        });
        createdAdId = adId;
        postState = { created_ad_id: adId, status: "PAUSED", adset_id: adSetId };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Transient Meta errors park as `retrying`; known-permanent (ActionError
        // retriable:false — bad token/permission) fail terminally.
        outcome = isRetriableFailure(err) ? "retrying" : "failed";
      }
    }
  }

  // No ad_campaign_dim mirror: nothing about the campaign changed.
  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: input.kind,
      params: {
        campaign_id: input.campaignId,
        external_id: externalId,
        platform,
        adset_id: adSetId,
        created_ad_id: createdAdId,
      },
      outcome,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
      trigger_reason: input.triggerReason ?? null,
    },
    sb,
  );
}
```

- [ ] **Step 4: Run it and see it pass.** Also re-run the existing executor suite to prove no regression from the new optional `deps` param.
```bash
npx vitest run app/lib/actions/__tests__/execute-push-draft.test.ts app/lib/actions/__tests__/execute.test.ts
```
Expected: new file `5 passed`; `execute.test.ts` still fully green.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/types.ts app/lib/actions/execute.server.ts app/lib/actions/__tests__/execute-push-draft.test.ts
git commit -m "actions/execute: add push_creative_draft ExecutableKind (Meta paused-draft via executor)"
```

---

### Task 3.6: Undo a `push_creative_draft` (delete the created ad)

**Files**
```
Modify: app/lib/actions/undo.server.ts
Create: app/lib/actions/__tests__/undo-push-draft.test.ts
```

- [ ] **Step 1: Write the failing test.** Create `app/lib/actions/__tests__/undo-push-draft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// undo.server imports the action registry at module scope; this kind does not
// resolve an adapter, but keep the mock to avoid live wiring on import.
vi.mock("../../ads/action-registry.server", () => ({ actionAdapterForShop: vi.fn(async () => null) }));

const SHOP = "00000000-0000-0000-0000-000000000010";

function fakeSb(original: Record<string, unknown> | null, existingUndo: { id: string } | null = null) {
  const calls = { inserts: [] as Array<{ table: string; rows: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    let selected = "";
    chain.select = vi.fn((cols: string) => {
      selected = cols;
      return chain;
    });
    chain.eq = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: table !== "action_audit" ? null : selected === "id" ? existingUndo : original,
      error: null,
    }));
    chain.single = vi.fn(async () => ({ data: { id: "undo1" }, error: null }));
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.update = vi.fn(() => chain);
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const pushAudit = {
  id: "aud1",
  shop_id: SHOP,
  alert_id: null,
  action_kind: "push_creative_draft",
  params: { campaign_id: "c-uuid", external_id: "120", platform: "meta", adset_id: "as1", created_ad_id: "ad_777" },
  pre_state: { status: "active", daily_budget_cents: 5000 },
  post_state: { created_ad_id: "ad_777", status: "PAUSED", adset_id: "as1" },
  dollar_impact_at_exec: 0,
  undo_of: null,
  outcome: "succeeded",
  created_at: new Date().toISOString(),
  actor_user_id: "merchant:web-dashboard",
};

describe("undoAction — push_creative_draft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the created ad and writes an undo audit", async () => {
    const { sb, calls } = fakeSb(pushAudit);
    const deleteAd = vi.fn(async () => {});
    const resolveMetaWriteClient = vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" }));
    await undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient, deleteAd });
    expect(resolveMetaWriteClient).toHaveBeenCalledWith(SHOP);
    expect(deleteAd).toHaveBeenCalledWith({}, "ad_777");
    const undo = calls.inserts.find((i) => i.table === "action_audit");
    expect(undo?.rows as Record<string, unknown>).toMatchObject({ undo_of: "aud1", outcome: "succeeded" });
  });

  it("refuses when the audit lacks created_ad_id", async () => {
    const broken = { ...pushAudit, post_state: { status: "PAUSED", adset_id: "as1" } };
    const { sb } = fakeSb(broken);
    const deleteAd = vi.fn(async () => {});
    await expect(
      undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient: vi.fn(async () => ({ client: {} as never, adAccountId: "act_1" })), deleteAd }),
    ).rejects.toThrow(/created_ad_id/i);
    expect(deleteAd).not.toHaveBeenCalled();
  });

  it("refuses when Meta is not connected", async () => {
    const { sb } = fakeSb(pushAudit);
    await expect(
      undoAction(SHOP, "aud1", sb, { resolveMetaWriteClient: vi.fn(async () => null), deleteAd: vi.fn() }),
    ).rejects.toThrow(/not connected/i);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/lib/actions/__tests__/undo-push-draft.test.ts
```
Expected failure: it falls into the existing final `else` → `undo not supported for action kind push_creative_draft`, and `deps.resolveMetaWriteClient`/`deps.deleteAd` are not part of the deps type (TS error).

- [ ] **Step 3: Write the minimal implementation.** In `app/lib/actions/undo.server.ts`:

Add imports near the top (after the existing imports, lines 5-12):
```ts
import type { MetaClient } from "../meta/campaigns.server";
import type { MetaWriteConn } from "../meta/ad-create.server";
import { deleteAd as realDeleteAd, metaWriteClientForShopId } from "../meta/ad-create.server";
```

Extend the `deps` parameter type on `undoAction` (line 73):
```ts
  deps: {
    admin?: AdminGraphqlClient;
    resolveMetaWriteClient?: (shopId: string) => Promise<MetaWriteConn | null>;
    deleteAd?: (client: MetaClient, adId: string) => Promise<void>;
  } = {},
```

Add an `else if` branch immediately BEFORE the final `} else {` "undo not supported" block (lines 289-293). `push_creative_draft` is not in the campaign-kind `externalId` guard at lines 166-172, so it correctly bypasses it:
```ts
  } else if (orig.action_kind === "push_creative_draft") {
    // Reversal = delete the paused draft ad we created. MetaClient has no DELETE
    // verb, so deleteAd sets the writable status to DELETED. Absolute-state, so
    // a retry is safe. Refuse loudly without the created ad id or a write client
    // rather than record a "succeeded" undo that deleted nothing (rule 12). No
    // mirrorBackToPreState — a creative draft never touched ad_campaign_dim.
    const post = (orig.post_state ?? {}) as { created_ad_id?: string };
    const adId = String(post.created_ad_id ?? "");
    if (!adId) throw new Error(`audit ${auditId} lacks created_ad_id; cannot undo a creative draft`);
    const resolveClient = deps.resolveMetaWriteClient ?? metaWriteClientForShopId;
    const del = deps.deleteAd ?? realDeleteAd;
    const conn = await resolveClient(shopId);
    if (!conn) throw new Error("Meta not connected; cannot undo creative draft");
    await del(conn.client, adId);
  } else {
```

- [ ] **Step 4: Run it and see it pass.** Re-run the existing undo suite to confirm the widened `deps` type and new branch did not regress campaign/inventory/price undos.
```bash
npx vitest run app/lib/actions/__tests__/undo-push-draft.test.ts app/lib/actions/__tests__/undo.test.ts
```
Expected: new file `3 passed`; `undo.test.ts` still green.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo-push-draft.test.ts
git commit -m "actions/undo: reverse push_creative_draft by deleting the created paused ad"
```

---

### Task 3.7: Wire both surfaces — routes, client, and per-variant push button

**Files**
```
Modify: app/routes/dashboard.api.campaigns.$id.action.tsx
Modify: app/routes/dashboard.api.analytics.tsx
Modify: app/lib/dashboard/client.ts
Modify: app/components/dashboard/screens/Campaigns.tsx
Modify: app/routes/app.campaigns.$campaignId.tsx
Create: app/routes/__tests__/dashboard-campaign-action-push.test.ts
```

> **Phase-2 dependency (rule 8):** the per-variant cards are produced by Phase 2's per-campaign Regenerate list on both surfaces. Phase 2 exposes each regenerated variant as a screener `Variant` (`app/lib/screener/types.ts:189`), which carries `input: CreativeInput` — the full creative, because `copyGenerator` spreads the original input. This task therefore pushes `variant.input` (a real `CreativeInput`); the dashboard `ScorecardVariant` view-model (`view-models.ts:212`) is NOT used here because it omits the creative body. This task adds the push control, the server route that dispatches through the tested executor, and the deterministic capability gate.
>
> **Render-level scope:** vitest runs in `environment: "node"` with no jsdom (`vitest.config.ts`), so the repo convention tests server/pure logic. The dashboard route handler is the testable seam; the button JSX is verified by `typecheck`/`build` (Task 3.8).

- [ ] **Step 1: Write the failing test.** Create `app/routes/__tests__/dashboard-campaign-action-push.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeAction } = vi.hoisted(() => ({ executeAction: vi.fn(async () => ({ id: "aud1", outcome: "succeeded" })) }));
vi.mock("~/lib/actions/execute.server", () => ({ executeAction }));
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1", shopDomain: "s.myshopify.com" })),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonError: (status: number, code: string) => new Response(JSON.stringify({ error: code }), { status }),
  dashboardJson: (fn: () => Promise<unknown>) =>
    Promise.resolve(fn()).then((b) => new Response(JSON.stringify(b), { status: 200 })),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("~/lib/calderyn.server", () => ({ calderynClient: () => ({ alerts: { get: vi.fn() } }) }));
vi.mock("~/lib/calibration/approval.server", () => ({ recordApproval: vi.fn() }));
vi.mock("~/lib/calibration/delta", () => ({ ZERO_APPROVE_RECEIPT: {} }));

import { action } from "../dashboard.api.campaigns.$id.action";

function req(body: unknown) {
  return new Request("https://app.calderyncompany.com/dashboard/api/campaigns/c-1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("dashboard campaign action — push_creative_draft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates the creative, computes a deterministic key, and dispatches", async () => {
    const creative = {
      headline: "Summer Sale",
      primaryText: "50% off.",
      cta: "SHOP_NOW",
      destinationUrl: "https://shop.example.com/sale",
      imageUrl: "https://cdn.example.com/a.jpg",
    };
    const res = await action({ request: req({ type: "push_creative_draft", creative }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(1);
    const arg = executeAction.mock.calls[0][1] as Record<string, unknown>;
    expect(arg.kind).toBe("push_creative_draft");
    expect(arg.campaignId).toBe("c-1");
    expect(String(arg.idempotencyKey)).toMatch(/^push_creative_draft:[a-f0-9]{64}$/);
    expect((arg.creative as Record<string, unknown>).headline).toBe("Summer Sale");
  });

  it("rejects an invalid creative with 422 and never dispatches", async () => {
    const res = await action({ request: req({ type: "push_creative_draft", creative: { primaryText: "x" } }), params: { id: "c-1" }, context: {} } as never);
    expect(res.status).toBe(422);
    expect(executeAction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
```bash
npx vitest run app/routes/__tests__/dashboard-campaign-action-push.test.ts
```
Expected failure: `push_creative_draft` is rejected with `422 invalid_action_type` (not in `KINDS`), so the first test fails on `executeAction` never being called.

- [ ] **Step 3: Write the minimal implementation.**

**Dashboard route** `app/routes/dashboard.api.campaigns.$id.action.tsx` — add the import (after line 6):
```ts
import { parsePushDraftCreative, pushCreativeDraftKey } from "~/lib/actions/push-draft.server";
```
Add the kind to the allowlist (lines 12-17):
```ts
const KINDS: ExecutableKind[] = [
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "push_creative_draft",
];
```
Immediately after `if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");` (line 36) and BEFORE the `if (!idempotencyKey) ...` guard (line 37), branch the creative-draft path. Its idempotency key is server-derived from the variant, so it must return before the client-key guard:
```ts
  if (kind === "push_creative_draft") {
    const parsed = parsePushDraftCreative(body.creative);
    if (!parsed.ok) return jsonError(422, parsed.error);
    const campaignId = String(params.id);
    const result = await executeAction(
      session.shopId,
      {
        alertId: null,
        kind,
        campaignId,
        idempotencyKey: pushCreativeDraftKey(campaignId, parsed.creative),
        creative: parsed.creative,
        actor: "merchant:web-dashboard",
      },
      getSupabase(),
    );
    if (result.outcome === "failed") {
      return new Response(
        JSON.stringify({
          error: "action_failed",
          message: "Couldn't push the draft — the ad platform rejected it. See the action history for details.",
          audit_id: result.id,
          outcome: result.outcome,
        }),
        { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    return dashboardJson(async () => ({ audit_id: result.id, outcome: result.outcome }));
  }
```

**Dashboard analytics envelope** `app/routes/dashboard.api.analytics.tsx` — the loader uses `calderynClient` and has NO supabase handle today, so import `getSupabase` and `metaDraftPushEnabled`, and surface the capability from `session.shopId`. Add imports:
```ts
import { getSupabase } from "~/lib/supabase.server";
import { metaDraftPushEnabled } from "~/lib/meta/ad-create.server";
```
Extend the loader's returned object (line 15):
```ts
    return {
      roas_series: roasSeries,
      grades,
      top_ads: topAds,
      meta_can_push_drafts: await metaDraftPushEnabled(getSupabase(), session.shopId),
    };
```

**Dashboard client** `app/lib/dashboard/client.ts`:
- Add `meta_can_push_drafts` to `AnalyticsEnvelope` (lines 630-634) and to `fetchAnalytics`'s return (lines 636-655), reading `data.meta_can_push_drafts ?? false`:
```ts
interface AnalyticsEnvelope {
  roas_series: DailyRoasRow[];
  grades: CampaignGradeRow[];
  top_ads: TopAdRow[];
  meta_can_push_drafts?: boolean;
}
```
```ts
export async function fetchAnalytics(): Promise<{
  daily: DailyRow[];
  grades: CampaignGradeRow[];
  topAds: TopAd[];
  metaCanPushDrafts: boolean;
}> {
  const data = await apiGet<AnalyticsEnvelope>("/dashboard/api/analytics");
  return {
    daily: adaptDaily(data.roas_series),
    grades: data.grades,
    topAds: data.top_ads.map((t) => ({
      ad_name: t.ad_name,
      campaign_name: t.campaign_name,
      reactions: t.reactions,
      comments: t.comments,
      shares: t.shares,
      saves: t.saves,
      engagement: t.engagement,
    })),
    metaCanPushDrafts: data.meta_can_push_drafts ?? false,
  };
}
```
- Add the dispatch fn in the `// --- mutations ---` section (after `executeCampaignAction`, line 684). It imports only the `CreativeInput` *type* (erased at build — `client.ts` stays browser-safe, never importing `.server`):
```ts
/** Push a regenerated winning variant to Meta as a PAUSED draft ad. The
 *  idempotency key is derived server-side from (campaign + variant), so this
 *  sends only the campaign + creative. A 502 surfaces as a DashboardApiError. */
export async function pushCreativeDraft(
  campaignId: string,
  variant: CreativeInput,
): Promise<{ auditId: string; outcome: string }> {
  const data = await apiSend<{ audit_id: string; outcome: string }>(
    "POST",
    `/dashboard/api/campaigns/${encodeURIComponent(campaignId)}/action`,
    {
      type: "push_creative_draft",
      creative: {
        headline: variant.headline,
        primaryText: variant.primaryText,
        cta: variant.cta,
        destinationUrl: variant.destinationUrl,
        imageUrl: variant.imageUrl,
        audience: variant.audience,
      },
    },
  );
  return { auditId: data.audit_id, outcome: data.outcome };
}
```
(`CreativeInput` is already imported at the top of `client.ts` — the screener-types import was widened to include it in Phase 2, Task 2.6 Step 1. Reuse that import; do **not** add a second `import … from "~/lib/screener/types"` line, or `import/no-duplicates` + `tsc` will fail.)

**Dashboard `Campaigns.tsx`** — `metaCanPushDrafts` is fetched in the top-level `Campaigns` component (the one that already calls `fetchAnalytics()` for `grades`); store it in state next to `grades` and thread it into `CampaignDetail` as a prop (`CampaignDetail` receives `app`/`c` today, so add `metaCanPushDrafts: boolean`). Import `pushCreativeDraft` from `~/lib/dashboard/client` alongside the existing client imports. In the per-variant card of the Phase-2 Regenerate list (each `v` is a screener `Variant`), render:
```tsx
{metaCanPushDrafts ? (
  <Btn
    icon="arrowUpRight"
    disabled={pushing === v.input.headline}
    onClick={async () => {
      setPushing(v.input.headline);
      try {
        const r = await pushCreativeDraft(c.id, v.input);
        app.toast(r.outcome === "succeeded" ? "Draft pushed to Meta (paused)" : "Push parked for retry");
      } catch {
        app.toast("Couldn't push the draft — check the action history");
      } finally {
        setPushing(null);
      }
    }}
  >
    Push to Meta as paused draft
  </Btn>
) : (
  <Tooltip content="Reconnect Meta with ad-management access to enable drafts">
    <Btn icon="lock" disabled>
      Reconnect Meta to enable drafts
    </Btn>
  </Tooltip>
)}
```
(`pushing` is a local `useState<string | null>(null)` in `CampaignDetail`; `v.input` is the screener `Variant.input` `CreativeInput`; `app.toast` is the real dashboard toast surface — `context.ts:108`; `Btn`/`Tooltip` are already imported by `Campaigns.tsx` per recon; `arrowUpRight`/`lock` are already in the `CDIcon` registry.)

**Embedded route** `app/routes/app.campaigns.$campaignId.tsx`:
- Add the import (with the existing imports):
```ts
import { metaDraftPushEnabled } from "~/lib/meta/ad-create.server";
import { parsePushDraftCreative, pushCreativeDraftKey } from "~/lib/actions/push-draft.server";
```
- Loader: add `metaCanPushDrafts: boolean` to `LoaderPayload` and compute it (`getSupabase`/`resolveShopId` are already imported at line 23):
```ts
//   metaCanPushDrafts: await metaDraftPushEnabled(getSupabase(), await resolveShopId(session.shop)),
```
- `action`: the handler currently rejects every intent except `apply_direction`. Add the new branch immediately after `const form = await request.formData();` (line 212) and BEFORE the `if (String(form.get("intent")) !== "apply_direction")` guard (line 213):
```ts
  if (String(form.get("intent")) === "push_creative_draft") {
    const campaignId = String(form.get("campaign_id") ?? "");
    if (!campaignId) return json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
    const parsed = parsePushDraftCreative({
      headline: form.get("headline"),
      primaryText: form.get("primaryText"),
      cta: form.get("cta"),
      destinationUrl: form.get("destinationUrl"),
      imageUrl: form.get("imageUrl"),
      audience: form.get("audience"),
    });
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, { status: 400 });
    const shopId = await resolveShopId(session.shop);
    const res = await executeAction(
      shopId,
      {
        alertId: null,
        kind: "push_creative_draft",
        campaignId,
        idempotencyKey: pushCreativeDraftKey(campaignId, parsed.creative),
        creative: parsed.creative,
        actor: "merchant:admin-detail",
      },
      getSupabase(),
    );
    return json({ ok: res.outcome !== "failed", outcome: res.outcome });
  }
```
- Per-variant UI (in the Phase-2 variant section, each `v` a screener `Variant`): a Polaris `<Button>` inside a `useFetcher` Form posting `intent=push_creative_draft`, `campaign_id`, and the `v.input` fields (`headline`/`primaryText`/`cta`/`destinationUrl`/`imageUrl`/`audience`), disabled when `!metaCanPushDrafts` with a reconnect `<Banner>` fallback; surface `fetcher.data?.ok === false` as a Polaris `<Banner tone="critical">` ("Couldn't push the draft — see action history"). This mirrors the existing `directionFetcher.Form` pattern already in this route (recon §5).

- [ ] **Step 4: Run it and see it pass.**
```bash
npx vitest run app/routes/__tests__/dashboard-campaign-action-push.test.ts
```
Expected: `2 passed`.

- [ ] **Step 5: Commit.**
```bash
git add app/routes/dashboard.api.campaigns.$id.action.tsx app/routes/dashboard.api.analytics.tsx app/lib/dashboard/client.ts app/components/dashboard/screens/Campaigns.tsx app/routes/app.campaigns.$campaignId.tsx app/routes/__tests__/dashboard-campaign-action-push.test.ts
git commit -m "campaigns: wire push_creative_draft on both surfaces with ads_management gate + failure toast"
```

---

### Task 3.8: Phase 3 pre-commit gate

**Files**
```
(no new files — runs the CLAUDE.md pre-commit gate over the Phase 3 working tree)
```

- [ ] **Step 1: Patch sanity.**
```bash
git diff --stat && git diff --check
```
Expected: clean (no whitespace errors); no stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, or provenance markers introduced.

- [ ] **Step 2: `/code-review` the working tree.** Run the `/code-review` slash command; resolve every blocker, downgrade any nit with a one-line justification. Pay particular attention to the flagged tradeoffs (page_id live-resolution; `status:"DELETED"` deletion; the duplicated retriable-aware `check`) — confirm each is intentional and commented.

- [ ] **Step 3: Run the full eval pipeline, in order.**
```bash
npm run typecheck && npm run lint && npm run build && npm run test
```
Expected: every command exits 0.
- `npm run typecheck` (`tsc --noEmit`) → exit 0 (new `ExecuteDeps`, `MetaWriteConn`, `MetaAdSet`, `ActionKind`/`ExecutableKind` additions, the `creative` DTO field, the widened `undoAction` deps, and the analytics/client `metaCanPushDrafts` field all resolve).
- `npm run lint` → exit 0, no warnings on touched files.
- `npm run build` (`remix vite:build && npm run verify:client-bundle`) → exit 0; the client-bundle verifier passes — `ad-create.server.ts`, `push-draft.server.ts`, `execute.server.ts`, `undo.server.ts`, `integration-status.ts` server consumers stay server-only, and `client.ts` imports only the `CreativeInput` *type* (erased at build), so no `.server` module leaks into a client bundle.
- `npm run test` (`vitest run`) → exit 0; the full suite is green, including the existing `execute.test.ts`/`undo.test.ts` regression and the six new Phase 3 specs (`ad-create`, `integration-scope`, `push-draft`, `execute-push-draft`, `undo-push-draft`, `dashboard-campaign-action-push`).

> No `npm run graphql-codegen` (no `.graphql`/Admin query changed) and no `npx prisma validate`/`migrate diff` (no `prisma/schema.prisma` or Prisma migration changed — the scopes migration is Supabase/Postgres, single-file with no engine-fixture mirror).

- [ ] **Step 4: Confirm green and report.** Paste the exit codes/output of Step 1 and Step 3 (rule 12 — evidence, not assertion). Only when all are green is Phase 3 complete. Phase 3 ships both surfaces (dashboard route + client + `Campaigns.tsx`; embedded route + loader + variant UI); no single-sided ship.

---

## Phase 4: Remove Predictor/Generator tabs and dead code

**Goal:** Delete the now-redundant Creative Predictor (Screener) and Ad Generator surfaces from both surfaces — embedded routes + dashboard screens, their nav entries, the Overview teaser tile, and the dead Predictor-only client surface (`fetchLatestScreenRun`/`screenCreative`/`adaptScreenRun`) + the `dashboard.api.screener.tsx` route — while keeping `app/lib/screener/` (now consumed inside Campaigns). End with `typecheck` + `lint` + `build` + `test` green and zero dangling references.

**Assumptions (rule 1 — stated, because they drive what is "dead"):**
- Phases 1–3 already (a) replaced `GradePill` with `ScorePill` on campaign rows/detail, (b) ported the per-ad Creatives section + the "Screen a new creative" drop-in into `Campaigns.tsx`, and (c) added the `push_creative_draft` path. **The dashboard drop-in was wired through the NEW `screenCampaignCreative` → `/dashboard/api/campaigns/$id/screen` (Phase 2), NOT the old global screener client.** Verified against the repo: the only consumers of `fetchLatestScreenRun`, `screenCreative`, and `adaptScreenRun` outside `client.ts` are `Predictor.tsx` (deleted in Task 4.3) and `adapt-screen-run.test.ts`; `/dashboard/api/screener` is hit only by `fetchLatestScreenRun`/`screenCreative`. So once Predictor is gone, all three fns **plus** the `dashboard.api.screener.tsx` route **plus** `adapt-screen-run.test.ts` are **dead** (removed in Task 4.4). `ScreenCreativePayload` is **kept** — `screenCampaignCreative` reuses it.
- **KEEP** (do not touch): `app/lib/screener/**`, `app/routes/app.campaigns.$campaignId.score.tsx` (per-ad score resource), `app/lib/screener/pick-generator.server.ts`, the `ScreenCreativePayload` type in `client.ts` (Phase 2's `screenCampaignCreative` reuses it; there is no `dashboard.api.generator` route), and the shared helpers `app/components/dashboard/{demo.ts,MediaDrop.tsx,CreativePreviewPlaceholder.tsx,tip-icons.tsx}` (these are referenced today only by `Predictor.tsx`/`Generator.tsx`; after their deletion they become unreferenced module files, which is NOT a gate failure — `tsc`/`eslint`/`vite` do not error on an unimported module — and phase 2 may reuse them).

**Conflict surfaced (rule 7):** the phase brief lists only NAV_ITEMS/SCREENS/client-fns/routes, but `tsc` forces three extra edits, because removing `"predictor"`/`"generator"` from the `Screen` union breaks live `app.navigate("predictor")` call-sites and the typed grid registry: the **Overview `PredictorCard` tile** (`Dashboard.tsx`, which `navigate("predictor")`s), the **`predictor` grid slot** (`dashboard-layout.ts`), and the **`tileScale` test** that uses `"predictor"` as its example tile. Task 4.2 handles these; without them the union members are *not* "now unused" and cannot be removed.

**`PredictorCard` has two render sites (caught by grepping the identifier, not the `"predictor"` string):** the grid `tiles` array AND the default `OriginalLayout` `cd-grid-duo` block. Both must be removed in Task 4.2 or `tsc` (and the guard test) fails.

**Files**
- Delete: `app/routes/app.screener.tsx`
- Delete: `app/routes/app.generator.tsx`
- Delete: `app/components/dashboard/screens/Predictor.tsx`
- Delete: `app/components/dashboard/screens/Generator.tsx`
- Delete: `app/lib/screener/__tests__/generator-route.test.ts`
- Modify: `app/routes/app.tsx` (remove two NavMenu links)
- Modify: `app/routes/__tests__/page-fullwidth.test.ts` (drop the two removed pages)
- Modify: `app/lib/screener/__tests__/route-helpers.test.ts` (drop `app.screener` imports + their describe blocks; keep `parseScoreForm` + `pickGenerator`)
- Modify: `app/components/dashboard/DashboardApp.tsx` (imports, NAV_ITEMS, SCREENS, comment)
- Modify: `app/components/dashboard/context.ts` (`Screen` union)
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (remove the `PredictorCard` component, **both** of its render sites — the `OriginalLayout` `cd-grid-duo` usage and the grid `tiles` entry — and the now-unused `RingGauge`/`GradePill` imports)
- Modify: `app/components/dashboard/screens/dashboard-layout.ts` (`DASH_TILE_IDS`, `LG`, `STACK_H`)
- Modify: `app/components/dashboard/screens/__tests__/dashboard-layout.test.ts` (`tileScale` block: `"predictor"` → `"autopilot"`)
- Modify: `app/lib/dashboard/client.ts` (remove dead `fetchLatestScreenRun`, `screenCreative`, `adaptScreenRun`; keep `ScreenCreativePayload`)
- Delete: `app/routes/dashboard.api.screener.tsx` (dead once `screenCreative`/`fetchLatestScreenRun` are gone)
- Delete: `app/lib/dashboard/__tests__/adapt-screen-run.test.ts` (only tested the removed `adaptScreenRun`)
- Test (new guards): `app/routes/__tests__/screener-generator-removed.test.ts`, `app/components/dashboard/screens/__tests__/overview-no-predictor-tile.test.ts`, `app/components/dashboard/__tests__/predictor-generator-removed.test.ts`, `app/lib/dashboard/__tests__/screener-client-pruned.test.ts`

> All work continues in the feature worktree `feat/campaign-creative-hub` (spec §11). Run every command from the repo root of that worktree.

---

### Task 4.1: Embedded — delete `app.screener` + `app.generator` routes and nav links

**Files**
- Delete: `app/routes/app.screener.tsx`, `app/routes/app.generator.tsx`, `app/lib/screener/__tests__/generator-route.test.ts`
- Modify: `app/routes/app.tsx`, `app/routes/__tests__/page-fullwidth.test.ts`, `app/lib/screener/__tests__/route-helpers.test.ts`
- Test (new): `app/routes/__tests__/screener-generator-removed.test.ts`

- [ ] **Step 1: Write the failing guard test.** Create `app/routes/__tests__/screener-generator-removed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const route = (f: string) => new URL(`../${f}`, import.meta.url);

describe("Predictor/Generator embedded routes are removed", () => {
  it("app.screener.tsx and app.generator.tsx no longer exist", () => {
    expect(existsSync(route("app.screener.tsx"))).toBe(false);
    expect(existsSync(route("app.generator.tsx"))).toBe(false);
  });

  it("the embedded NavMenu has no Creative Predictor / Ad Generator links", () => {
    const appTsx = readFileSync(route("app.tsx"), "utf8");
    expect(appTsx).not.toContain("/app/screener");
    expect(appTsx).not.toContain("/app/generator");
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/routes/__tests__/screener-generator-removed.test.ts
```

Expected failure: the first assertion fails with `expected true to be false` (the route files still exist), and the NavMenu assertion fails because `app.tsx` still contains `/app/screener`.

- [ ] **Step 3: Delete the routes and the route-only generator test.**

```bash
git rm app/routes/app.screener.tsx app/routes/app.generator.tsx app/lib/screener/__tests__/generator-route.test.ts
```

(`generator-route.test.ts` imports `parseGeneratorForm, weakestMetrics, GENERATOR_STYLES, GENERATOR_ASPECTS` from the deleted `routes/app.generator` — those helpers are route-local and die with the file, so the whole test goes. Verified: nothing outside that test imports those four symbols.)

- [ ] **Step 4: Remove the two NavMenu links in `app/routes/app.tsx`.** Delete these two lines (currently lines 75–76):

```tsx
        <Link to={withParams("/app/screener")}>Creative Predictor</Link>
        <Link to={withParams("/app/generator")}>Ad Generator</Link>
```

so the block reads:

```tsx
        <Link to={withParams("/app/campaigns")}>Campaigns</Link>
        <Link to={withParams("/app/skus")}>Inventory</Link>
        <Link to={withParams("/app/settings")}>Settings</Link>
        <Link to={withParams("/app/mcp")}>Claude connections</Link>
```

- [ ] **Step 5: Drop the removed pages from `app/routes/__tests__/page-fullwidth.test.ts`.** Edit the `FULL_WIDTH_PAGES` array (currently lines 16–26) to delete the two entries:

```ts
const FULL_WIDTH_PAGES = [
  "app.audit.tsx",
  "app.skus.tsx",
  "app.analytics._index.tsx",
  "app.campaigns._index.tsx",
  "app.alerts._index.tsx",
  "app.settings.tsx",
  "app.mcp.tsx",
];
```

(Removing `"app.screener.tsx"` and `"app.generator.tsx"` — otherwise `readFileSync` throws `ENOENT` on the deleted files.)

- [ ] **Step 6: Prune the `app.screener` helpers from `app/lib/screener/__tests__/route-helpers.test.ts`.** The file currently imports `clampSpend, parseCreativeForm, isMetaSubmit` from the deleted `routes/app.screener` (line 12) and exercises them. Those three helpers were route-local to `app.screener.tsx` and have no other consumer (verified: only this test and the deleted route reference them), so the import line and their three describe blocks must go. Keep the `pickGenerator` (kept lib) and `parseScoreForm` (kept score route, error code `INVALID_REQUEST`) blocks. Replace the whole file with:

```ts
import { describe, it, expect, vi } from "vitest";

// The score resource route eagerly constructs the Shopify app at import
// (shopify.server calls shopifyApp({ appUrl }) at module load), which throws
// "empty appUrl" when SHOPIFY_APP_URL is unset — e.g. in CI. parseScoreForm
// doesn't touch authenticate, so stub shopify.server like the other route tests do.
vi.mock("../../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock so the shopify.server stub is registered before the route module loads */
import { parseScoreForm } from "../../../routes/app.campaigns.$campaignId.score";
import { DEFAULT_SPEND_CENTS } from "../types";
import { pickGenerator } from "../pick-generator.server";
/* eslint-enable import/first */

describe("pickGenerator", () => {
  const deps = { createMessage: vi.fn(), model: "m" };
  it("returns the image generator for mode 'image'", () => {
    expect(pickGenerator("image", deps).mode).toBe("image");
  });
  it("defaults to the copy generator for copy / null / unknown modes", () => {
    expect(pickGenerator("copy", deps).mode).toBe("copy");
    expect(pickGenerator(null, deps).mode).toBe("copy");
    expect(pickGenerator("bogus", deps).mode).toBe("copy");
  });
});

describe("parseScoreForm", () => {
  function form(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }

  it("rejects an empty/missing adId with INVALID_REQUEST", () => {
    const out = parseScoreForm(form({ adId: "  " }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_REQUEST");
    const missing = parseScoreForm(form({}));
    expect(missing.ok).toBe(false);
  });

  it("clamps assumedSpendCents to bounds; absent/NaN → DEFAULT", () => {
    const lo = parseScoreForm(form({ adId: "a", assumedSpendCents: "0" }));
    const hi = parseScoreForm(form({ adId: "a", assumedSpendCents: "99999999" }));
    const absent = parseScoreForm(form({ adId: "a" }));
    if (!lo.ok || !hi.ok || !absent.ok) throw new Error("expected ok");
    expect(lo.assumedSpendCents).toBe(1000);
    expect(hi.assumedSpendCents).toBe(10_000_000);
    expect(absent.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });

  it("coerces imageUrl '' / 'null' → null and missing creative fields → ''", () => {
    const empty = parseScoreForm(form({ adId: "a", imageUrl: "" }));
    const literal = parseScoreForm(form({ adId: "a", imageUrl: "null" }));
    const real = parseScoreForm(form({ adId: "a", imageUrl: "https://x.test/i.jpg" }));
    if (!empty.ok || !literal.ok || !real.ok) throw new Error("expected ok");
    expect(empty.creative.imageUrl).toBeNull();
    expect(literal.creative.imageUrl).toBeNull();
    expect(real.creative.imageUrl).toBe("https://x.test/i.jpg");
    // Missing text fields default to "".
    expect(empty.creative.headline).toBe("");
    expect(empty.creative.primaryText).toBe("");
    expect(empty.creative.cta).toBe("");
    expect(empty.creative.destinationUrl).toBe("");
    expect(empty.creative.audience).toBe("");
  });

  it("builds the creative from posted text fields", () => {
    const out = parseScoreForm(
      form({
        adId: "ad-1",
        headline: "H",
        primaryText: "P",
        cta: "SHOP_NOW",
        destinationUrl: "https://x.test/p",
        audience: "women 25-44",
      }),
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.adId).toBe("ad-1");
    expect(out.creative).toMatchObject({
      headline: "H",
      primaryText: "P",
      cta: "SHOP_NOW",
      destinationUrl: "https://x.test/p",
      audience: "women 25-44",
    });
  });
});
```

- [ ] **Step 7: Run the guard test (green) plus the two edited tests.**

```bash
npx vitest run \
  app/routes/__tests__/screener-generator-removed.test.ts \
  app/routes/__tests__/page-fullwidth.test.ts \
  app/lib/screener/__tests__/route-helpers.test.ts
```

Expected: all three files PASS (e.g. `Test Files  3 passed`). The guard test now reports both assertions green; `page-fullwidth` no longer references the deleted files; `route-helpers` exercises only the kept `pickGenerator` + `parseScoreForm`.

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "routes/app.screener+app.generator: remove embedded Predictor/Generator routes and nav links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2: Dashboard Overview — remove the Predictor teaser tile and its grid slot

**Files**
- Modify: `app/components/dashboard/screens/Dashboard.tsx`, `app/components/dashboard/screens/dashboard-layout.ts`, `app/components/dashboard/screens/__tests__/dashboard-layout.test.ts`
- Test (new): `app/components/dashboard/screens/__tests__/overview-no-predictor-tile.test.ts`

- [ ] **Step 1: Write the failing guard test.** Create `app/components/dashboard/screens/__tests__/overview-no-predictor-tile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DASH_TILE_IDS } from "../dashboard-layout";

describe("Overview no longer carries a Predictor tile", () => {
  it("the dashboard grid registry omits the predictor tile", () => {
    expect(DASH_TILE_IDS as readonly string[]).not.toContain("predictor");
  });

  it("Dashboard.tsx no longer renders a PredictorCard or navigates to predictor", () => {
    const src = readFileSync(new URL("../Dashboard.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("PredictorCard");
    expect(src).not.toContain('navigate("predictor")');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/components/dashboard/screens/__tests__/overview-no-predictor-tile.test.ts
```

Expected failure: `expected [ 'stats', 'focus', 'feed', 'revenue', 'attention', 'predictor', 'autopilot', 'benchmarks' ] not to contain 'predictor'`, plus the source assertion failing because `Dashboard.tsx` still contains `PredictorCard`.

- [ ] **Step 3: Remove the `PredictorCard` component from `Dashboard.tsx`.** Delete the whole block (currently lines 204–228):

```tsx
/* ---------- Predictor teaser ---------- */
// TODO(api): wire to a live `app.overview.predictor` / scorecard summary when available.
function PredictorCard({ app }: { app: DashboardCtx }) {
  return (
    <Card pad={false} className="flex flex-col" onClick={() => app.navigate("predictor")}>
      <div className="cd-pad flex items-center gap-4">
        <RingGauge value={82} size={86} label="score" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="cd-h2">Creative Predictor</h2>
            <GradePill grade="winning" />
          </div>
          <p className="cd-caption" style={{ maxWidth: "42ch" }}>
            Score a new ad creative before you spend — Calderyn predicts ROAS against your
            break-even and flags weak hooks, offers, and CTAs.
          </p>
          <div className="cd-link mt-2">
            Screen a new creative
            <CDIcon name="chevronRight" size={13} style={{ display: "inline", verticalAlign: "-2px" }} />
          </div>
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Remove BOTH `PredictorCard` render sites in `Dashboard.tsx`.** `PredictorCard` is referenced twice — the default flow layout *and* the customizable grid registry. Remove both, or `tsc` errors with "Cannot find name 'PredictorCard'" (and the Step-1 guard test stays red).

  4a. In `OriginalLayout` (currently lines 429–432) replace the two-card duo with the lone guardrail card (the predictor half is gone; `GuardrailCard` is the only remaining child, so drop the `cd-grid-duo` wrapper):

```tsx
      <div className="cd-grid-duo">
        <PredictorCard app={app} />
        <GuardrailCard app={app} />
      </div>
```

  becomes:

```tsx
      <GuardrailCard app={app} />
```

  4b. In the `tiles` array (currently line 527) delete the predictor entry:

```tsx
    { id: "predictor", node: <PredictorCard app={app} /> },
```

  so the array tail reads:

```tsx
    ...(hasAttention ? [{ id: "attention", node: <AttentionSection app={app} /> }] : []),
    { id: "autopilot", node: <GuardrailCard app={app} /> },
    ...(benchmarks ? [{ id: "benchmarks", node: <PeerBenchmarks data={benchmarks} /> }] : []),
  ];
```

- [ ] **Step 5: Drop the now-unused `RingGauge` and `GradePill` imports in `Dashboard.tsx`** (they were used only by `PredictorCard`; verified no other reference in the file). Edit the `../ui` import (currently lines 4–16) to:

```tsx
import {
  Card,
  SectionTitle,
  CountMoney,
  AreaChart,
  SevBadge,
  Pill,
  Btn,
  Meter,
  Placeholder,
} from "../ui";
```

- [ ] **Step 6: Remove the `predictor` slot from `dashboard-layout.ts`.** Three edits:

  6a. `DASH_TILE_IDS` (lines 15–24) — delete `"predictor",`:

```ts
export const DASH_TILE_IDS = [
  "stats",
  "focus",
  "feed",
  "revenue",
  "attention",
  "autopilot",
  "benchmarks",
] as const;
```

  6b. `LG` array (lines 40–49) — delete the `predictor` row and move `autopilot` to `x: 0`:

```ts
const LG: Layout[] = [
  { i: "stats", x: 0, y: 0, w: 12, h: 4, minW: 12, minH: 3 },
  { i: "focus", x: 0, y: 4, w: 8, h: 6, minW: 6, minH: 5 },
  { i: "feed", x: 8, y: 4, w: 4, h: 13, minW: 3, minH: 10 },
  { i: "revenue", x: 0, y: 10, w: 8, h: 7, minW: 6, minH: 6 },
  { i: "attention", x: 0, y: 17, w: 12, h: 5, minW: 12, minH: 4 },
  { i: "autopilot", x: 0, y: 22, w: 6, h: 5, minW: 5, minH: 4 },
  { i: "benchmarks", x: 0, y: 27, w: 12, h: 10, minW: 12, minH: 7 },
];
```

  6c. `STACK_H` (lines 52–61) — delete the `predictor: 5,` key (required: `STACK_H` is `Record<DashTileId, number>` and `DashTileId` no longer includes `"predictor"`, so an extra key is a TS2353 excess-property error):

```ts
const STACK_H: Record<DashTileId, number> = {
  stats: 4,
  focus: 6,
  feed: 11,
  revenue: 7,
  attention: 5,
  autopilot: 5,
  benchmarks: 10,
};
```

- [ ] **Step 7: Repoint the `tileScale` example tile in `dashboard-layout.test.ts` from `"predictor"` to `"autopilot"`** (`autopilot` keeps the same 6×5 default geometry the block's comment asserts, and is still present after Step 6). Replace the `tileScale` describe block (currently lines 108–137) so every `"predictor"` becomes `"autopilot"`:

```ts
describe("tileScale (resize zoom factor)", () => {
  const def = DEFAULT_LAYOUTS.lg!.find((l) => l.i === "autopilot")!; // 6×5

  it("is 1× when a tile is at its default size", () => {
    expect(tileScale("autopilot", { w: def.w, h: def.h }, "lg")).toBe(1);
  });

  it("zooms down for a smaller tile, floored at the min", () => {
    const s = tileScale("autopilot", { w: 4, h: 3 }, "lg");
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThanOrEqual(TILE_SCALE_MIN);
  });

  it("zooms up for a larger tile, capped at the max", () => {
    const s = tileScale("autopilot", { w: 12, h: 12 }, "lg");
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThanOrEqual(TILE_SCALE_MAX);
  });

  it("uses the smaller of the width/height ratios (content always fits)", () => {
    // 12 wide (2×) but 5 tall (1×) → 1×, so it can't overflow vertically.
    expect(tileScale("autopilot", { w: 12, h: 5 }, "lg")).toBe(1);
  });

  it("never zooms outside the lg grid, or for unknown/missing tiles", () => {
    expect(tileScale("autopilot", { w: 2, h: 2 }, "sm")).toBe(1);
    expect(tileScale("nope", { w: 2, h: 2 }, "lg")).toBe(1);
    expect(tileScale("autopilot", undefined, "lg")).toBe(1);
  });
});
```

- [ ] **Step 8: Run the guard + layout tests and see them pass.**

```bash
npx vitest run \
  app/components/dashboard/screens/__tests__/overview-no-predictor-tile.test.ts \
  app/components/dashboard/screens/__tests__/dashboard-layout.test.ts
```

Expected: both files PASS (`Test Files  2 passed`). `DASH_TILE_IDS` no longer contains `predictor`, `Dashboard.tsx` has no `PredictorCard` (both render sites gone) and no `navigate("predictor")`, and the `tileScale` invariants now resolve against the `autopilot` tile.

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "dashboard/Dashboard+dashboard-layout: drop Overview Creative Predictor tile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.3: Dashboard — remove the Predictor/Generator screens, nav entries, and `Screen` union members

**Files**
- Delete: `app/components/dashboard/screens/Predictor.tsx`, `app/components/dashboard/screens/Generator.tsx`
- Modify: `app/components/dashboard/DashboardApp.tsx`, `app/components/dashboard/context.ts`
- Test (new): `app/components/dashboard/__tests__/predictor-generator-removed.test.ts`

> Order matters: all edits below land in one commit so `tsc` is never mid-flight. By this point (after 4.2) the only remaining `app.navigate("predictor"|"generator")` call-sites are inside `Predictor.tsx`/`Generator.tsx` themselves (verified: Predictor.tsx lines 452/500 `navigate("generator")`, Generator.tsx line 182 `navigate("predictor")`), which are deleted here — so dropping the union members is safe.

- [ ] **Step 1: Write the failing guard test.** Create `app/components/dashboard/__tests__/predictor-generator-removed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const screen = (f: string) => new URL(`../screens/${f}`, import.meta.url);
const file = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("Predictor/Generator dashboard screens are removed", () => {
  it("Predictor.tsx and Generator.tsx screen files are deleted", () => {
    expect(existsSync(screen("Predictor.tsx"))).toBe(false);
    expect(existsSync(screen("Generator.tsx"))).toBe(false);
  });

  it("DashboardApp no longer imports or registers them", () => {
    const app = file("DashboardApp.tsx");
    expect(app).not.toContain("ScreenPredictor");
    expect(app).not.toContain("ScreenGenerator");
    expect(app).not.toMatch(/^\s*predictor:/m);
    expect(app).not.toMatch(/^\s*generator:/m);
  });

  it("the Screen union drops the predictor and generator members", () => {
    const ctx = file("context.ts");
    expect(ctx).not.toContain('"predictor"');
    expect(ctx).not.toContain('"generator"');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run app/components/dashboard/__tests__/predictor-generator-removed.test.ts
```

Expected failure: `expected true to be false` on the `existsSync(screen("Predictor.tsx"))` assertion (the screen files still exist), and the `DashboardApp` / `context` assertions also fail (`ScreenPredictor` import + `"predictor"` union member still present).

- [ ] **Step 3: Remove the two screen imports and the rail comment in `DashboardApp.tsx`.** Delete lines 39–40:

```tsx
import ScreenPredictor from "./screens/Predictor";
import ScreenGenerator from "./screens/Generator";
```

and delete the now-stale comment above `NAV_ITEMS` (lines 49–50):

```tsx
// `generator` is reachable via navigate() but intentionally absent from the rail
// (same as the prototype — it's an inner flow off the predictor).
```

- [ ] **Step 4: Remove the `predictor` rail entry from `NAV_ITEMS` in `DashboardApp.tsx`.** Delete line 55:

```tsx
  { id: "predictor", label: "Creative Predictor", icon: "sparkle" },
```

so `NAV_ITEMS` reads:

```tsx
const NAV_ITEMS: { id: ScreenId; label: string; icon: string }[] = [
  { id: "dashboard", label: "Overview", icon: "gauge" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "campaigns", label: "Campaigns", icon: "megaphone" },
  { id: "analytics", label: "Analytics", icon: "chart" },
  { id: "inventory", label: "Inventory", icon: "box" },
  { id: "audit", label: "Action history", icon: "clock" },
  { id: "action-queue", label: "Action Queue", icon: "target" },
  { id: "live-engine", label: "Live Engine", icon: "bolt" },
  { id: "settings", label: "Settings", icon: "gear" },
];
```

- [ ] **Step 5: Remove the `predictor` and `generator` entries from `SCREENS` in `DashboardApp.tsx`.** Delete lines 81–82:

```tsx
  predictor: ScreenPredictor,
  generator: ScreenGenerator,
```

so `SCREENS` reads:

```tsx
const SCREENS: Record<ScreenId, (props: { app: DashboardCtx }) => JSX.Element> = {
  dashboard: ScreenDashboard,
  alerts: ScreenAlerts,
  campaigns: ScreenCampaigns,
  analytics: ScreenAnalytics,
  inventory: ScreenInventory,
  audit: ScreenAudit,
  "action-queue": ScreenActionQueue,
  "live-engine": ScreenLiveEngine,
  settings: ScreenSettings,
  // Hidden (not in NAV_ITEMS) — reached via the secret dot in Settings.
  labs: ScreenLabs,
};
```

- [ ] **Step 6: Remove the union members in `app/components/dashboard/context.ts`.** Delete lines 19–20:

```ts
  | "predictor"
  | "generator"
```

so the `Screen` type reads:

```ts
export type Screen =
  | "dashboard"
  | "alerts"
  | "campaigns"
  | "analytics"
  | "inventory"
  | "audit"
  | "action-queue"
  | "live-engine"
  | "settings"
  // Hidden Calderyn Labs "Autopilot replay" demo. Not in the nav rail; reached
  // only via the secret hexagon dot in Settings. Masks itself as Campaigns.
  | "labs";
```

- [ ] **Step 7: Delete the two screen files.**

```bash
git rm app/components/dashboard/screens/Predictor.tsx app/components/dashboard/screens/Generator.tsx
```

- [ ] **Step 8: Run the guard test plus a typecheck and see them pass.**

```bash
npx vitest run app/components/dashboard/__tests__/predictor-generator-removed.test.ts
npm run typecheck
```

Expected: the guard test PASSES (all three `it` blocks green), and `npm run typecheck` exits `0` — proving `SCREENS` (`Record<ScreenId, …>`) is exhaustive again and no surviving call-site references the removed `Screen` members. (Confirmed by recon: the only `"predictor"`/`"generator"` literals across `app/` outside `app/lib/screener/` lived in the files touched by Tasks 4.1–4.3.)

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "dashboard/DashboardApp+context: remove Predictor/Generator screens, nav, and Screen union members

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.4: Dashboard client — remove the dead Predictor-only screener surface + API route

**Files**
- Modify: `app/lib/dashboard/client.ts`
- Delete: `app/routes/dashboard.api.screener.tsx`
- Delete: `app/lib/dashboard/__tests__/adapt-screen-run.test.ts`
- Test (new): `app/lib/dashboard/__tests__/screener-client-pruned.test.ts`

> After Task 4.3 deletes `Predictor.tsx`, the old global screener client surface has no production consumer. **Verified against the repo:** `fetchLatestScreenRun` (898), `screenCreative` (916), and `adaptScreenRun` (934) in `app/lib/dashboard/client.ts` were imported only by `Predictor.tsx` (now gone) and the unit test `adapt-screen-run.test.ts`; and `/dashboard/api/screener` is hit only by `fetchLatestScreenRun`/`screenCreative`. The dashboard drop-in landed in **Phase 2** through the *separate* `screenCampaignCreative` → `/dashboard/api/campaigns/$id/screen`. So all three fns, the `dashboard.api.screener.tsx` route, and the dead test are removed here. **`ScreenCreativePayload` (903) stays** — Phase 2's `screenCampaignCreative` reuses it — and it sits *between* the deleted fns, so this is a three-symbol surgical removal, not a contiguous block delete. TS does not flag unused *exports*, so these must be removed by hand and locked with a guard.

- [ ] **Step 1: Confirm the consumer set with grep (decision gate, rule 12).**

```bash
grep -rn "fetchLatestScreenRun\|screenCreative\|adaptScreenRun" app/ --include="*.ts" --include="*.tsx" | grep -v "app/lib/dashboard/client.ts"
grep -rn "/dashboard/api/screener" app/ --include="*.ts" --include="*.tsx" | grep -v "app/lib/dashboard/client.ts\|app/routes/dashboard.api.screener.tsx"
grep -rn "screenCampaignCreative\|ScreenCreativePayload" app/ --include="*.ts" --include="*.tsx" | grep -v "app/lib/dashboard/client.ts"
```

Expected: the **first** grep prints **only** `app/lib/dashboard/__tests__/adapt-screen-run.test.ts` (the lone non-`client.ts` consumer now that `Predictor.tsx` is gone) — confirming all three fns are dead. (`grep "screenCreative"` does **not** match the kept `screenCampaignCreative` or the kept `ScreenCreativePayload` — different substrings.) The **second** prints nothing (no other module hits the old route). The **third** shows `screenCampaignCreative` consumed by `app/components/dashboard/screens/Campaigns.tsx` and `ScreenCreativePayload` used by `screenCampaignCreative` — confirming the kept surface. **If** the first grep instead shows a live `screens/*.tsx` consumer, STOP: a Phase-2/3 wiring regressed (the drop-in must use `screenCampaignCreative`) — fix that before deleting. Do not silently delete past the disagreement.

- [ ] **Step 2: Write the failing guard test.** Create `app/lib/dashboard/__tests__/screener-client-pruned.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as client from "../client";

describe("dead Predictor-only screener client fns are pruned", () => {
  it("fetchLatestScreenRun, screenCreative, and adaptScreenRun are no longer exported", () => {
    expect("fetchLatestScreenRun" in client).toBe(false);
    expect("screenCreative" in client).toBe(false);
    expect("adaptScreenRun" in client).toBe(false);
  });

  it("the kept campaign drop-in surface is still exported", () => {
    expect(typeof client.screenCampaignCreative).toBe("function");
  });
});
```

- [ ] **Step 3: Run it and see it fail.**

```bash
npx vitest run app/lib/dashboard/__tests__/screener-client-pruned.test.ts
```

Expected failure: the first assertion fails with `expected true to be false` — `fetchLatestScreenRun` is still exported from `client.ts`.

- [ ] **Step 4: Delete the three dead fns (keep `ScreenCreativePayload`), the dead route, and the dead test; de-stale the section header.** In `app/lib/dashboard/client.ts`, the `// --- creative screener (Predictor) ---` section (line 896) currently holds, in order: `fetchLatestScreenRun` (898–901), `ScreenCreativePayload` (903–914), `screenCreative` (916–932), `adaptScreenRun` (934–…), then Phase 2's appended DTOs + `fetchCampaignCreatives`/`scoreCampaignAd`/`regenerateCampaign`/`screenCampaignCreative`. Delete the first function:

```ts
export async function fetchLatestScreenRun(): Promise<CreativeScreenRun | null> {
  const data = await apiGet<{ latest: CreativeScreenRun | null }>("/dashboard/api/screener");
  return data.latest;
}
```

Then delete the `screenCreative` function in full (its body begins at line 916 and POSTs to `/dashboard/api/screener`) and the `adaptScreenRun` function in full (`export function adaptScreenRun(run: CreativeScreenRun): Scorecard | null { … }`, beginning at line 934). **Do not delete `ScreenCreativePayload` (903–914)** — it sits between them and Phase 2 reuses it — and **do not delete** any of the Phase-2 declarations below `adaptScreenRun`. Rename the section header so it no longer names the removed Predictor surface:

```ts
// --- creative screener (campaign drop-in) -----------------------------------
```

Then remove the now-dead route and the test that only exercised `adaptScreenRun`:

```bash
git rm app/routes/dashboard.api.screener.tsx
git rm app/lib/dashboard/__tests__/adapt-screen-run.test.ts
```

- [ ] **Step 5: Run the guard test + a typecheck to confirm nothing else referenced the removed surface.**

```bash
npx vitest run app/lib/dashboard/__tests__/screener-client-pruned.test.ts
npm run typecheck
```

Expected: the guard test PASSES (all three fns gone; `screenCampaignCreative` present) and `npm run typecheck` exits `0` — no surviving import of `fetchLatestScreenRun`/`screenCreative`/`adaptScreenRun` or the deleted route, and `ScreenCreativePayload` still resolves for `screenCampaignCreative`.

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "lib/dashboard/client: remove dead Predictor-only screener surface + route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.5: Final verification — dangling-reference sweep + full pre-commit gate

**Files:** none (verification only; no commit unless a sweep turns up a stray reference to fix).

- [ ] **Step 1: Dangling-reference sweep (every command must print no matches).** `grep` exits non-zero on no match, so the `|| echo CLEAN` makes the expected result explicit. (Greps are scoped deliberately: a bare repo-wide `"generator"` would match the KEPT `app/lib/screener/` — `pick-generator.server.ts`, `generate.server.ts`, `CreativeGenerator` — so the screener lib is excluded from the union/nav check.)

```bash
grep -rn "screens/Predictor\|screens/Generator\|ScreenPredictor\|ScreenGenerator" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no screen refs"
grep -rn "app/screener\|app/generator\|/app/screener\|/app/generator" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no route refs"
grep -rn "fetchLatestScreenRun\|screenCreative\|adaptScreenRun" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no dead Predictor-only screener client fns"
grep -rn "/dashboard/api/screener" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no old screener route refs"
grep -rn "PredictorCard" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no PredictorCard"
grep -rn 'navigate("predictor")\|navigate("generator")' app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no predictor/generator navigate"
grep -rn '"predictor"\|"generator"' app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx app/components/dashboard/screens/dashboard-layout.ts || echo "CLEAN: union/nav/layout free of predictor/generator"
grep -rn "parseGeneratorForm\|weakestMetrics\|GENERATOR_STYLES\|GENERATOR_ASPECTS\|parseCreativeForm\|isMetaSubmit" app/ --include="*.ts" --include="*.tsx" || echo "CLEAN: no app.generator/app.screener route helpers"
```

Expected: each line prints its `CLEAN: …` message and nothing else. (Confirms zero dangling imports/refs across both surfaces — including the `PredictorCard` identifier, which catches the `OriginalLayout` JSX usage that a `"predictor"`-string grep would miss — and that the deleted routes' local helpers have no surviving callers.)

- [ ] **Step 2: Run `/code-review` on the working tree.** Resolve every blocker; downgrade any nit with a one-line justification. For a pure-deletion phase the expected finding set is empty.

- [ ] **Step 3: Patch sanity.**

```bash
git diff --stat HEAD~4
git diff --check HEAD~4
```

Expected: `git diff --check` prints nothing (no whitespace errors / conflict markers); the stat shows only the files listed in this phase's **Files** block — no stray `console.log`, `.only`, commented-out blocks, or AI/provenance markers introduced. (`HEAD~4` = the four Task 4.1–4.4 commits; Task 4.5 adds none.)

- [ ] **Step 4: Run the full pre-commit eval pipeline, in order.**

```bash
npm run typecheck
npm run lint
npm run build
npm run test
```

Expected (paste the real output, rule 12 — do not assert without evidence):
- `npm run typecheck` → exit `0` (`tsc --noEmit`, no dangling imports to the deleted modules; `SCREENS`/`STACK_H` exhaustive again).
- `npm run lint` → exit `0`, no warnings on touched files (no unused `RingGauge`/`GradePill`/`ScreenPredictor`/`ScreenGenerator` imports remain).
- `npm run build` → exit `0` (`remix vite:build` + `verify:client-bundle` both pass; no Prisma/GraphQL changes in this phase, so those gate steps are N/A).
- `npm run test` → exit `0` (full vitest suite green, including the four new guard tests and the edited `page-fullwidth` / `route-helpers` / `dashboard-layout` tests; the dead `generator-route.test.ts` and `adapt-screen-run.test.ts` are gone).

- [ ] **Step 5: Dashboard-parity confirmation (CLAUDE.md).** Removal landed on **both** surfaces: embedded routes + NavMenu (Task 4.1) and the dashboard SPA screens/nav/Overview (Tasks 4.2–4.4). No mirror repo change is needed — the dashboard drop-in runs through the new `dashboard.api.campaigns.$id.screen` route (Phase 2), so the old `dashboard.api.screener.tsx` is removed here (Task 4.4); there is no `dashboard.api.generator` route to remove (verified absent). State this explicitly in the phase wrap-up; nothing is shipped single-sided.

---

## Done criteria & finish

The feature is complete when, on the `feat/campaign-creative-hub` worktree:

- All four phases' tasks are checked off and committed (one logical change per commit).
- `npm run typecheck`, `npm run lint` (no warnings on touched files), `npm run build`, and `npm run test` all exit 0 — **output pasted, not asserted** (rule 12). `npx prisma validate` / `migrate diff` are N/A (no Prisma schema change); the one Supabase migration is validated by the engine-schema test run.
- **Both surfaces** show: the Calderyn score (dashboard `ScorePill` / embedded Polaris `Badge`), the "How to improve" panel, the per-ad Creatives scorecards, per-campaign Regenerate, and "Screen a new creative". The Meta paused-draft push works behind the `ads_management` capability gate and is reversible from Action history.
- `/code-review` on the working tree is clean — every blocker resolved; any nit downgraded with a one-line justification.
- The Predictor and Generator tabs are gone from both surfaces with zero dangling references (Task 4.5 sweep is empty).

Then use **superpowers:finishing-a-development-branch** to integrate (merge / PR per your call). Do not push or open a PR automatically — that waits for an explicit request (CLAUDE.md commit hygiene).
