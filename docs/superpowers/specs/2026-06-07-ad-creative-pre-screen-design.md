# Ad Creative Pre-Screen ("Virality Predictor") — Design

**Date:** 2026-06-07
**Status:** Draft for review
**Author:** brainstorming session (Eric Chen)

## 1. Summary

A standalone tool that scores an ad creative's likely performance **before it goes
live** — a "test screening before you hit publish." The merchant selects an
existing draft/paused ad from their connected Meta account (or enters one
manually), and Calderyn returns:

- a **composite Virality Potential score (0–100)** + a predicted grade
  (`winning` / `okay` / `poor`, reusing the existing campaign-grade vocabulary),
- **predicted outcomes** grounded in the merchant's own Meta history and the
  mapped SKU's price — headlined by an **Estimated ROAS**,
- a **breakdown of creative dimensions** (16 metrics in 5 groups), each
  click-to-expand to show Claude's reasoning and the historical ads it was
  benchmarked against,
- a ranked **tips** list of concrete fixes, and
- **generated improved variations** (copy, image, video) produced through an
  anti-slop loop that re-scores every variant and only surfaces improvements.

The architecture mirrors the existing `app/lib/simulator/` module (the proven
"predict before it happens" pattern in this repo): a Claude forced-tool scorer,
a **deterministic** calibration layer grounded in real account data, a
dependency-injected orchestrator, and a persisted run table.

## 2. Success criteria

1. A merchant can pick a connected Meta draft/paused ad (or enter image + copy +
   targeting manually) and receive a full scorecard.
2. Each of the 16 metrics renders as a bar and expands to show a Claude-authored
   reasoning string; metrics that are history-benchmarked name the reference ads.
3. **Estimated ROAS** is computed deterministically from the mapped SKU's real
   price + the account's CTR/CVR history + a user-editable spend assumption, and
   is compared against the existing `break_even_roas`.
4. The merchant can generate improved variations; every variation is re-scored,
   regressions are discarded, and only variants that beat the original surface,
   ranked best-first.
5. A chosen variant can optionally be pushed to Meta as a **paused** draft via
   the existing integration. Nothing auto-publishes.
6. Cold-start / unmapped cases degrade to clearly-labeled low-confidence output
   instead of fabricating numbers.
7. Repo gate is green: `tsc --noEmit`, `lint` (0 warnings on touched files),
   `build`, and `prisma validate` (new table) all pass; new logic is covered by
   behavior tests.

## 3. Non-goals

- No auto-publishing or auto-budgeting. Human approves every live action.
- No new scoring of *whole campaigns* — this is per-creative.
- v1 does not build a generation provider; it builds the **adapter + gate** and
  ships **copy** generation natively. Image/video execute only when a provider
  (e.g. higgsfield) is connected (see §9, §11).

## 4. User flow

1. Merchant opens `/app/screener`.
2. **Source step:** either (a) pick a draft/paused ad from the connected Meta
   account, or (b) manual entry (upload image / paste video URL + headline +
   primary text + CTA + objective + audience summary).
3. Calderyn resolves the creative → SKU (reusing `resolveAttribution` on the
   destination URL's UTM/click params), fetches the SKU price and the account's
   ad history, and runs the scorer.
4. **Result view:** composite score + predicted grade + confidence; predicted
   outcomes (Estimated ROAS headline, hold/engagement %, CTR); 5 metric groups
   with expandable reasoning; ranked tips; spend input (editable, recomputes
   ROAS).
5. **Improve:** merchant requests variations. Adapter generates (copy now;
   image/video if a provider is connected), each is re-scored, winners are shown
   ranked with their new scores.
6. **Act:** merchant may push a selected variant to Meta as a paused draft, or
   copy the suggested text. Runs are persisted and listed in a history sidebar.

## 5. Architecture — `app/lib/screener/`

Mirrors `app/lib/simulator/` for convention (repo rule 11) and testability.

| File | Responsibility |
|---|---|
| `types.ts` | DTOs: `CreativeScreenRun`, `ScoreCard`, `MetricScore`, `MetricGroup`, `PredictedOutcomes`, `Tip`, `Variant`, `GenerationMode`, status enums, min/max constants. No raw DB rows leak. |
| `score.server.ts` | Claude **forced-tool** call (pattern: `simulate.server.ts`'s `REPORT_TOOL`). Emits per-dimension 0–100 score + reasoning string. Vision input = the creative image; text input = copy + targeting + brand context + the merchant's top-3 historical ads as style references. Injectable `CreateMessageFn`. |
| `calibrate.server.ts` | **Deterministic.** Maps dimension scores → CTR/engagement multipliers; combines with account history + SKU price → `PredictedOutcomes` (incl. Estimated ROAS); computes composite score + predicted grade + confidence. No model calls. |
| `history.server.ts` | Reads the calibration inputs from Supabase: account CTR/engagement baselines (`ad_engagement_fact`, `ad_spend_fact`), `campaign_grade_fact` (`roas`, `break_even_roas`), top-N historical ads, and the mapped SKU's price (`sku_dim.price_cents` / `v_skus_flat`) + CVR (`order_fact` / `attribution_fact`). |
| `generate.server.ts` | `CreativeGenerator` adapter interface + the **re-score gate** orchestration (brief → generate → re-score → keep winners). Copy generator (native Claude) implemented; image/video generators are provider-backed (§11). |
| `brief.server.ts` | Claude turns scored flaws into a structured, diff-like **edit brief** (KEEP / CHANGE constraints) used by the generators. |
| `meta-creative.server.ts` | New Meta read path: list draft/paused ads + fetch a creative's image/copy/targeting; push a variant as a paused draft. Built on existing `metaClientForShop` + `client.server.ts`. |
| `runs.server.ts` | Persist runs to `creative_screen_run` (pattern: simulator `runs.server.ts` — `startRun`/`completeRun`/`failRun`/`getLatestRun`/`listRuns`). |
| `orchestrate.server.ts` | DI wiring (pattern: simulator `orchestrate.server.ts`): source → score → calibrate → persist, with the same in-app error-DTO behavior on failure. |

Route: `app/routes/app.screener.tsx` (loader = history + latest run; action = run
screen / generate variations / push to Meta). Mirrors `app.simulator.tsx`.

## 6. Scoring model — metrics

**Composite:** weighted roll-up of dimension scores → 0–100 + predicted grade
(`winning ≥ X`, `okay`, `poor`) using the existing `gradeTone` vocabulary.

**Predicted outcomes (deterministic, calibrated — §7, §8):**
1. **Estimated ROAS** (headline)
2. Hold / engagement rate
3. Click-through rate

**Creative dimensions (Claude vision + reasoning), 4 groups, 13 metrics** (these
4 groups + the Predicted-outcomes group above = the 5 metric groups; 13 + 3 = 16
total metrics):

- **Attention** — Hook strength · Visual focal clarity · Brand presence/recall
- **Message** — Headline clarity · Copy concision · Readability/tone match
- **Offer & Conversion** — Offer strength · Creative↔offer fit · CTA strength ·
  Audience/targeting fit
- **Trust & Safety** — Social proof/trust signals · Policy/compliance risk
  (qualitative: Low/Med/High) · Text-in-image density (heuristic %)

Each `MetricScore` carries: `id`, `group`, `label`, `score` (0–100 or
qualitative), `reasoning` (string), and optional `benchmarkAds` (names/ids of the
historical ads compared against). Policy-risk and text-density are flagged in
`types.ts` as **heuristic** (not pure Claude judgment) so the UI can style them
differently.

## 7. Estimated ROAS model

Deterministic arithmetic in `calibrate.server.ts` — the model does language
work, the code does the math (repo rule 5):

```
predicted_CTR      = account_baseline_CTR × ctr_multiplier(dimension_scores)
predicted_clicks   = projected_impressions × predicted_CTR
predicted_orders   = predicted_clicks × CVR_baseline(mapped_SKU)
predicted_revenue  = predicted_orders × mapped_SKU_price_cents / 100
estimated_ROAS     = predicted_revenue / assumed_spend
                     compared against break_even_roas (existing)
```

- `ctr_multiplier` is a documented weighted function of the attention/offer/CTA
  dimension scores, normalized so an "average" creative ⇒ 1.0×.
- `projected_impressions` derived from `assumed_spend` and the account's
  historical CPM. `assumed_spend` is **user-editable**, pre-filled with the
  median spend of the account's recent ads.
- Output includes a **likely range** (band), not just a point estimate.

## 8. Calibration & grounding

- **Sources:** `ad_engagement_fact` (engagement → hold rate baseline),
  `ad_spend_fact` (CPM, CTR baseline), `campaign_grade_fact`
  (`roas`, `break_even_roas`), `order_fact` + `attribution_fact` (SKU CVR),
  `sku_dim`/`v_skus_flat` (price). Creative→SKU via `resolveAttribution`.
- **Top-3 historical ads** (by engagement/ROAS) are passed to the scorer as
  style references and named in `benchmarkAds`.
- **Cold start / unmapped:** if the creative resolves to no SKU, or the SKU /
  account has insufficient history (below a documented threshold), calibration
  falls back to category/account-wide baselines and the result is labeled
  **"low confidence — not SKU-calibrated."** Estimated ROAS shows a wide range
  or qualitative band rather than a hard number. The fallback is surfaced in the
  UI, never silent (repo rule 12).

## 9. Anti-slop generation loop

`generate.server.ts` orchestrates: **flaws → brief → generate → re-score gate →
ranked winners.**

1. **Flaws** come from the scorecard (concrete, per-dimension), not free text.
2. **Brief** (`brief.server.ts`): Claude produces a diff-like KEEP/CHANGE spec.
   Edits the real creative; style refs = the merchant's own top ads.
3. **Generate** via `CreativeGenerator`:
   ```ts
   interface CreativeGenerator {
     mode: GenerationMode;            // "copy" | "image" | "video"
     available(): boolean;            // false ⇒ UI shows "connect a generator"
     generate(brief: EditBrief, base: CreativeInput): Promise<GeneratedVariant[]>;
   }
   ```
   - **Copy** — native Claude. Implemented in v1, no external dependency.
   - **Image** — provider-backed (edit/inpaint on the original).
   - **Video** — provider-backed, **async** (most expensive/slowest).
4. **Re-score gate:** every variant runs back through `score.server.ts`. A
   variant is kept only if it beats the original on its target dimensions and
   does not regress the composite. Rejects are discarded (counted + logged, not
   shown).
5. **Ranked winners** surface best-first with new scores. Optional push to Meta
   as a paused draft.

**Anti-slop guarantees** (encoded, not aspirational): edit-don't-invent;
brand-own style refs; constraint-driven brief; judge-don't-trust re-score gate;
human approval before any live action.

## 10. Data model

New **Supabase** table `creative_screen_run` (timestamped SQL migration in
`supabase/migrations/`, mirrored in `tests/engine/schema/migrations/` — the same
mechanism used for `simulation_run`; **not** Prisma, which only backs Shopify
session storage):

| Column | Notes |
|---|---|
| `id` | pk |
| `shop_id` | fk → shops |
| `status` | `running` / `done` / `error` (matches simulator) |
| `source` | `meta_ad` / `manual` |
| `meta_ad_id` | nullable |
| `mapped_sku_id` | nullable (cold-start) |
| `assumed_spend_cents` | user input |
| `scorecard` | JSON blob (ScoreCard DTO) — heavy field, not selected in list queries |
| `variants` | JSON (generated + kept variants with re-scores) |
| `error` | nullable |
| `created_at` / `completed_at` | timestamps |

Plus a `v_creative_screen_runs` view for list queries (mirrors
`v_simulation_runs`). DTOs are shaped in `types.ts`; raw rows never leak.

## 11. External generation provider (higgsfield) integration

- Image/video generators implement `CreativeGenerator`. Provider config
  (endpoint + credentials) read from `process.env` server-side only; documented
  in `.env.example` (repo secret-storage rule: real keys in `.env.local`).
- `available()` returns `false` when unconfigured → the UI greys out image/video
  generation with a "connect a generator" affordance. No crashes, no fake output.
- **The re-score gate is provider-agnostic** — quality is enforced regardless of
  which backend produces the pixels.
- If/when higgsfield ships an MCP server the merchant connects, an MCP-backed
  generator can implement the same interface; until then, a direct HTTP adapter
  is the path. **This is a new external dependency** and is called out per repo
  policy.

## 12. Error handling & failure visibility (rule 12)

- Orchestrator catches and returns an in-app error DTO (banner), not a crash
  (pattern: simulator).
- Missing `ANTHROPIC_API_KEY`, Meta auth failure, unmapped SKU, provider
  unavailable, and re-score rejections are each surfaced explicitly.
- Discarded variants are counted and shown ("3 variants generated, 1 beat the
  original").

## 13. Testing strategy (behavior, not theater — rule 9)

- `calibrate.test.ts` — ROAS/CTR math with fixed inputs incl. cold-start
  fallback; asserts labeled low-confidence path.
- `score.test.ts` — scorer with an injected fake `CreateMessageFn` (no SDK
  import), asserts forced-tool parsing + reasoning passthrough.
- `generate.test.ts` — re-score gate with a fake generator: regressions
  discarded, only winners returned, ranking correct, `available()===false` path.
- `meta-creative.test.ts` — creative fetch + paused-draft push with a fake Meta
  client; asserts pushes are always paused.
- Route action tests — manual + meta source, validation at the action boundary.
- Tenant isolation test (pattern: `calderyn-shop-scope.test.ts`) — a shop only
  sees/screens its own data.

## 14. Scope & phasing

All three generation modes are **specced and interface-complete in v1**. Runtime
availability:
- **Copy generation:** live in v1 (native Claude).
- **Image / video generation:** built behind the adapter + gate in v1, but
  **execute only when a generation provider is connected** (credentials present).
  Until then the UI advertises them as available-when-connected. The orchestration,
  brief, and re-score gate are tested against a fake generator so the path is
  verifiable without the real provider.

## 15. Open questions / risks

1. **Provider choice & cost** — higgsfield vs. alternatives; per-image / per-video
   cost and latency ceilings. Video is async and the most expensive path.
2. **Composite weighting** — the exact dimension→composite and dimension→CTR
   multiplier weights need an initial heuristic + a way to tune them later.
3. **Meta draft/paused listing** — confirm the Graph API surface and permissions
   for listing unpublished/paused ads under the existing OAuth scopes.
4. **Calibration confidence thresholds** — the minimum history counts that switch
   between "calibrated" and "low confidence" need concrete values.

## 16. Config / env additions

- Generation provider: endpoint + API key env vars (names TBD with provider);
  documented in `.env.example`, real values in `.env.local` only.
- Reuses existing `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, Supabase, and Meta
  OAuth config.
