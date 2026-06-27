# Design: Campaign Creative Hub — merge Screener + Generator into Campaigns

**Date:** 2026-06-27. **Status:** approved design, pre-plan. **Surfaces:** dashboard (`app/components/dashboard/screens/`) + embedded admin (`app/routes/app.*`) — both required (CLAUDE.md dashboard parity).

This is the validated design for folding the ad **Screener** (a.k.a. "Creative Predictor") and **Generator** into the **Campaigns** feature, giving every campaign a blended **Calderyn score** with improvement guidance, per-campaign regeneration, drop-in creative screening, and a real Meta paused-draft push.

---

## 1. Goal

Today screening and generation live in their own tabs (`Predictor`, `Generator`) decoupled from the campaigns merchants actually manage. Consolidate so the campaign is the single workspace: each campaign carries a score, shows how to improve, can regenerate its weak creatives, can have new creatives dropped in to screen, and can push an improved creative back to Meta as a paused draft.

## 2. Locked decisions (from brainstorming)

1. **Score basis** = **blend of creative quality + live performance**.
2. **"Creator"** = the existing Generator. Only **two** features merge (Screener + Generator), not three.
3. **Navigation** = **full merge**; remove both the `predictor` and `generator` tabs from the rail. Everything is campaign-scoped. *Accepted tradeoff:* a store with zero campaigns has no screening entry point.
4. **Regen output** = **push the winning variant to Meta as a paused draft** ("Increment A" from the prior handoff). Feasible: OAuth already requests `ads_management,ads_read` (`app/lib/meta/oauth.server.ts`) and Meta writes are an established pattern (`app/lib/meta/actions.server.ts`).
5. **Architecture** = **server-side blend** (single source for both surfaces), built in **4 internal phases that all ship** in this feature.
6. **Blend weighting** = `value = 0.7·P + 0.3·C` (performance-led). **ScorePill replaces** the existing winning/okay/poor GradePill as the single primary campaign indicator.

## 3. The Calderyn score model

Computed once server-side in a new pure module; both surfaces consume the same DTO (same philosophy as `app/lib/campaign-grade.ts`'s "single source both surfaces use").

### Inputs
- **Performance** — the grade row already returned by `fetchAnalytics().grades` / `v_campaign_grades` (`CampaignGradeRow`: `grade, roas, break_even_roas, spend_cents, revenue_cents`). Resolved through the existing `gradeFromRow` so an attribution gap stays `nodata`, never false-`poor`.
- **Creative** — the per-ad creative scorecards already produced for the campaign's ads by `app/lib/screener/campaign-ads.server.ts` (`loadCachedAdScorecards` / `loadOrScoreAdScorecards`). Each has `scorecard.composite` (0–100), grade, confidence, per-metric scores, tips.

### Normalization
- **Creative half `C` ∈ [0,100]:** mean `composite` of the campaign's **active** ads (paused ads excluded — they aren't running). Spend-weighted **if** per-ad spend is available; otherwise equal-weight. `C = null` when no ads are scored / Meta is disconnected.
- **Performance half `P` ∈ [0,100]:** `P = clamp(round(50 × roas / break_even_roas), 0, 100)`. Break-even anchors at 50; winning (≥1.2×) lands ≥60; a 2× return saturates at 100. `P = null` when the grade row is `nodata` (spend but zero attributed revenue — never fabricate, rule 12).

### Blend
- Both halves present: `value = round(0.7·P + 0.3·C)`.
- One half `null`: score on the present half alone and label the gap ("performance pending — attribution" or "connect Meta to score creatives"). Never substitute a placeholder number for the missing half.
- Both `null`: `band = "nodata"`, no numeric value.

### Bands & confidence
- **Band** (named constants, tunable): `strong ≥ 75`, `fair ≥ 55`, else `weak`; plus `nodata`.
- **Confidence** (`high|medium|low`) reuses the screener's pattern: driven by ad coverage (`adsCovered/adsTotal`), history depth, and whether performance is real. A low-confidence banner shows when coverage is thin or a half is missing.

### DTO
```ts
interface CampaignCalderynScore {
  value: number | null;        // blended 0–100, null when band === "nodata"
  band: "strong" | "fair" | "weak" | "nodata";
  performance: number | null;  // P
  creative: number | null;     // C
  confidence: "high" | "medium" | "low";
  weakDimensions: { label: string; score: number; adId: string }[];
  tips: string[];
  adsCovered: number;
  adsTotal: number;
}
```

## 4. Architecture & modules

### New — `app/lib/campaign-score/` (mirrors `screener/` conventions)
- `types.ts` — `CampaignCalderynScore` + constants (`PERF_WEIGHT = 0.7`, `CREATIVE_WEIGHT = 0.3`, band thresholds, perf-normalization anchor).
- `aggregate.server.ts` **(PURE)** — `aggregateAdScorecards(ads) → { creativeComposite, weakDimensions, tips, coverage }`. No I/O.
- `blend.server.ts` **(PURE)** — `blendScore({ performance, creative, coverage, perfIsNodata }) → CampaignCalderynScore`. All arithmetic here (rule 5: deterministic code does the math, Claude does none of it).
- `resolve.server.ts` — `resolveCampaignScore(shop, campaign, gradeRow, deps)`: loads **cached** ad scorecards, calls `aggregateAdScorecards`, maps `P` from the grade row, calls `blendScore`. DI for tests; returns a DTO, never throws.

### New — Meta write, routed through the existing executor
- `app/lib/meta/ad-create.server.ts` — `createPausedAd(client, { adAccountId, adSetId, creative }) → { adId }`: `post('/{adAccountId}/adcreatives', …)` then `post('/{adSetId}/ads', { status: "PAUSED", … })`. Pure-ish I/O helper; injectable `client` (fake `post` in tests, mirroring `meta/__tests__/campaigns.test.ts`).
- **New ExecutableKind** in the action executor (`app/lib/.../execute.server.ts`) — e.g. `push_creative_draft`. Invokes `createPausedAd`. Routing it through the executor inherits, for free and consistent with `increase_campaign_budget` etc.:
  - **idempotency** (dedup key = hash(campaignId + variant) so retries don't double-create),
  - **audit history** entry (visible in Action history),
  - **reversibility** — the undo path (`dashboard.api.audit.$id.undo.tsx`) deletes the paused draft ad (`deleteAd` inverse).

### Reused unchanged
`screener/{score,generate,calibrate,campaign-ads,runs}.server.ts`, `campaign-grade.ts`, `meta/client.server.ts` (its `post()`), the action queue / `executeCampaignAction`, the audit system, `components/Scorecard`.

## 5. UI / IA (both surfaces)

### List
- Each campaign row's primary indicator becomes the **Calderyn ScorePill** (0–100 + band), **replacing** `GradePill`. Built from **cached** scorecards only — no Claude calls on list render (cost guard, rule 6). Uncached → "score pending". ROAS column stays.
- ScorePill is a new shared UI primitive next to `GradePill` in `app/components/dashboard/ui` (band → color), reused by both surfaces.

### Campaign detail — four sections slotted into the existing `Card` layout (mirror, don't redesign)
1. **Score breakdown** — value, P/C split, confidence banner, `adsCovered/adsTotal`.
2. **How to improve** — aggregated `weakDimensions` + `tips`.
3. **Creatives** — per-ad scorecards. Embedded admin already renders these (`CreativeWithScorecard`/`AdScorecardSlot`/`Scorecard` in `app/routes/app.campaigns.$campaignId.tsx`); **port to the dashboard** `Campaigns.tsx`.
4. **Regenerate** + **Screen a new creative** (§6, §7).

### Tab removal
- Dashboard: remove `predictor` + `generator` from `NAV_ITEMS`, `SCREENS`, and the now-dead screener/generator client fns in `app/lib/dashboard/client.ts`.
- Embedded: delete `app/routes/app.screener.tsx` + `app/routes/app.generator.tsx` and their nav links in `app/routes/app.tsx`.
- **Keep** `app/lib/screener/` — now consumed inside campaigns.

## 6. Regenerate → Meta paused draft

Per-campaign **Regenerate** runs the existing generator re-score loop (`screener/generate.server.ts:generateImprovements`) seeded from the campaign's weakest scored ad → ranked winning variants (copy, and image when the image generator is available). Each winner shows **"Push to Meta as paused draft"** → dispatches the `push_creative_draft` action into that ad's ad set, `status: PAUSED`, logged + reversible.

Guardrails: idempotency dedup (executor); button disabled when the stored token lacks `ads_management` ("reconnect Meta to enable drafts"); failure surfaces a toast + a failed audit entry (no silent success, rule 12).

## 7. Drop-in screening

"Screen a new creative" reuses the Predictor manual form (headline / primary text / CTA / image URL / audience), scoped to the campaign. Scores via `screener/orchestrate.server.ts:executeScreen`, persists a `creative_screen_run`, and folds into the campaign's creative aggregate on next resolve.

## 8. Data model

- Reuse `creative_screen_run` / `v_creative_screen_runs` as-is (no schema change for scoring/screening/regen).
- Meta push idempotency + audit ride the **existing** action/audit tables (no new table). If the executor needs to persist the created `adId` for undo, add it to the existing action/audit record rather than a new table.
- Any migration that does prove necessary: new timestamped file in `supabase/migrations/` **and** a byte-identical mirror in `tests/engine/schema/migrations/` (repo convention).

## 9. Error / degraded states (rule 12)

| Condition | Behavior |
|---|---|
| Meta disconnected | creative half `null`; "connect Meta to score creatives"; no score fabricated |
| `nodata` performance | creative-only score + "performance pending (attribution)" |
| Per-ad score failure | per-ad error slot, excluded from aggregate, surfaced (existing `AdScorecardSlot` pattern) |
| Token lacks `ads_management` | push disabled + reconnect prompt |
| Meta push failure | toast + failed audit entry; idempotency prevents dupes on retry |
| Zero campaigns | no screening entry (accepted tradeoff); campaigns empty-state keeps "connect an ad account" copy |

## 10. Testing

- **Pure:** `aggregate.server.ts`, `blend.server.ts` — boundaries: zero ads, all paused, one half `null`, `nodata`, weighting math, band thresholds.
- **DI:** `resolveCampaignScore` (fake scorecard loader + grade row); `createPausedAd` (fake `post` — assert endpoints, `PAUSED`, dedup) per `meta/__tests__/campaigns.test.ts`.
- **Executor:** `push_creative_draft` idempotency + audit + undo (delete) path.
- **Routes:** parse/validate for new action routes (mirror `parseScoreForm`).
- **Client adapters:** new `calderynScore` field on both surfaces.
- No SDK imports in tests (injectable `CreateMessageFn`).

## 11. Phases (all ship; one feature, one worktree `feat/campaign-creative-hub`)

1. **Score** — `campaign-score/` lib + DTO; list ScorePill (cached) replacing GradePill; detail Score-breakdown + How-to-improve; both surfaces.
2. **Reuse** — Creatives section ported to dashboard; per-campaign Regenerate loop; Screen-a-new-creative drop-in; both surfaces.
3. **Push** — `createPausedAd` + `push_creative_draft` ExecutableKind (idempotency/audit/undo) + UI wire; both surfaces.
4. **Cleanup** — remove Predictor/Generator routes, tabs, and dead clients; verify no dangling imports; `tsc`/`lint`/`build` green.

Each phase passes the CLAUDE.md pre-commit gate (`/code-review`, `typecheck`, `lint`, `build`) and lands both surfaces (no single-sided ship).

## 12. Risks & open items

- **Per-ad spend for creative weighting** — VERIFY availability in `campaign-ads`/Meta insights. If absent, equal-weight active ads (documented fallback).
- **Real account history (Increment B)** — the screener's calibration still runs on fallbacks (CTR/CPM/CVR/ad-count not wired). The creative half inherits this approximation; the score is advisory. Out of scope here; note as the standing correctness gap.
- **Image regen provider** — copy regen always available; image regen depends on a connected generator. Degrade gracefully (copy-only variants) when unavailable.
- **List performance** — list uses cached scorecards only; a campaign whose ads were never scored shows "score pending" until its detail is opened (or a future warm-up job scores them). Acceptable for v1.
