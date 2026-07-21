# Storefront Recipe Taste Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Volt, Atelier, Gilt, Ember, Roast, Fizz, Forge, Haven, and Glow truthful, Taste-compliant, fully routed native storefront recipes.

**Architecture:** Extend the existing compiler and public-data contract with a bounded `featured.collections` repeat, then keep all visual work inside each recipe bundle. Public review mode receives niche-correct fixture copy while authenticated previews and published storefronts keep tenant-owned data.

**Tech Stack:** TypeScript, Remix, Vitest, Calderyn storefront compiler/runtime, declarative HTML/CSS, Playwright browser proof.

## Global Constraints

- Work only on `feat/storefront-recipes-baymard-depth` in its existing isolated worktree.
- No new dependency, arbitrary JavaScript, shared visual template, remote asset, or commerce authority.
- Production and authenticated preview data always remain tenant-owned.
- Write each behavior test first, run it red, implement the minimum, and rerun green.
- Keep every recipe's DOM/classes, visual identity, typography intent, and niche-specific interaction family.

---

### Task 1: Bind real collection discovery

**Files:**
- Modify: `app/lib/storefront-bundle/types.ts`
- Modify: `app/lib/storefront-compiler/bindings.ts`
- Modify: `app/lib/storefront-compiler/compile.ts`
- Modify: `app/lib/storefront-compiler/validate.ts`
- Modify: `app/lib/storefront-runtime/public-data.server.ts`
- Modify: `app/lib/storefront-runtime/render.tsx`
- Test: `app/lib/storefront-compiler/bindings.test.ts`
- Test: `app/lib/storefront-runtime/public-data.server.test.ts`
- Test: `app/lib/storefront-runtime/render.server.test.tsx`

**Interfaces:**
- Consumes: `StorefrontCatalog.listCollections(shopId)`.
- Produces: `DataRequirement { kind: "featuredCollections"; limit: 12 }`, repeat source `featured.collections`, `PublicPresentationData.featuredCollections`, and collection-scoped bindings/routes.

- [ ] **Step 1: Write the failing compiler test**

```ts
const result = compileHtml(
  `<section data-cd-repeat="featured.collections"><a data-cd-key="collection.id" data-cd-route="collection" data-cd-param-handle="collection.handle"><span data-cd-text="collection.title"></span></a></section>`,
  { routeId: "collections" },
);
expect(result.repeats[0]).toMatchObject({ source: "featured.collections", itemKind: "collection" });
```

- [ ] **Step 2: Run red**

Run: `npx vitest run app/lib/storefront-compiler/bindings.test.ts`
Expected: FAIL because `featured.collections` is unsupported.

- [ ] **Step 3: Add the minimum contract**

```ts
export type DataRequirement =
  | { kind: "storeIdentity" | "policyLinks" | "currentProduct" | "currentCollection" | "cart" }
  | { kind: "featuredProducts" | "featuredCollections"; limit: number; collectionHandle?: string }
  | { kind: "relatedProducts" | "searchResults"; limit: number };

export type CompiledRepeatSource =
  | "collection.products" | "featured.products" | "featured.collections"
  | "related.products" | "search.results" | "cart.lines"
  | "product.images" | "product.variants" | "product.facts";
```

Add `featured.collections` as collection-scoped with key `collection.id`; compile and validate it into `{ kind: "featuredCollections", limit: 12 }`.

- [ ] **Step 4: Write and run the failing public-data test**

```ts
expect((await resolvePublicData(
  { shopId: "shop-1", route: { kind: "collections" }, requiredData: [{ kind: "featuredCollections", limit: 12 }] },
  { catalog, settingsLoader },
)).featuredCollections).toEqual([
  { id: "audio", handle: "audio", title: "Audio", description: "", image: null, productCount: 0 },
]);
```

Run: `npx vitest run app/lib/storefront-runtime/public-data.server.test.ts`
Expected: FAIL because the field is absent.

- [ ] **Step 5: Load bounded collections and render their routes**

Add `featuredCollections` to `baseData`, cap it at 12, map missing optional fields to neutral values, and return it from `repeatValues`. Reuse existing collection binding paths and `targetHref` so the repeated handle becomes `/storefront/collections/<handle>` or the equivalent preview query.

- [ ] **Step 6: Run green and commit**

Run: `npx vitest run app/lib/storefront-compiler/bindings.test.ts app/lib/storefront-runtime/public-data.server.test.ts app/lib/storefront-runtime/render.server.test.tsx`
Expected: PASS.

Commit: `storefront/runtime: bind collection discovery`

### Task 2: Make public review data niche-correct and links useful

**Files:**
- Create: `app/lib/storefront-recipes/review-catalog.server.ts`
- Create: `app/lib/storefront-recipes/review-catalog.server.test.ts`
- Modify: `app/routes/dashboard.store.preview.tsx`
- Modify: `app/lib/storefront-runtime/render.tsx`
- Test: `app/routes/__tests__/dashboard.store.preview.test.tsx`

**Interfaces:**
- Consumes: `StoreTemplateId`, the existing fixture catalog behavior, and each recipe's hero placeholder.
- Produces: `getStorefrontRecipeReviewCatalog(templateId): StorefrontCatalog` and review-only account/policy navigation.

- [ ] **Step 1: Write a failing isolation test**

```ts
expect((await getStorefrontRecipeReviewCatalog("gilt").listProducts("demo-shop"))[0].title)
  .toBe("Signet Pendant");
expect((await getStorefrontRecipeReviewCatalog("roast").listProducts("demo-shop"))[0].title)
  .toBe("Kayon Mountain Filter Roast");
expect(getPreviewCatalog()).not.toBe(getStorefrontRecipeReviewCatalog("gilt"));
```

Run: `npx vitest run app/lib/storefront-recipes/review-catalog.server.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement one small fixture factory**

Define four truthful products and two collections per template. Use these product families: Volt audio components; Atelier apparel; Gilt jewelry; Ember sauces; Roast coffee; Fizz drinks; Forge tools; Haven furniture; Glow skincare. Give every product one available variant, neutral prices, no invented reviews/urgency/clinical claims, and no remote image URL so the existing source-owned recipe placeholder renders.

- [ ] **Step 3: Gate fixtures to unauthenticated recipe review**

```ts
const catalog = reviewTemplateId
  ? getStorefrontRecipeReviewCatalog(reviewTemplateId)
  : getPreviewCatalog();
```

Pass this catalog only in the `reviewTemplateId` branch. Authenticated previews continue using `getPreviewCatalog()`.

- [ ] **Step 4: Replace preview `#` destinations**

In preview mode, route account targets to `/storefront/account` and policy targets to `/storefront/policies/<id>`. Seed review data with the four allowlisted policy IDs and neutral titles; policy contents remain platform-owned.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run app/lib/storefront-recipes/review-catalog.server.test.ts app/routes/__tests__/dashboard.store.preview.test.tsx app/lib/storefront-runtime/render.server.test.tsx`
Expected: PASS.

Commit: `storefront/review: use niche-correct catalog data`

### Task 3: Taste-harden the nine recipes

**Files:**
- Modify: `app/lib/storefront-recipes/{volt,atelier,gilt}/bundle.ts`
- Modify: `app/lib/storefront-recipes/{volt,atelier,gilt}/bundle.test.ts`
- Modify: `docs/superpowers/prototypes/storefront-recipes/{volt,atelier,gilt}.html`
- Modify: `app/lib/storefront-recipes/{ember,roast,fizz}/bundle.ts`
- Modify: `app/lib/storefront-recipes/{ember,roast,fizz}/bundle.test.ts`
- Modify: `docs/superpowers/prototypes/storefront-recipes/{ember,roast,fizz}.html`
- Modify: `app/lib/storefront-recipes/{forge,haven,glow}/bundle.ts`
- Modify: `app/lib/storefront-recipes/{forge,haven,glow}/bundle.test.ts`
- Modify: `docs/superpowers/prototypes/storefront-recipes/{forge,haven,glow}.html`

**Interfaces:**
- Consumes: `featured.collections`, existing trusted slots, and the recipe's current asset manifest.
- Produces: a distinct Taste-compliant route set with no shared visual markup.

- [ ] **Step 1: Add failing per-recipe assertions**

For each recipe, assert: collections HTML repeats `featured.collections`; home and story visible copy contain no section-number labels or em/en dashes; primary desktop hero CSS stays at or below `clamp(...,6rem)` unless its tested copy is at most five words; product retains `variantPicker` and `addToCart`; cart contains a `collection` or `collections` recovery route; and the recipe-specific signature remains.

- [ ] **Step 2: Run each focused test red**

Run:
- `npx vitest run app/lib/storefront-recipes/volt/bundle.test.ts app/lib/storefront-recipes/atelier/bundle.test.ts app/lib/storefront-recipes/gilt/bundle.test.ts`
- `npx vitest run app/lib/storefront-recipes/ember/bundle.test.ts app/lib/storefront-recipes/roast/bundle.test.ts app/lib/storefront-recipes/fizz/bundle.test.ts`
- `npx vitest run app/lib/storefront-recipes/forge/bundle.test.ts app/lib/storefront-recipes/haven/bundle.test.ts app/lib/storefront-recipes/glow/bundle.test.ts`
Expected: FAIL on the new Taste/collection assertions.

- [ ] **Step 3: Apply the minimum visual and route edits**

Remove decorative numbering and proof strips, shorten or rescale heroes to two lines, make collection cards use repeated merchant collections, preserve product/card routes and trusted slots, add empty-cart recovery, correct CTA contrast/wrapping, keep a single accent/radius/theme rule, and retain explicit mobile/reduced-motion CSS.

- [ ] **Step 4: Sync the standalone prototype and run green**

Run the same three focused group commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit each independent recipe group**

Commits:
- `storefront/recipes: Taste-harden volt atelier gilt`
- `storefront/recipes: Taste-harden ember roast fizz`
- `storefront/recipes: Taste-harden forge haven glow`

### Task 4: Integrate and prove the full story

**Files:**
- Modify: `app/lib/storefront-recipes/route-matrix.test.ts`
- Modify: `app/lib/storefront-recipes/source-parity.test.ts`
- Modify: `app/lib/storefront-validation/screenshot-manifest.json`
- Refresh: `public/storefront-recipes/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}/baselines/*.webp`
- Refresh: `public/template-previews/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}.webp`

- [ ] **Step 1: Add one matrix assertion**

Assert every one of the nine recipes has `featuredCollections` on its collections route, retains protected purchase/cart slots, exposes story plus policies, and has no forbidden Taste copy markers.

- [ ] **Step 2: Run focused and browser proof**

Run: `npx vitest run app/lib/storefront-recipes/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}/bundle.test.ts app/lib/storefront-recipes/route-matrix.test.ts app/lib/storefront-recipes/source-parity.test.ts`

Run: `node scripts/verify-storefront-bundles.mjs`

Expected: all nine desktop/tablet/mobile routes and interactions pass with sparse, empty, and 27-product contexts.

- [ ] **Step 3: Refresh screenshots only from green bundles**

Run: `node scripts/verify-storefront-bundles.mjs --capture-new-baselines`

Then run: `node scripts/verify-storefront-bundles.mjs`

- [ ] **Step 4: Run repository gates**

Run in order: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`.
Expected: exit 0; lint may report only the 13 documented pre-existing warnings and none in touched files.

- [ ] **Step 5: Review, commit, push, and verify PR #619**

Run patch/provenance review, commit integration artifacts, push the branch, wait for Vercel Ready, and repeat the nine share-link shopper journeys before reporting completion.
