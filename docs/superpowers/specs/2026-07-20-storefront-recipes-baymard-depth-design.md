# Baymard-Depth Storefront Recipes

**Date:** 2026-07-20
**Owner:** Eric
**Status:** Approved
**Branch:** `feat/storefront-recipes-baymard-depth`

## Decision

Deepen the nine native recipes `volt`, `atelier`, `gilt`, `ember`, `roast`, `fizz`, `forge`, `haven`, and `glow` into complete commerce experiences. The production recipe bundles are authoritative; their standalone HTML prototypes remain visual baselines and must be updated with the same route and merchandising intent.

Each recipe keeps ownership of its DOM, CSS, typography, copy, rhythm, and niche composition. Shared code remains limited to trusted commerce behavior already present in `app/lib/storefront-recipes/library/` and the platform runtime. Do not introduce a shared visual page template.

## Required experience

Every recipe must provide:

- Home: visible collection-discovery hooks, at least one live-product merchandising section, and a clear path into catalog browsing.
- Collections index: distinct collection destinations using merchant-bound collection data when available.
- Collection: breadcrumb or equivalent hierarchy, sibling collection navigation, result count, sort, applicable facets, visible applied-filter state, descriptive product cards, and quick-view commerce.
- Product: gallery, title, description, price, availability, variant selection, add to cart, merchant-backed facts, policy reassurance, and related-product discovery.
- Search: query controls, result count, empty state, descriptive result cards, and a route back into category browsing.
- Cart: editable lines, subtotal, checkout progression, and policy reassurance without invented shipping claims.
- Checkout: recipe-owned decoration around the protected platform checkout contract.

These requirements adapt the public page taxonomy in Baymard's ecommerce design examples: Homepage, Main Navigation, Intermediary Category Page, Search Field, Search Results Page, Product List, Sorting Tool, Filtering Options, Product Page, Cart, Added-to-Cart Confirmation, and Checkout.

## Data and truth boundaries

- Critical catalog content binds the logged-in merchant's live products, collections, variants, prices, availability, imagery, and store identity.
- Never invent reviews, stock pressure, discounts, compatibility, subscriptions, delivery dates, policy claims, or clinical/performance evidence.
- Keep purchase, cart, checkout, tax, shipping, inventory, and payment authority in protected Calderyn slots and services.
- Preserve empty states and dense-catalog behavior. A recipe must remain useful with one product and with at least 27 products.
- Use source-owned media only; do not add remote image or font dependencies.

## Cloud decomposition

Run one Codex Cloud task per recipe. A task may modify only:

- `app/lib/storefront-recipes/<recipe>/bundle.ts`
- `app/lib/storefront-recipes/<recipe>/bundle.test.ts`
- `docs/superpowers/prototypes/storefront-recipes/<recipe>.html`

Shared registry, compiler, renderer, factory, library, and route-matrix files belong to the integration pass. This keeps the nine cloud diffs independently applicable and avoids cross-task merge conflicts.

## Verification

- Each recipe test asserts its collection-discovery hooks and merchant-bound collection/product behavior.
- `app/lib/storefront-recipes/route-matrix.test.ts` continues to prove route/data/interaction coverage for every registered recipe.
- `node scripts/verify-storefront-bundles.mjs` proves desktop and mobile routes against a 27-product fixture.
- Final gates are `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- Final visual review covers desktop and mobile home, collections index, collection, product, search, and cart for all nine recipes.

## Non-goals

- Changing `larder` or any of the existing eleven recipes.
- Adding dependencies, arbitrary recipe JavaScript, a new component system, or a generic page-builder abstraction.
- Copying Baymard screenshots or third-party storefront implementations.
- Opening the recipe identities to merchants or changing Store Builder routing behavior.
