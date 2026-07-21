# Baymard-Depth Storefront Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn nine shallow native recipes into complete merchant-bound commerce experiences across discovery, collection, product, search, cart, and checkout.

**Architecture:** Nine independent Codex Cloud tasks own one recipe bundle, its focused test, and its standalone prototype. One integration pass applies the diffs, adds only cross-recipe contract assertions that cannot live in focused tests, and verifies the existing compiler/runtime path without creating shared visual markup.

**Tech Stack:** TypeScript, Vitest, Calderyn storefront compiler/runtime, declarative `data-cd-*` bindings, static HTML/CSS prototypes, Playwright bundle proof.

## Global Constraints

- Recipe IDs are exactly `volt`, `atelier`, `gilt`, `ember`, `roast`, `fizz`, `forge`, `haven`, and `glow`.
- Production `bundle.ts` files are authoritative; prototype HTML mirrors their visual and merchandising intent.
- Every recipe owns its DOM and CSS. Reuse only existing trusted behavior fragments and protected slots.
- Bind merchant products, collections, variants, prices, availability, imagery, facts, policies, and store identity; never invent commerce claims.
- Do not modify `larder`, the existing eleven recipes, Store Builder routing, dependencies, compiler authority, or payment/cart authority.
- A cloud task modifies only its recipe `bundle.ts`, `bundle.test.ts`, and prototype HTML.
- Use the existing native route and interaction contracts; no arbitrary JavaScript or remote assets.

---

### Tasks 1-9: Deepen one recipe per Cloud task

Run this task once for each recipe ID in the global list.

**Files per task:**

- Modify: `app/lib/storefront-recipes/<recipe>/bundle.ts`
- Modify: `app/lib/storefront-recipes/<recipe>/bundle.test.ts`
- Modify: `docs/superpowers/prototypes/storefront-recipes/<recipe>.html`

**Consumes:** Existing `RecipeConfig`, `RouteSource`, binding scopes, trusted slots, commerce fragments, and declarative interaction attributes.

**Produces:** A distinct full-route recipe whose focused test proves collection discovery, collection controls, merchant-bound product detail, search recovery, cart progression, and prototype parity.

- [ ] **Step 1: Add a failing focused UX contract test**

  Assert the compiled recipe contains: a home link to `collections`; a collections-index surface; collection bindings for `collection.title`, `product.title`, `product.description`, `product.price`, and `product.availability`; `collection.filter` and `collection.sort`; `quickViewCommerce`; product description plus `variantPicker` and `addToCart`; search query/result bindings and empty state; cart line controls and summary; and policy links. Include one recipe-specific assertion so a palette-swapped generic implementation fails.

- [ ] **Step 2: Verify the focused test fails**

  Run `npx vitest run app/lib/storefront-recipes/<recipe>/bundle.test.ts` and confirm the new UX-contract case fails before implementation.

- [ ] **Step 3: Implement the minimum complete route depth**

  Add home collection hooks, a real collections-index composition, collection hierarchy/sibling navigation/result count/filter/sort/applied-state/product-card/quick-view treatment, PDP gallery/facts/reassurance/related discovery, search category recovery, and cart reassurance. Use only data paths and trusted actions already supported by the recipe compiler. Keep the recipe's current fonts, tokens, composition family, and visual signature.

- [ ] **Step 4: Sync the prototype**

  Update the standalone HTML with matching collection-discovery and catalog-depth sections. Keep it browser-safe, self-contained, responsive, and free of remote assets or development provenance.

- [ ] **Step 5: Verify and commit**

  Run `npx vitest run app/lib/storefront-recipes/<recipe>/bundle.test.ts`, `git diff --check`, and `git status --short`. Commit only the three owned files with subject `storefront/<recipe>: deepen catalog discovery`.

### Task 10: Integrate and prove the nine recipes

**Files:**

- Modify only if cross-recipe coverage is missing: `app/lib/storefront-recipes/route-matrix.test.ts`
- Modify only if browser proof requires a deterministic assertion: `scripts/verify-storefront-bundles.mjs`

**Consumes:** Nine independently green recipe diffs.

**Produces:** One conflict-free branch and proof that all nine recipes satisfy the native route/data contract on desktop and mobile.

- [ ] **Step 1: Apply all nine Cloud diffs**

  Apply each task once. Resolve overlap only in focused test snapshots or formatting; do not merge recipe DOM/CSS into shared visual helpers.

- [ ] **Step 2: Add the smallest missing cross-recipe assertion**

  If focused tests do not collectively prove a requirement, add one table-driven assertion over the nine IDs to `route-matrix.test.ts`. Do not duplicate assertions already present.

- [ ] **Step 3: Run focused and dense-catalog proof**

  Run `npx vitest run app/lib/storefront-recipes/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}/bundle.test.ts app/lib/storefront-recipes/route-matrix.test.ts` and `node scripts/verify-storefront-bundles.mjs`. Expected: exit 0 with all tested desktop/mobile route cases green.

- [ ] **Step 4: Run repository gates**

  Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` in order. Expected: every command exits 0.

- [ ] **Step 5: Review, commit, and open PR**

  Run `git diff --stat`, `git diff --check`, provenance-marker scan, and code review. Commit integration-only changes, push `feat/storefront-recipes-baymard-depth`, open a PR to `main`, and report its checks without claiming visual proof that was not performed.
