# Store builder: premium generation + product-page A/B testing

Date: 2026-07-09. Surfaces: `app/lib/storegen/`, `app/lib/storebuilder/`, `app/lib/experiments/`, storefront serving routes, Store studio screen. One migration.

## Problem

Two audits (2026-07-09) of the store builder found 21 defects/gaps. Merchant-visible symptoms: generated stores read as generic AI output, several builder features are silently broken, and the A/B system is home-only with canned challengers and several measurement bugs. This spec covers one PR that fixes the correctness bugs, raises output quality, and extends A/B testing to product pages with an AI-generated challenger.

## Track 1 — Generation correctness

1. **Empty `ids` product grids.** `resolve-data.server.ts` resolves ids via a fixture-only `h-<id>` handle convention that matches nothing in production. Fix: resolve ids against the catalog product list by real id (single `listProducts` pass, order-preserving). Update the test mocks that baked in the broken convention.
2. **Regeneration wipes the merchant logo.** `generate.server.ts` hardcodes `logoUrl: null` into `saveStoreSettings`. Fix: omit `logoUrl` (same preserve-by-omission the vibe already gets); `settings.server.ts` only writes provided fields.
3. **Token budget.** Raise default `STOREGEN_TOKEN_BUDGET` 20k → 60k; cap the catalog menu sent to prompts (60 products / 30 collections, prefer collection-covered products); reserve `maxTokens` per in-flight call so concurrent Stage-2 calls cannot collectively overshoot the gate; record `budget_hit` in the generation audit row.
4. **Truncation.** Check `stop_reason`. A `max_tokens`-truncated home is a miss (never ship half a page); truncated doc plans retry once (below) before falling back.
5. **Junk gate.** Extract the HTML meaningfully: prefer a fenced ```html block anywhere in the reply, else slice from the first `<`; then require a `<div` root and `</div>` close. Prose preambles and refusals containing incidental tags no longer leak onto the storefront.
6. **`richText` literal tags.** Strip HTML tags from the `richText.html` prop at assembly (`storegen/sanitize.ts`) — the renderer correctly refuses to inject HTML, so tags must never reach it. Prompt now says "plain text, no HTML tags".
7. **Achromatic palette snapping.** A grayscale model hex (black/white/gray brief) currently snaps to the teal default. Fix: when saturation is negligible, snap by lightness to the neutral palette (Charcoal) instead of by hue.
8. **Degraded-run honesty.** `llmOk` counts junk replies as success. New rule: a run where every page doc fell back while the model was attempted reports `failed`. `dashboard.builder.generate.tsx` redirects with `?status=failed`; the preview route shows a plain banner ("We couldn't reach the design engine — this is a starter layout, not your generated store.").
9. **PDP layout scramble.** Doc-driven PDP blocks auto-place into a 2-column CSS grid, separating price from title. Fix in the PDP route render: `productGallery` blocks compose the left column; every other block stacks in y-order in the right (buy) column — the layout the fallback doc always intended.

## Track 2 — Premium output (anti-slop)

1. **Model.** All storegen calls (brand + collection/PDP plans) move to `claude-sonnet-5` by default (was Haiku via `digestModel()`); `STOREGEN_MODEL` seam unchanged. Cost is bounded by the existing daily designer quota + per-run budget.
2. **Retry-once.** A doc call whose reply fails to parse/validate retries exactly once with an appended corrective instruction; the home call retries once on truncation or a failed junk gate. Budget-gated like any call.
3. **Prompt fixes.** Repair the overlapping y-values in `HOME_FEWSHOT`; add one small exemplar each for collection and PDP plans (copy style + rhythm); tell the home model to consume the palette through `var(--cd-primary, <hex>)`-style custom-property fallbacks so studio accent/vibe changes affect AI homes instead of being baked-in no-ops.
4. **Fallback voice.** Unchanged this PR (still deterministic), but with retry + Sonnet the fallback frequency drops from "designed-in production state" to genuine last resort.

Out of scope, noted for follow-ups: imagery pipeline wiring into generation (Higgsfield endpoint still unverified), studio hero editor on rawHtml homes, preview-iframe rawHtml link mapping, overlapping-run interleaving.

## Track 3 — A/B testing that can actually improve conversion

**Migration** (`store_experiment`): relax `page_key` check to `('home','pdp')`. The one-running-per-shop unique index stays — one experiment at a time keeps checkout attribution unambiguous.

**New challenger kinds** (`buildChallenger`):
- `pdp_copy` (deterministic, pdp): clones the published PDP template and inserts a buy-box reassurance block (shipping/returns line templated from real store facts) plus a benefit-led hero patch. Classic CRO test, zero AI dependency.
- `ai_page` (AI, home): generates a full alternative home via the existing HTML path with a conversion-focused brief ("same brand, different composition and angle"), sanitized identically. Refuses cleanly (`ai_unavailable`, 503) when the API fails — never a fake variant. Quota-gated via the shared designer quota.
Existing `headline`/`vibe` kinds unchanged.

**Serving.** `RunningExperiment.pageKey` becomes `'home' | 'pdp'`. `storefront.products.$handle` serves the variant PDP doc for arm B and stamps exposure. Vibe experiments (treatment is sitewide) now stamp exposure on PDP/collection views too, fixing the treated-but-unmeasured population.

**Measurement fixes:**
- *First-visit consistency:* every experiment surface (layout vibe, home doc, PDP doc, exposure stamps) resolves the visitor via `peekVisitorId` only. No cookie yet → champion, no stamp; the same request still sets the cookie so the next request buckets deterministically. Kills the wrong-arm first-visit exposure bug.
- *Checkout:* the confirmation route stamps `checkout_complete` events with the order's attribution (fallback: live lookup), making the report's documented conversion fallback real. The checkout action attaches the visitor Set-Cookie headers it currently drops, and skips the attribution stamp instead of coin-flipping when no valid visitor id exists.
- *Ship-on-loss:* `decideExperiment("ship")` refuses (422 `variant_losing`) when the report shows B's rate below A's at ≥95% confidence; the studio TopBar only offers Ship as primary when B leads.
- *Guard bypasses:* Discover's `pickProduct` goes through `assertCanGenerate` (mid-test refusal + quota + rate limit) like every other generate entry point; studio `vibe`/`accent`/`save-hero` actions 409 while an experiment runs (same posture as publish).

Follow-ups noted, not in this PR: auto-decide/max duration, sequential-testing correction, revenue metric, per-arm funnel, cross-device identity.

## Testing

Unit coverage for every fix beside the existing suites (vitest). The pre-commit gate (typecheck, lint, build, tests) must be green before commit. Migration applied to prod only after the gate passes (additive constraint relax, inert until the code ships).
