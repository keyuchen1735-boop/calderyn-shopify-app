# Native CRO Recipe Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ten distinct native Calderyn storefront recipes, a reusable trusted component/media library, 30 visually approved generated videos, and preview/publication parity without changing the existing eleven recipes.

**Architecture:** Extend the existing compiler/runtime with backward-compatible optional routes and a trusted poster-first video contract. New recipes own their markup and styling while importing behavior-only fragments. Generated media is uploaded to a public-read, service-write Supabase bucket under immutable hash paths; saved bundles pin manifests and preview/publish resolve the same URLs.

**Tech Stack:** Remix, TypeScript, Vitest, parse5 compiler, React storefront renderer, declarative storefront runtime, Supabase Storage, Gemini image/video APIs, ffmpeg/ffprobe, Playwright browser proof.

## Global Constraints

- New IDs are exactly `volt`, `atelier`, `gilt`, `larder`, `ember`, `roast`, `fizz`, `forge`, `haven`, and `glow` at template version 1.
- In automatic mode, exactly one active product selects `volt` before niche scoring; manual recipe, explicit recipe-name, and explicit custom choices still win.
- The existing eleven recipes, their IDs, manifests, screenshots, saved drafts, and published releases remain unchanged.
- Recipes remain hidden/internal to Store Builder and bind critical content to the logged-in merchant's live catalog.
- Share trusted behavior only; every recipe owns DOM, CSS, typography, copy, rhythm, and niche composition.
- No arbitrary recipe JavaScript, external fonts, hotlinked media, fake reviews, fake scarcity, fake shipping promises, or unsupported commerce controls.
- Every new recipe supplies Home, Collections Index, Collection, Product, Search, Story, Cart, Checkout, and 404 surfaces.
- Every recipe supplies `hero`, `hero-alt`, and `pdp-detail` briefs plus approved MP4, WebM, poster, and gradient fallback assets.
- Video GREEN requires technical proof and full-loop visual approval; a poster fallback never hides a failed video.
- Preview and publication consume the same immutable bundle version and exact asset hashes.
- Merchant product photography always uses live catalog media or merchant-owned generated fallback media; proof-fixture product shots never ship into another merchant's store.
- Show each completed recipe through a no-HMR review page and then through the real saved-draft Store Builder preview after registration.
- TDD is vertical: one public-interface failing behavior, minimum implementation, green, then the next behavior.
- Use isolated worktrees. Recipe agents may modify only their recipe folder and task report; shared files are changed only by Tasks 1 and 12.

## File structure

- `app/lib/storefront-recipes/library/fragment.ts` — minimal fragment composition API.
- `app/lib/storefront-recipes/library/media.ts` — trusted video/image fragment source.
- `app/lib/storefront-recipes/library/commerce.ts` — shared proof, rail, sticky purchase, and cart fragments.
- `app/lib/storefront-recipes/library/motion.ts` — declarative scroll/motion attributes only.
- `app/lib/storefront-recipes/<slug>/bundle.ts` — recipe-owned nine-route config and compiled bundle export.
- `app/lib/storefront-recipes/<slug>/assets.ts` — immutable manifest.
- `app/lib/storefront-recipes/<slug>/bundle.test.ts` — public compiled-bundle behavior.
- `app/lib/storefront-recipes/<slug>/video-brief.md` — three exact generation briefs.
- `app/lib/storefront-recipes/<slug>/video-proof.json` — hash-pinned visual approval.
- `docs/superpowers/prototypes/storefront-recipes/<slug>.html` — no-HMR review source and source-parity reference.
- `scripts/import-storefront-recipe-media.mjs` — normalize, hash, poster, upload, and print manifest entries.
- `scripts/verify-storefront-recipe-media.mjs` — deterministic media/approval verifier.
- `supabase/migrations/*_storefront_recipe_assets.sql` — public-read/service-write bucket.

---

### Task 1: Shared compiler, routes, media, and component library

**Files:**
- Modify: `app/lib/storefront-bundle/types.ts`
- Modify: `app/lib/storefront-compiler/compile.ts`
- Modify: `app/lib/storefront-compiler/html.ts`
- Modify: `app/lib/storefront-compiler/validate.ts`
- Modify: `app/lib/storefront-runtime/render.tsx`
- Modify: `app/lib/storefront-runtime/hydrate.ts`
- Modify: `app/lib/storefront-runtime/release-resolution.server.ts`
- Modify: `app/lib/storefront-runtime/public-data.server.ts`
- Modify: `app/lib/storefront-recipes/factory.ts`
- Modify: `app/routes/dashboard.store.preview.tsx`
- Create: `app/routes/storefront.collections._index.tsx`
- Create: `app/routes/storefront.story.tsx`
- Create: `app/routes/storefront.$.tsx`
- Create: `app/lib/storefront-recipes/library/{fragment,media,commerce,motion}.ts`
- Create: `app/lib/storefront-recipes/library/library.test.ts`
- Create: `scripts/import-storefront-recipe-media.mjs`
- Create: `scripts/verify-storefront-recipe-media.mjs`
- Create: `supabase/migrations/202607200001_storefront_recipe_assets.sql`
- Test: the adjacent compiler/runtime/route tests for every modified file

**Interfaces:**
- Produces `NewStoreTemplateId`, the ten-ID union merged into `StoreTemplateId`.
- Produces optional source/artifact routes `collections`, `story`, and `notFound`.
- Produces `<video data-cd-video data-cd-poster-asset="hero-poster"><source data-cd-asset="hero-webm" type="video/webm"><source data-cd-asset="hero-mp4" type="video/mp4"></video>`.
- Produces `RecipeFragment` and `mergeRecipeFragments(...fragments): RecipeFragment`.
- Produces `compileRecipeConfig(config): CompiledBundleResult` for isolated recipe tests; `defineRecipe(config)` remains the only registry-validating production entry point.
- Produces `videoFragment(options)`, `proofBandFragment(options)`, `productRailFragment(options)`, `stickyPurchaseFragment(options)`, `cartProgressFragment(options)`, and declarative motion helpers.
- Produces media paths `storefront-recipe-assets/<templateId>/<sha256>.<ext>`.

**Reuse:** Replay the already reviewed shared-spine commits `c08f8b97`, `ddf7f925`, `c2636771`, `ca6ea7b4`, `52515da0`, `ad78ce0e`, and `ee1bcb19` onto current `origin/main`; resolve the `registry.ts` conflict by retaining current-main version history. Do not reimplement equivalent helpers.

- [ ] **Step 1: Write the failing compiler/renderer video tracer**

Add a test that compiles the exact markup above and renders a `video` with boolean playback attributes, two resolved sources, and a resolved poster. Assert that raw `src`/`poster` URLs remain rejected.

- [ ] **Step 2: Run the tracer RED**

Run: `npm test -- --run app/lib/storefront-compiler/html.test.ts app/lib/storefront-runtime/render.server.test.tsx --maxWorkers=1`
Expected: FAIL because `video`, its safe attributes, and poster asset binding are unsupported.

- [ ] **Step 3: Implement the minimum trusted video contract**

Allow only `video` plus fixed `muted`, `autoplay`, `playsinline`, `loop`, `preload`, `data-cd-video`, and `data-cd-poster-asset`. Compile logical keys to `data-cd-asset-key`/`data-cd-poster-asset-key`; resolve URLs only from the manifest-provided map.

- [ ] **Step 4: Add RED→GREEN runtime behavior one test at a time**

Test and implement: off-screen pause/resume with `IntersectionObserver`, no autoplay under reduced motion, poster retention on playback failure, and teardown cleanup. Use injected DOM observers in tests; do not mock internal runtime functions.

- [ ] **Step 5: Add RED→GREEN optional routes one route at a time**

Extend bundle source/artifacts with optional `collections`, `story`, and `notFound`. Add real Remix loaders/components that resolve the saved bundle and render status 404 for `notFound`. Existing six-route fixtures must compile unchanged.

- [ ] **Step 6: Add the minimal fragment library**

Implement:

```ts
export interface RecipeFragment { html: string; css: string }
export function mergeRecipeFragments(...fragments: readonly RecipeFragment[]): RecipeFragment {
  return { html: fragments.map((item) => item.html).join(""), css: fragments.map((item) => item.css).join("") };
}
```

Add only the named shared fragment functions. Each accepts caller-owned class names/copy/tokens and emits safe `data-cd-*` markup; it must not choose layout.

- [ ] **Step 7: Add immutable media import and verification**

Create the `storefront-recipe-assets` bucket as public read with no browser write policy. The import script uses service credentials, ffmpeg, and ffprobe to produce MP4/WebM/poster, validates 8-12 seconds, hashes bytes, uploads with `upsert: false`, and prints manifest JSON. The verifier checks formats, dimensions, duration, hashes, poster, and a matching approved `video-proof.json` record.

- [ ] **Step 8: Add all ten IDs without registering incomplete recipes**

Extend the type/archetype unions and routing exclusion types only. Do not import or register recipe modules until Task 12.

- [ ] **Step 9: Run focused and full shared-contract gates**

Run the adjacent tests serially, then `npm run typecheck`, `npm run lint`, and `npm run build`. Expected: all exit 0; old bundle fixtures remain byte/behavior compatible.

- [ ] **Step 10: Commit**

Commit: `storefront/runtime: add native recipe media and route contract`

---

### Task 1B: Trusted personalization cart lines

**Files:**
- Create: `supabase/migrations/202607200002_storefront_cart_line_personalization.sql`
- Modify: `app/lib/order/cart.server.ts`
- Modify: `app/lib/storefront/cart-api.server.ts`
- Modify: `app/routes/storefront.api.cart.add.tsx`
- Modify: `app/lib/storefront-runtime/trusted-slots.tsx`
- Test: adjacent cart repository, API route, and trusted-slot tests

**Interfaces:**
- Produces `StorefrontLinePersonalization` with optional bounded keys `engraving`, `giftNote`, `giftWrap`, and `recipient`.
- Cart identity remains server-owned; personalization never changes product ID, variant ID, price, inventory, tax, shipping, or discount eligibility.
- Distinct personalization payloads create distinct cart lines; identical variant plus canonical personalization increments the existing line.

- [ ] Add RED repository tests for canonical JSON equality, distinct engraved lines, identical-line quantity increments, and checkout preservation.
- [ ] Add RED API tests rejecting unknown keys, more than four keys, keys over 40 code points, values over 240 code points, non-string values, and cross-origin requests.
- [ ] Add migration columns `personalization jsonb not null default '{}'::jsonb` and `personalization_hash text`, backfill the hash, replace the variant-only unique constraint with `(shop_id, cart_id, variant_id, personalization_hash)`, and update the atomic add RPC.
- [ ] Thread the validated payload through the protected add-to-cart slot and order snapshot without exposing any pricing authority.
- [ ] Run focused cart/order tests, migration contract tests, typecheck, and commit `storefront/cart: preserve trusted personalization`.

---

### Task 2: Volt exemplar

**Files:**
- Create: `app/lib/storefront-recipes/volt/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}`
- Create: `docs/superpowers/prototypes/storefront-recipes/volt.html`
- Modify: `app/lib/storefront-bundle/{types.ts,routing.ts,routing-evidence.server.ts,routing.test.ts,routing-evidence.server.test.ts}`

**Interfaces:** Consumes Task 1 fragments, `compileRecipeConfig`, and route/media contracts. Produces `VOLT_RECIPE_CONFIG` without modifying shared registries; Task 12 wraps it with `defineRecipe`.

- Adds `activeProductCount: number` to `CatalogRoutingEvidence`; the stable fingerprint includes the normalized count.
- `resolveStoreDesign()` precedence is manual recipe, explicit custom, explicit recipe name, then `activeProductCount === 1` selecting `volt`, then niche scoring.

- [ ] Replay the reviewed Volt commits `e815ac72`, `9424575c`, and `7b6b7c91`; do not reuse the localhost auth-bypass preview experiment.
- [ ] Write one failing public bundle test proving nine routes, live product/collection bindings, no audio-only merchant copy, no proof-fixture product images, video manifest keys, comparison, ecosystem builder, sticky purchase/cart behaviors, and reduced-motion declarations.
- [ ] Write failing routing tests proving one active product selects `volt` in `auto`, while manual recipe and explicit custom requests still win.
- [ ] Run `npm test -- --run app/lib/storefront-recipes/volt/bundle.test.ts --maxWorkers=1`; expect RED because the recipe does not exist.
- [ ] Implement the approved universal single-product architecture with a dark rim-lit cinematic hero, architectural catalog modules, and dense comparison rail. All product/niche content binds to merchant data.
- [ ] Write exactly three briefs for `hero`, `hero-alt`, and `pdp-detail`; generate coherent reference stills and clips through Gemini, import the results, inspect each full loop, regenerate failures, and record approved hashes.
- [ ] Serve `volt.html` without HMR, open it once for review, then keep production binding parity locked in `source-parity.test.ts`.
- [ ] Run the focused test plus `node scripts/verify-storefront-recipe-media.mjs --template volt`; expect PASS.
- [ ] Commit: `storefront/volt: add system-first audio recipe`

---

### Task 3: Atelier fit laboratory

**Files:** Create `app/lib/storefront-recipes/atelier/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/atelier.html`

**Interfaces:** Produces `ATELIER_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] Replay reviewed commits `19b871f3`, `230d95f5`, and `a2d4aa44`, then write the remaining RED assertions for nine routes, garment-measurement composition, live variants, fit finder state, truthful size-confidence evidence, sticky purchase, cart drawer, and all media keys.
- [ ] GREEN implementation: soft stone/oxblood fit laboratory, calm fabric macro, body-aware measurement flow; explicitly reject Atelier Grid's asymmetric magazine structure.
- [ ] Generate and visually approve three Gemini videos with stable garment geometry and fabric texture; import and verify.
- [ ] Run focused test/media proof and commit `storefront/atelier: add fit laboratory recipe`.

---

### Task 4: Gilt object ceremony

**Files:** Create `app/lib/storefront-recipes/gilt/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/gilt.html`

**Interfaces:** Produces `GILT_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] Replay reviewed commits `9bcfc457` and `722f35d0`, then write RED tests for nine routes, live jewelry variants, trusted engraving state, gift wrap/note/recipient flow, proof near CTA, and media manifest.
- [ ] GREEN implementation: dark cream/black/gold object ceremony with floating macro jewelry and guided recipient handoff; not a workshop configurator.
- [ ] Generate and approve three Gemini videos with stable jewelry topology, reflections, and engraving surfaces; import and verify.
- [ ] Run focused test/media proof and commit `storefront/gilt: add gifting jewelry recipe`.

---

### Task 5: Larder working pantry

**Files:** Create `app/lib/storefront-recipes/larder/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/larder.html`

**Interfaces:** Produces `LARDER_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, live pantry catalog, subscribe toggle defaulted on only when a plan exists, reorder state, six-slot box builder, cart progress, and media keys.
- [ ] GREEN implementation: warm paper/tomato/olive shelf navigation and tactile replenishment rhythm, distinct from Ritual Almanac.
- [ ] Generate and approve ingredient-cascade, kitchen-context, and package-texture videos; no accidental packaging text.
- [ ] Run focused test/media proof and commit `storefront/larder: add working pantry recipe`.

---

### Task 6: Ember heat spectrum

**Files:** Create `app/lib/storefront-recipes/ember/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/ember.html`

**Interfaces:** Produces `EMBER_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, merchant heat facts, heat filter, tasting-flight bundle, UGC band that hides without real entries, stock urgency, and media keys.
- [ ] GREEN implementation: blackened tasting counter, pepper red scale, raw vertical proof strip, and high-contrast mobile controls.
- [ ] Generate and approve sauce-pour, tasting-table, and texture videos with coherent viscosity and containers.
- [ ] Run focused test/media proof and commit `storefront/ember: add heat-led tasting recipe`.

---

### Task 7: Roast brew notebook

**Files:** Create `app/lib/storefront-recipes/roast/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/roast.html`

**Interfaces:** Produces `ROAST_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, origin facts, grind option, brew quiz, available cadence picker, subscription/cart behavior, and media keys.
- [ ] GREEN implementation: espresso/cream/orange brew notebook with roast data plots and preparation-first product detail, distinct from ritual editorial.
- [ ] Generate and approve roasting, brewing-context, and bean/grind macro videos with physically coherent liquid and steam.
- [ ] Run focused test/media proof and commit `storefront/roast: add brew notebook recipe`.

---

### Task 8: Fizz flavor playground

**Files:** Create `app/lib/storefront-recipes/fizz/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/fizz.html`

**Interfaces:** Produces `FIZZ_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, flavor quiz, bounded variety pack, real eligible first-box offer, product rail, cart progress, and media keys.
- [ ] GREEN implementation: cobalt/coral/citrus stackable-can composition and punchy proof ticker, distinct from technical patch-bay UI.
- [ ] Generate and approve floating-can, social-table, and condensation/bubble macro videos with stable can geometry and no invented labels.
- [ ] Run focused test/media proof and commit `storefront/fizz: add flavor playground recipe`.

---

### Task 9: Forge jobsite blueprint

**Files:** Create `app/lib/storefront-recipes/forge/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/forge.html`

**Interfaces:** Produces `FORGE_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, merchant compatibility facts, project filters, job bundle, downloadable spec link, trusted cart action, and media keys.
- [ ] GREEN implementation: steel/orange/parchment blueprint layout, exploded tool details, standards-led comparison, distinct from Custom Bench.
- [ ] Generate and approve tool-motion, jobsite-context, and material/mechanism macro videos with mechanically coherent parts.
- [ ] Run focused test/media proof and commit `storefront/forge: add jobsite blueprint recipe`.

---

### Task 10: Haven spatial quiet

**Files:** Create `app/lib/storefront-recipes/haven/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/haven.html`

**Interfaces:** Produces `HAVEN_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, live dimensions, room-fit result, delivery estimate, swatch SKUs, AR handoff label, sticky purchase, and media keys.
- [ ] GREEN implementation: ash/walnut/clay room-scale frames and material tray, distinct from smart-home spatial scenes.
- [ ] Generate and approve slow interior dolly, lived-room context, and upholstery/joinery macro videos with stable furniture geometry.
- [ ] Run focused test/media proof and commit `storefront/haven: add room-fit furniture recipe`.

---

### Task 11: Glow clinical light

**Files:** Create `app/lib/storefront-recipes/glow/{bundle.ts,bundle.test.ts,assets.ts,video-brief.md,video-proof.json}` and `docs/superpowers/prototypes/storefront-recipes/glow.html`

**Interfaces:** Produces `GLOW_RECIPE_CONFIG`; no shared-file edits. Tests compile it with `compileRecipeConfig`; Task 12 registers it.

- [ ] RED test: nine routes, merchant ingredient/concern facts, skin quiz, routine ordering, accessible before/after control, replenishment plan, and media keys.
- [ ] GREEN implementation: high-key ivory/cobalt/mint clinical system with evidence panels and liquid macro, distinct from Soft Chemistry's quiet editorial softness.
- [ ] Generate and approve formulation, bathroom-context, and liquid-texture videos with stable containers and physically coherent liquid.
- [ ] Run focused test/media proof and commit `storefront/glow: add clinical routine recipe`.

---

### Task 12: Register, integrate, and prove all ten recipes

**Files:**
- Modify: `app/lib/storefront-recipes/index.ts`
- Modify: `app/lib/storefront-bundle/registry.ts`
- Modify: `app/lib/storefront-recipes/{factory.test,interactive-contract.test,route-matrix.test,hero-assets.test,source-parity.test}.ts`
- Modify: `scripts/verify-storefront-bundles.mjs`
- Create: fixed proof fixtures/screenshots for the ten IDs under existing proof conventions

**Interfaces:** Consumes all ten reviewed recipe folders. Produces active registry entries and final integrated proof.

- [ ] **Step 1: Write RED registry and route-matrix assertions**

Assert 21 total registered recipes, exact ten new IDs at version 1, nine surfaces for each new recipe, distinct archetype/signature/font/card identities, complete asset approvals, and unchanged fingerprints for the existing eleven.

- [ ] **Step 2: Register one recipe at a time**

Add its imports, semantic signature, routing terms, version record, assets, override surface, and compiled export; run the focused registry/route tests after each addition.

- [ ] **Step 3: Run representative preview proof and show each recipe**

After each recipe registration, run its Home/PDP desktop/mobile slice with `storefrontProofContext(27)` and create a fresh recipe-backed draft. Verify the saved-draft Store Builder route headlessly, then show the corresponding no-HMR review page once; never open a live-reload tab for the user.

- [ ] **Step 4: Run all deterministic media and bundle proof**

Run `node scripts/verify-storefront-recipe-media.mjs`, the representative slices, and `node scripts/verify-storefront-bundles.mjs`. Expected: every new route/viewport and old regression case passes with no missing asset/copy/binding.

- [ ] **Step 5: Run repository gates**

Run serial `npm test -- --run --maxWorkers=1`, `npm run typecheck`, `npm run lint`, `npm run build`, migration validation, `git diff --check`, and browser-visible source scans. Expected: all exit 0; report skips explicitly.

- [ ] **Step 6: Commit**

Commit: `storefront/recipes: register native CRO catalog`

- [ ] **Step 7: Broad review and release readiness**

Generate a merge-base review package, dispatch the final capable reviewer, fix Critical/Important findings in one wave, re-review, and use the finishing-a-development-branch workflow. Do not push, open a PR, apply the migration, or publish without the user's explicit release request.
