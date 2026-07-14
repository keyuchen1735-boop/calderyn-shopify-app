# Storefront Routing, Recipe Runtime, AI Compiler, and Prompt Editing Implementation Plan

> **Execution rule:** implement each task with a fresh context, test-first. Witness the focused test fail before production code, make it pass, run the listed regression set, commit, then perform specification and code-quality review before advancing.

**Goal:** Replace Store Studio's new-build path with a prompt-first router that installs one of eleven complete merchant-bound storefront recipes or compiles a genuinely original storefront; render home, collection, product, search, cart, and checkout through one trusted bundle runtime; and let subsequent merchant prompts safely edit any recipe or generated draft.

**Architecture of record:** `docs/superpowers/specs/2026-07-13-interactive-storefront-recipes-and-ai-compiler-design.md`. Older StoreGen/Store Studio plans contribute reusable authentication, quota, streaming, catalog, asset, preview, and commerce seams only. `BlockDocument`, `page_document`, the current StoreGen, `templateGenerationBrief()`, and legacy experiments remain runtime-0 compatibility, not the runtime-1 implementation.

**Technology:** Remix/React/TypeScript, Vitest, Supabase/Postgres RPCs, explicit HTML and CSS AST parsers, server-side React rendering, a first-party declarative interaction runtime, Puppeteer/Chromium browser proof, existing Anthropic and owned-asset providers.

## Delivery invariants

- New model output is HTML/CSS plus typed manifests; model-authored JavaScript never executes.
- Preview and public storefront use the same bundle, renderer, data plans, asset resolver, and trusted slots. Only commerce adapters differ.
- Pricing, availability, cart ownership, inventory, shipping, tax, consent, order creation, and payment remain server-authoritative.
- A validated bundle is immutable. Draft install, edit, publish, rollback, and undo are shop-scoped compare-and-swap operations.
- A failed build/edit leaves the current draft and published store untouched.
- Recipe and custom output implement shell plus home, collection, product, search, cart, and checkout artifacts.
- No recipe ships with prototype hotlinks, remote fonts, inline handlers, or copied third-party assets.
- Legacy experiments block runtime-1 build/publish. Runtime-1 routes never read a legacy challenger.
- Independent kill switches are `STOREFRONT_BUNDLE_READ`, `STOREFRONT_RECIPE_BUILD`, `STOREFRONT_BUNDLE_PUBLISH`, and `STOREFRONT_CUSTOM_BUILD`.

## Superseded behavior

- Do not widen `BlockDocument` into the bundle format.
- Do not route recipes through `templateGenerationBrief()` or custom builds through `generateStore()`.
- Do not mutate `store_settings` for bundle palette/tagline/font edits.
- Do not use regex marker splicing, the raw-home sanitizer, or `app/lib/storebuilder/fx/*` as the runtime-1 security boundary.
- Do not install generic fallback routes into a partially failed candidate.

## Baseline and branch gate

Already established after rebasing onto `origin/main` (`35344a39`):

```text
npm test       -> 737 files passed, 6 skipped; 6,152 tests passed, 12 skipped
npm typecheck  -> passed
git status     -> clean
```

Repeat `npm test` and `npm run typecheck` after every phase. Run lint/build/client-bundle and browser gates before enabling flags or merging.

---

## Task 1: Freeze runtime-1 contracts, recipe metadata, and prompt router

**Create**

- `app/lib/storefront-bundle/types.ts`
- `app/lib/storefront-bundle/registry.ts`
- `app/lib/storefront-bundle/routing.ts`
- `app/lib/storefront-bundle/routing-evidence.server.ts`
- `app/lib/storefront-bundle/__fixtures__/routing-corpus.ts`
- `app/lib/storefront-bundle/registry.test.ts`
- `app/lib/storefront-bundle/routing.test.ts`
- `app/lib/storefront-bundle/routing-evidence.server.test.ts`
- `app/routes/dashboard.api.store.resolve.tsx`
- `app/routes/__tests__/dashboard.api.store.resolve.test.ts`

**Modify**

- `app/lib/storebuilder/templates.ts` only to expose a deprecated compatibility adapter; move authoritative metadata to the new registry.
- `app/routes.ts` only if the route manifest does not pick up the resolver route automatically.

**RED**

Write the full fixture corpus from spec section 4.4 plus tests for invalid request combinations, Unicode normalization, apostrophes/hyphens, phrase overlap, name negation, ambiguous names, catalog caps, stable fingerprints, score/margin thresholds, empty-prompt catalog inference, and registry duplicate rejection. Assert the resolver endpoint returns the pure resolver result from server-built evidence and never accepts browser-supplied evidence.

Run:

```bash
npx vitest run app/lib/storefront-bundle/routing.test.ts app/lib/storefront-bundle/registry.test.ts app/lib/storefront-bundle/routing-evidence.server.test.ts app/routes/__tests__/dashboard.api.store.resolve.test.ts
```

Expected RED: modules/routes do not exist.

**GREEN**

- Implement the versioned request/evidence/resolution/bundle contracts exactly as specified.
- Register all eleven IDs, including stable Atelier ID `atelier-nine`, aliases, niche signals, active version, route capabilities, and declared recipe override surface.
- Implement the deterministic allowlisted grammar and niche scorer as pure functions.
- Build evidence server-side from bounded active public catalog fields; hash normalized values plus routing/registry versions.
- Authenticate and rate-limit the recommendation endpoint; return `422 invalid_design_request` for invalid combinations.

**Commit:** `feat(storefront): add versioned recipe router`

---

## Task 2: Add immutable release, asset, audit, and CAS persistence

**Create**

- `supabase/migrations/20260713140000_storefront_bundle_releases.sql`
- `supabase/migrations/20260713141000_storefront_bundle_assets.sql`
- `supabase/migrations/20260713142000_storefront_bundle_functions.sql`
- `app/lib/storefront-bundle/release.server.ts`
- `app/lib/storefront-bundle/assets.server.ts`
- `app/lib/storefront-bundle/legacy.server.ts`
- `app/lib/storefront-bundle/edit-audit.server.ts`
- `app/lib/storefront-bundle/release.server.test.ts`
- `app/lib/storefront-bundle/assets.server.test.ts`
- `app/lib/storefront-bundle/legacy.server.test.ts`
- `app/lib/storefront-bundle/migrations.test.ts`

**RED**

Add static migration-contract tests and mocked repository tests for:

- same-shop composite foreign keys and revoked anon/authenticated grants;
- source/status/runtime/profile checks and immutable validated rows;
- `install_storefront_draft`, `edit_storefront_draft`, `publish_storefront_release`, and `rollback_storefront_release` RPCs;
- zero-row/stale expected pointer conflicts;
- asset verified/locked/deleting/deleted transitions and generation-safe GC;
- one-time immutable runtime-0 legacy capture;
- edit audit containing base/result hashes, prompt, scope, patch, provider and validation metadata;
- running-experiment rejection before all runtime-1 writes.

Expected RED: migrations and repositories do not exist.

**GREEN**

- Add `storefront_bundle_version`, `storefront_release`, `storefront_release_history`, `storefront_asset_object`, `storefront_bundle_asset`, and `storefront_bundle_edit` with RLS/service-role posture.
- Implement transaction RPCs with row locks, same-shop validation, renderer/profile support checks, asset-manifest equality, expected-pointer CAS, and history append.
- Make `edit_storefront_draft` record `edit_draft` and the audit row in the same transaction.
- Reuse existing legacy document/settings serializers to capture an exact runtime-0 snapshot.
- Reuse owned-asset fetch/sniff/cap primitives, but introduce immutable content-addressed bundle keys and durable verification.

Run the focused suite, then existing page-document/experiment tests.

**Commit:** `feat(storefront): add immutable bundle releases`

---

## Task 3: Build the deterministic HTML/CSS compiler and bundle validator

**Modify**

- `package.json`
- `package-lock.json`

**Create**

- `app/lib/storefront-compiler/html.ts`
- `app/lib/storefront-compiler/css.ts`
- `app/lib/storefront-compiler/bindings.ts`
- `app/lib/storefront-compiler/interactions.ts`
- `app/lib/storefront-compiler/checkout.ts`
- `app/lib/storefront-compiler/validate.ts`
- `app/lib/storefront-compiler/compile.ts`
- matching `*.test.ts` files and malicious fixtures under `app/lib/storefront-compiler/__fixtures__/`

**RED**

Install no dependency until tests demonstrate missing behavior. Add tests for tag/attribute allowlists, no document/head/script/form/iframe/worker/event-handler output, local IDs, repeat scopes, public bindings, route targets, trusted slots, source-attribute stripping, scoped selectors, keyframe/ID namespaces, URL/import/font-face rejection, protected host selectors, duplicate IDs, unresolved bindings, checkout restrictions, and validation-profile-v1 byte/count/state/action limits.

Expected RED: compiler modules do not exist.

**GREEN**

- Add explicit maintained HTML/CSS AST dependencies; never depend on a transitive parser or regex sanitization.
- Parse source into a serializable compiled node tree; insert catalog values later as escaped React text/validated attributes.
- Compile a closed data-plan vocabulary and typed interaction manifest with compiler-issued local IDs.
- Scope CSS under a bundle root, namespace identifiers/keyframes, reject escaping selectors and all external network-capable constructs.
- Compile checkout only into decorative nodes plus an allowlisted layout manifest for trusted sibling-root islands.
- Return deterministic diagnostics and content hashes.

**Commit:** `feat(storefront): add trusted bundle compiler`

---

## Task 4: Add live presentation data plans and the server renderer

**Create**

- `app/lib/storefront-runtime/public-data.server.ts`
- `app/lib/storefront-runtime/render.server.tsx`
- `app/lib/storefront-runtime/trusted-slots.tsx`
- `app/lib/storefront-runtime/checkout-islands.tsx`
- `app/lib/storefront-runtime/release-resolution.server.ts`
- `app/lib/storefront-runtime/cache.server.ts`
- `app/lib/storefront-runtime/csp.server.ts`
- matching tests.

**Modify**

- `app/lib/storefront/catalog.ts`
- `app/lib/storefront/catalog.server.ts`
- `app/lib/storefront/catalog.owned.server.ts`
- `app/entry.server.tsx`

**RED**

Test closed/capped `requiredData` plans, shop-first reads, missing-record empty states, fresh signed media resolution, live vs pinned field ownership, text escaping, platform 404s, runtime-0 snapshot selection, runtime-1 selection behind the read flag, public cache keys, private `no-store`, CSP directives, and unsupported runtime fallback to compatible retained history.

**GREEN**

- Add presentation DTOs for store identity, collections, structured options, safe availability labels, product/related lists, search results and cart.
- Render compiled nodes recursively through React SSR; never render whole route source through `dangerouslySetInnerHTML`.
- Mount trusted commerce slots in closed Shadow DOM where feasible and checkout islands in a platform-owned sibling root.
- Keep runtime-0 rendering unchanged and select runtime-1 only when the flag and compatible release allow it.
- Harden storefront-specific CSP without breaking Remix or Stripe checkout.

**Commit:** `feat(storefront): render immutable storefront bundles`

---

## Task 5: Add the trusted interaction runtime

**Create**

- `app/lib/storefront-runtime/state.ts`
- `app/lib/storefront-runtime/actions.ts`
- `app/lib/storefront-runtime/overlays.ts`
- `app/lib/storefront-runtime/hydrate.ts`
- `app/lib/storefront-runtime/index.client.ts`
- matching reducer, validation, and DOM tests.

**RED**

Test bounded state initialization and transitions; open/close/toggle; tabs; gallery; carousel; search/filter/sort intent; variant selection; cart bridge dispatch; compiler-issued target enforcement; focus trap/restore; Escape; inert/background behavior; portal cleanup; scroll progress clamp; reduced motion; unsupported capabilities; idempotent hydrate/teardown; and zero arbitrary fetch/eval/import paths.

**GREEN**

- Hydrate only compiler-validated manifests.
- Use one platform overlay portal while accepting validated recipe presentation nodes/styles.
- Dispatch commerce/search only through injected trusted adapters.
- Preserve a usable SSR fallback when hydration fails.

**Commit:** `feat(storefront): add declarative interaction runtime`

---

## Task 6: Add authoritative cart, search, and facet APIs

**Create**

- `app/routes/storefront.api.cart.tsx`
- `app/routes/storefront.api.cart.add.tsx`
- `app/routes/storefront.api.cart.quantity.tsx`
- `app/routes/storefront.api.cart.remove.tsx`
- `app/routes/storefront.api.cart.clear.tsx`
- `app/routes/storefront.api.search.tsx`
- `app/lib/storefront/search.server.ts`
- route and service tests.

**Modify**

- `app/lib/order/cart.server.ts`
- `app/lib/storefront/cart-cookie.server.ts`

**RED**

Test signed cart ownership, shop resolution before reads, same-origin/CSRF policy, rate limits, request schemas, quantity bounds, live availability checks, add-time price snapshots, structured errors, `no-store`, query/filter/sort/cursor validation, result caps, facets, and cross-shop rejection.

**GREEN**

- Add an authoritative quantity-set operation to the existing cart service.
- Wrap existing cart operations in same-origin JSON routes with one shared response contract.
- Add server-backed bounded search/facet queries; never ship the whole catalog to the browser.

**Commit:** `feat(storefront): add trusted cart and search bridges`

---

## Task 7: Route the full public and preview surface through runtime-1

**Create**

- `app/routes/storefront.search.tsx`
- `app/lib/storefront-runtime/preview-commerce.server.ts`

**Modify**

- `app/routes/storefront.tsx`
- `app/routes/storefront._index.tsx`
- `app/routes/storefront.collections.$handle.tsx`
- `app/routes/storefront.products.$handle.tsx`
- `app/routes/storefront.cart.tsx`
- `app/routes/storefront.checkout.tsx`
- `app/routes/dashboard.store.preview.tsx`
- corresponding route tests.

**RED**

For every surface, assert runtime-0 remains unchanged without a runtime-1 release and runtime-1 resolves shell/artifact/data/slots from one bundle. Add preview tests for all routes, navigation, simulated cart persistence, simulated checkout, no buyer cart cookie writes, no order/inventory/payment calls, identical compiled markup keys, and private cache headers.

**GREEN**

- Preserve existing loaders/actions and authoritative checkout services under bundle-designed presentation.
- Make public and preview call the same route renderer; inject real vs preview commerce adapters.
- Bypass legacy experiment selection/exposure for bundle releases.
- Keep account/recovery/invoice routes platform-owned and safely linked from generated shell bindings.

**Commit:** `feat(storefront): route complete stores through bundle runtime`

---

## Task 8: Convert and validate all eleven recipes

**Create**

- `app/lib/storefront-recipes/<recipe-id>/bundle.ts` for each of the eleven IDs.
- `app/lib/storefront-recipes/<recipe-id>/assets.ts` and owned assets under `public/storefront-recipes/<recipe-id>/`.
- `app/lib/storefront-recipes/index.ts`
- per-recipe contract tests plus a registry-wide route-matrix test.

**Sources**

- `docs/superpowers/prototypes/storefront-recipes/*.html`
- `public/atelier-grid/index.html`

**RED per recipe**

Before converting each recipe, add tests asserting exact signature, unique layout/scroll/icon/font/interaction tokens, shell plus six routes, required commerce slots, merchant data bindings, empty/sold-out/long-copy states, owned assets, and validation-profile-v1 compliance. Witness failure for the missing recipe artifact.

**GREEN per recipe**

- Preserve the approved visual direction while replacing prototype data/handlers/hotlinks with compiler source, trusted interactions, closed query plans, self-hosted fonts, validated icons, and original/merchant-owned media.
- Make collection/product/cart/checkout unmistakably transactional ecommerce surfaces.
- Activate the registry version only after focused tests and browser screenshots pass.
- Commit each recipe separately; Atelier first, then the ten niche recipes.

**Commit pattern:** `feat(recipes): add <recipe name> storefront bundle`

---

## Task 9: Cut Store Studio into routing, recipe build, and atomic publish

**Modify**

- `app/lib/storebuilder/studio-types.ts`
- `app/lib/storebuilder/studio.server.ts`
- `app/lib/dashboard/store-client.ts`
- `app/components/dashboard/store/WelcomeOverlay.tsx`
- `app/components/dashboard/screens/Store.tsx`
- `app/routes/dashboard.api.store.tsx`
- `app/routes/dashboard.api.store.generate.tsx`
- related component/route/client tests.

**Create**

- `app/lib/storefront-bundle/build.server.ts`
- `app/lib/storefront-bundle/build.server.test.ts`

**RED**

Test recommendation/build resolver parity, explicit selection persistence, first NDJSON event frozen resolution, changed-catalog explanation, recipe instantiation without any AI layout call, experiment refusal, atomic draft install, explicit atomic publish, honest failure, and disabled-flag behavior. Assert Store Studio does not call `templateGenerationBrief()` or `generateStore()` for runtime-1 requests.

**GREEN**

- Send `StoreDesignRequest` from welcome/chat.
- Stream `routing`, `applying_recipe`, `compiling`, `validating`, `proofing`, and `installed` stages.
- Bind the chosen recipe to the current merchant and install one validated immutable draft.
- Replace per-page publish with bundle publish when a runtime-1 draft is active; retain the legacy action for runtime-0.

**Commit:** `feat(store): route prompts into complete recipe bundles`

---

## Task 10: Implement the new AI Storefront Compiler

**Create**

- `app/lib/storefront-ai/contracts.ts`
- `app/lib/storefront-ai/context.server.ts`
- `app/lib/storefront-ai/prompts.ts`
- `app/lib/storefront-ai/provider.server.ts`
- `app/lib/storefront-ai/concepts.server.ts`
- `app/lib/storefront-ai/judge.server.ts`
- `app/lib/storefront-ai/expand.server.ts`
- `app/lib/storefront-ai/assets.server.ts`
- `app/lib/storefront-ai/proof.server.ts`
- `app/lib/storefront-ai/generate.server.ts`
- matching tests and deterministic fixtures.

**RED**

Test safe context assembly, three structurally distinct concepts, schema-only model output, compiler rejection, one schema repair, novelty scoring, real-data render/judge, winner route expansion, targeted browser repair, budget/cancel checkpoints, owned asset references, audit completeness, atomic install, and all-fail/no-change behavior. Assert no call path invokes legacy `generateStore()`.

**GREEN**

- Use existing authenticated quota/rate-limit seams and model provider, but new prompts/contracts.
- Generate only compiler-source HTML/CSS/manifests.
- Compile every candidate before judging; expand only the winning design system to all routes.
- Reuse the strict bundle asset pipeline and browser proof.
- Enable behind `STOREFRONT_CUSTOM_BUILD`; the kill switch returns an honest disabled response, never a legacy fallback.

**Commit:** `feat(storefront): add original AI storefront compiler`

---

## Task 11: Implement prompt-directed edits and atomic undo

**Create**

- `app/lib/storefront-edit/types.ts`
- `app/lib/storefront-edit/intent.ts`
- `app/lib/storefront-edit/deterministic.ts`
- `app/lib/storefront-edit/prompts.ts`
- `app/lib/storefront-edit/patch.server.ts`
- `app/lib/storefront-edit/edit.server.ts`
- matching tests.

**Modify**

- `app/lib/dashboard/store-client.ts`
- `app/components/dashboard/screens/Store.tsx`
- `app/routes/dashboard.api.store.tsx`
- `app/routes/dashboard.api.store.generate.tsx`
- `app/routes/dashboard.store.preview.tsx`

**RED**

Test:

- deterministic palette/font/text/visibility/reorder intents without a model call;
- route/region context from compiler-issued preview IDs;
- typed patch operation and precondition validation;
- stale base `409 storefront_edit_conflict`;
- recipe override persistence without detachment;
- structural recipe edit detaches to custom-derived provenance and preserves untouched routes;
- targeted custom edits never regenerate the whole store;
- explicit “start over” re-enters the new-build router;
- failed validation leaves draft untouched;
- completion reports changed scope/detachment;
- undo CAS-installs the recorded base version;
- edit audit is replayable and contains no private catalog/customer data.

**GREEN**

- Route composer prompts to edit when a runtime-1 draft exists unless the parser identifies an explicit new-build intent.
- Apply deterministic operations in memory; use the AI patch compiler only for structural/art-direction changes.
- Compile and validate the complete result, then atomically install a new immutable version.
- Reload preview only after installation and expose one-click atomic undo.

**Commit:** `feat(store): edit storefront bundles by prompt`

---

## Task 12: Add browser proof, observability, rollout, and production cutover

**Create**

- `scripts/verify-storefront-bundles.mjs`
- `app/lib/storefront-validation/browser.server.ts`
- `app/lib/storefront-validation/report.ts`
- browser fixtures/tests and screenshot manifest.

**Modify**

- environment/flag parsing and deployment documentation used by the repo.
- Store generation audit UI/types to surface resolution, compiler/browser diagnostics, route changes, spend, artifact hash, and rollback target.

**RED**

Add a matrix test for eleven recipes and representative custom/edit fixtures across `390x844`, `768x1024`, and `1440x1000`: routes, keyboard, focus, reduced motion, axe, console, unexpected requests, assets, CSP, protected hit testing, long copy, empty/sold-out/sale states, preview/public parity, visual budgets, DOM/CSS/interaction budgets, and checkout simulation/real-boundary assertions.

**GREEN**

- Extract the existing Chromium launch seam and run browser proof in generation and CI.
- Emit structured generation/edit/release telemetry and alertable failures.
- Deploy schema/functions inertly; then code with all runtime-1 flags disabled.
- Enable bundle reads for internal shops, recipe build, publish, then custom build in that order; never collapse the kill switches.
- Cut Store Studio's new-build UI fully away from legacy StoreGen after runtime-1 gates pass.

**Final verification**

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:client-bundle
node scripts/verify-storefront-bundles.mjs
git diff --check
git status --short
```

Additionally verify Supabase migrations/functions in the repo's database test environment, then smoke-test one recipe build/publish/rollback, one explicit custom build, one recipe override edit, one recipe-detaching structural edit, one custom targeted edit, cart/search, and checkout in preview and a production-equivalent tenant.

**Commit:** `feat(storefront): complete bundle rollout and verification`

---

## Production completion state

The branch is complete only when all eleven recipes and custom generation are available through the prompt-first router; every output has the full route/commerce matrix; prompt edits create validated immutable versions with working undo; preview/public parity and browser gates pass; flags have been enabled through the documented order; the branch is reviewed, merged to `main`, deployed, and the production smoke tests pass. External deployment or required-check failures must be reported with exact evidence and must not be described as code completion.
