# Storefront Recipe Taste Hardening

**Date:** 2026-07-21
**Owner:** Eric
**Status:** Approved
**Branch:** `feat/storefront-recipes-baymard-depth`
**Extends:** `2026-07-20-storefront-recipes-baymard-depth-design.md`

## Decision

Apply a targeted Taste Skill redesign pass to `volt`, `atelier`, `gilt`, `ember`, `roast`, `fizz`, `forge`, `haven`, and `glow` without replacing their native Calderyn recipe architecture or distinct visual identities.

The existing recipe bundles remain authoritative. Production storefronts continue to bind the logged-in merchant's live catalog, collections, variants, prices, availability, imagery, facts, policies, and store identity. Public review links use template-appropriate demonstration data so reviewers can assess each niche without apparel products contradicting jewelry, coffee, furniture, skincare, tools, audio, or food copy.

## Scope

### Shared commerce and review contracts

- Add a bounded collection-discovery data surface so collection-index links can target real merchant collections rather than several labels resolving to one route.
- Keep home, collections, collection, product, search, story, cart, checkout, account, and policy navigation on the existing storefront runtime.
- Preserve protected trusted slots for variants, add-to-cart, bundle building, cart lines, cart totals, and checkout. Recipe markup never owns payment, inventory, pricing, tax, shipping, or cart authority.
- Give public recipe reviews template-specific, source-owned demo catalog records. These records are review-only and must never replace authenticated merchant data.
- Make review-mode account and policy destinations useful and non-mutating instead of rendering dead `#` links. Public production routes retain the platform account and policy implementations.

### Per-recipe Taste pass

Each recipe keeps its current typography intent, image direction, copy register, layout family, interactions, classes, and signature composition. Changes are limited to verified Taste or conversion defects:

- Keep the desktop hero headline within two lines and its CTA visible in the initial viewport.
- Remove decorative section numbering, channel/version labels, scroll cues, and dot-separated proof strips where they do not carry real meaning.
- Use one page-level theme, one accent system, and one documented radius system per recipe.
- Correct CTA contrast, desktop wrapping, active feedback, focus visibility, and reduced-motion behavior.
- Remove repeated generic three-column layouts or unused grid cells when the content count does not support them.
- Keep niche claims conditional on merchant-supplied catalog evidence. If required metadata is absent, use truthful neutral commerce copy instead of inventing product properties.
- Preserve intentional brand exceptions only when the existing recipe identity justifies them. Atelier may retain oxblood; Gilt may retain gold; Haven must replace Fraunces and its generic beige-brown premium palette unless an owned brand brief explicitly requires them.

## Route experience

- **Home:** niche-specific hero, real collection entry points, merchant-bound products, and one primary browsing action.
- **Collections:** merchant collection destinations with distinct handles and truthful counts or a neutral all-products fallback when no collections exist.
- **Collection:** hierarchy, sibling discovery, applicable filters, persistent sort state, results, quick commerce, and conditional empty state.
- **Product:** merchant media and facts, variants, protected add-to-cart, policies, and related-product recovery.
- **Search:** working query, clear, persistent result state, empty recovery, and category discovery.
- **Story:** recipe-specific supporting narrative grounded in merchant facts and policies.
- **Cart:** editable trusted lines, totals, checkout, policies, and a continue-shopping path when empty.
- **Checkout:** recipe-owned decoration around the protected platform checkout.
- **Account and policies:** platform-owned production pages plus safe review-mode representations.

No separate FAQ route is added. Story, account, and merchant policy pages are the supporting-page scope for this pass.

## Data and safety boundaries

- Review fixtures are selected only when the unauthenticated recipe-review gate is active.
- Authenticated Store Builder previews and published storefronts always read the tenant's real catalog.
- Collection handles, product handles, prices, availability, facts, variants, and policies come from bounded platform data.
- No invented reviews, ratings, urgency, discounts, delivery dates, medical claims, compatibility, subscriptions, or guarantees.
- Assets remain source-owned and hash-verified. No remote fonts, images, scripts, or new dependency are introduced.

## Verification

- Focused tests for every recipe assert its preserved signature plus Taste-specific hero, label, palette, CTA, and route requirements.
- Shared contract tests prove collection-index destinations bind distinct available collection handles and fall back safely when none exist.
- Review-route tests prove template fixtures cannot leak into authenticated previews or published storefronts.
- Browser proof covers all nine recipes at desktop, tablet, and mobile for home, collections, collection, product, search, story, cart, checkout, account, and policies.
- Interaction proof covers filter and sort persistence, search and clear, variant selection, add-to-cart, bundle building where declared, cart quantity/removal, and checkout progression.
- Dense-catalog proof uses 27 products; sparse proof uses one product; empty proof verifies conditional recovery states.
- Refresh route screenshots and template preview images only after the functional and Taste checks pass.
- Run focused Vitest, the storefront bundle verifier, full tests, typecheck, lint, build, patch sanity, and browser-visible provenance scans before updating PR #619.

## Non-goals

- A shared visual template or palette-swap shell.
- Redesigning `larder` or the existing eleven recipes.
- New arbitrary recipe JavaScript, libraries, page builders, or payment behavior.
- New FAQ, editorial CMS, customer account, policy-management, or checkout features.
- Replacing live merchant data with review fixtures outside the public review gate.
