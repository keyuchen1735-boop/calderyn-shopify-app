# Interactive Storefront Recipes and AI Storefront Compiler

**Date:** 2026-07-13
**Owner:** Eric
**Status:** Approved design, pre-implementation
**Branch:** `feat/template-recipes-preview`
**Supersedes for new builds:** the existing StoreGen prompt/block-plan/raw-home generation path described in `2026-06-29-store-generator-design.md`, `2026-07-08-storegen-visual-mvp-design.md`, and the generation portions of `2026-07-09-store-builder-premium-ab-design.md`

## 1. Decision

The Store builder will have two production-quality design paths behind one prompt-first entry point:

1. **Recipe path:** a prompt that confidently matches one of the approved ecommerce niches previews and builds the corresponding interactive storefront recipe with the logged-in merchant's real store, catalog, collections, variants, prices, availability, imagery, and inventory presentation.
2. **Custom path:** an explicit request for something original, or a prompt that does not confidently match a recipe, invokes a new **AI Storefront Compiler**. It authors a complete multi-route HTML/CSS design system and a declarative interaction manifest, renders it with real merchant data, validates it in a browser, repairs defects, and installs the whole store atomically.

The current StoreGen implementation is not the custom path. Its prompts, fixed block plans, homepage-only raw HTML strategy, generic fallback layouts, and template-instructions-as-brief behavior are retired for new builds. Reusable infrastructure remains: authentication, generation quotas, streamed progress, catalog/settings reads, owned asset storage, cart and checkout services, audit records, and tenant storefront resolution.

The approved catalog contains **eleven recipes total**: the ten niche designs plus the previously approved Atelier Grid recipe.

## 2. Product outcomes

A successful build must produce a storefront that:

- Is unmistakably an ecommerce store, not a landing-page poster.
- Uses the merchant's current products, collections, variants, prices, availability, images, and store identity.
- Has complete home, collection, product, search, cart, and checkout surfaces.
- Supports working navigation, search, sorting, applicable facets, variant selection, quantity changes, cart mutations, and checkout progression. Quick view and niche interactions are required only when declared by the selected recipe/custom bundle.
- Preserves the radically different layouts, typography, icons, imagery, scroll behavior, and interaction style of each recipe.
- Produces genuinely original custom stores rather than restyling a shared template.
- Shows the same design and data contract in draft preview and on the published storefront.
- Never gives generated code authority over tenant identity, inventory truth, pricing, cart ownership, customer data, shipping, tax, or payment execution.

## 3. Non-goals

- Executing model-authored arbitrary JavaScript on the public storefront.
- Allowing generated code to call arbitrary network endpoints.
- Replacing the native cart, order, inventory, shipping, tax, or Stripe services.
- Copying or redistributing third-party templates, fonts, icons, photographs, HTML, CSS, or JavaScript without explicit rights.
- Generating a partial store and silently mixing it with an unrelated fallback theme.
- Rewriting the merchant catalog when changing designs.
- Making exact private stock quantities, costs, supplier data, or internal shop identifiers public.

## 4. Prompt-to-design routing

### 4.1 Request contract

The client and server share a pure, versioned routing contract:

```ts
export type StoreDesignMode = "auto" | "recipe" | "custom";

export interface StoreDesignRequest {
  prompt: string;
  mode: StoreDesignMode;
  templateId?: StoreTemplateId;
}

export interface CatalogRoutingEvidence {
  productTitles: string[];
  productTypes: string[];
  productTags: string[];
  optionNames: string[];
  collectionTitles: string[];
  fingerprint: string;
}

export interface RoutingScoreBreakdown {
  templateId: StoreTemplateId;
  aliasHits: string[];
  strongPhraseHits: string[];
  promptTermHits: string[];
  catalogTermHits: Array<{ term: string; field: keyof Omit<CatalogRoutingEvidence, "fingerprint"> }>;
  score: number;
}

export type StoreDesignResolution =
  | {
      kind: "recipe";
      templateId: StoreTemplateId;
      templateVersion: number;
      selectionKind: "manual_override" | "explicit_name" | "niche_match";
      routingVersion: number;
      registryVersion: number;
      catalogFingerprint: string;
      score: number | null;
      runnerUpScore: number | null;
      margin: number | null;
      confidenceBand: "high" | "medium" | null;
      breakdown: RoutingScoreBreakdown[];
      reasons: string[];
    }
  | {
      kind: "custom";
      reason: "explicit_custom" | "low_confidence" | "ambiguous_recipe_names" | "manual_override";
      routingVersion: number;
      registryVersion: number;
      catalogFingerprint: string;
      breakdown: RoutingScoreBreakdown[];
      reasons: string[];
    };

export function resolveStoreDesign(
  request: StoreDesignRequest,
  evidence: CatalogRoutingEvidence,
  registry: VersionedStoreTemplateRegistry,
): StoreDesignResolution;
```

Catalog evidence is assembled on the server from the bounded public routing fields above. Product descriptions are never included. The welcome UI uses a debounced, read-only server resolver endpoint rather than maintaining a second browser-side catalog classifier. The build endpoint reruns the same pure resolver against a fresh evidence snapshot, freezes that resolution for the run, and emits it as the first streamed event. All later stages consume that exact frozen object.

Evidence arrays are normalized/deduplicated and deterministically capped before hashing/scoring: 200 active product titles, 100 product types, 200 tags, 100 option names, and 100 collection titles, ordered by stable catalog ID/handle. The fingerprint hashes the normalized field names and values plus routing/registry versions.

The submitted prompt is trimmed, capped at 4,000 Unicode code points, and preserved after validation for design personalization and audit. Routing uses a normalized copy. Invalid request combinations return `422 invalid_design_request` and never silently fall back:

- `mode: "recipe"` requires one known `templateId`.
- `mode: "custom"` forbids `templateId`.
- `mode: "auto"` forbids `templateId`.
- An empty/whitespace prompt is allowed in `auto` mode for catalog inference and in `recipe` mode for an explicit recipe build; `custom` requires a non-empty prompt.

### 4.2 Routing precedence

Routing is deterministic and follows this exact precedence:

1. **Manual recipe override:** `mode === "recipe"` with a validated `templateId` selects that recipe.
2. **Manual custom override:** `mode === "custom"` selects the AI Storefront Compiler.
3. **Explicit no-template language:** in `auto` mode, an unambiguous design instruction such as “do not use a template,” “don't use a template,” “no store template,” “build the store from scratch,” “create a completely new site,” or “design an entirely original layout” selects custom.
4. **Explicit recipe name:** an exact approved recipe name or alias selects that recipe, unless no-template language is also present.
5. **Confident niche match:** the scored niche matcher selects the highest recipe only when it clears both the score and margin thresholds.
6. **Low confidence or no match:** custom. The builder must not choose an irrelevant recipe merely to avoid an AI call.

Manual recipe selection sets `selectionKind: "manual_override"`, pins the registry's current active version for that ID, and returns `null` matcher metrics/confidence rather than fabricating evidence. Explicit-name and scored selections populate the metrics normally.

Custom-intent matching uses an allowlisted token grammar, never a global bag-of-words relationship across the prompt:

- **No-template clauses:** `no|without` followed within three tokens by `template|theme`, or `do not|don't|avoid` followed within four tokens by `use|apply` and `template|theme`.
- **Original-design clauses:** `build|design|create|make` followed within four tokens by `store|site|theme|layout`, then within four tokens by `from scratch|completely new|entirely new|entirely original|completely original`; the design and originality segments may appear in the reverse order with the same gaps.
- **Explicit standalone request:** an imperative clause consisting of `build|design|create|make` plus optional `me|us` and `something completely new|something entirely original`. This supports the builder command without treating the phrase as a catalog descriptor elsewhere in a sentence.

Original-design clauses are suppressed by `not|don't|do not` within three tokens before the imperative. No-template clauses are intentionally negative and are not suppressed. The matcher operates per sentence/clause and never lets a design noun elsewhere in the 4,000-character prompt qualify an originality word. Bare `custom`, `new`, `original`, `unique`, or `one of a kind` never forces custom. A request for “personalized and custom products” or “one-of-a-kind engraved gifts” belongs to Custom Bench and must not accidentally force custom generation. “Use Atelier and make it unique” remains Atelier because `unique` alone is not a custom-store command.

Recipe names and aliases are matched as normalized bounded phrases inside the prompt, not only as whole-prompt equality. Registry validation requires aliases to be globally unique. A recipe-name occurrence is negative when immediately governed by `not`, `don't`, `do not`, `avoid`, or `without`; negative occurrences do not select that recipe. One positive recipe name selects it. Multiple positive recipe names are ambiguous and resolve to custom with `reason: "ambiguous_recipe_names"` unless the merchant uses the recipe UI override. A positive name may coexist with a negative one: “don't use Atelier; use Soft Chemistry” selects Soft Chemistry. Explicit no-template language still wins over every positive recipe name in `auto` mode.

### 4.3 Niche scoring

Each recipe declares:

- `strongPhrases`: multiword prompt phrases strongly identifying the niche.
- `promptTerms`: individual prompt terms.
- `catalogTerms`: product titles, types, tags, option names, and collection names that support the niche.
- `aliases`: exact recipe-name aliases.

Scoring:

```text
exact recipe name or alias       +100
each strong phrase hit             +6
each distinct prompt-term hit       +3
each distinct catalog-term hit      +1, capped at +6
```

Normalize with Unicode NFKC, locale-independent lowercase, canonical apostrophes, whitespace collapse, and hyphen-to-space conversion. Tokens use Unicode letter/number boundaries. Phrase and term hits count once regardless of repetition. Tokens already consumed by a matched strong phrase do not also score as prompt terms. Matching never uses substring containment inside a larger token.

All alias, strong-phrase, and multiword catalog-term matching uses longest-first, non-overlapping token spans. Overlapping registry phrases cannot both score the same prompt span. There is no stemming or heuristic singularization; recipe metadata explicitly lists intended singular/plural and common inflected variants, and registry fixtures verify them. Multiword `catalogTerms` use the same longest non-overlapping phrase rule within each evidence value; individual catalog terms use whole-token matching.

For a non-empty prompt, a recipe is confident when its score is at least `6`, leads the runner-up by at least `2`, and has a prompt-side strong signal: one strong phrase, two distinct prompt terms, or an exact alias. Catalog evidence may strengthen or break a tie but cannot route a non-empty generic prompt on its own. For an empty prompt, catalog inference may select a recipe only when its catalog score is at least `4`, leads by at least `2`, and matches terms from at least two independent evidence fields, such as product types plus collection titles. Otherwise resolution is custom. Ties are low confidence, not registry-order defaults.

Catalog evidence can strengthen or break a tie, but it cannot override explicit no-template language or an explicit UI choice. Archived products do not contribute. Recipe dictionaries must exclude generic commerce words such as `shop`, `product`, `collection`, `sale`, `new`, `premium`, and `gift` unless they occur inside a discriminating strong phrase. Registry tests reject duplicate aliases and duplicate terms within a recipe. Thresholds and dictionaries are calibrated against a checked-in positive/negative fixture corpus, not only handpicked happy paths.

`confidenceBand` is derived, not probabilistic: `high` means an alias hit or score at least `9` with margin at least `4`; all other accepted recipe matches are `medium`. The resolution persists the full breakdown, routing/registry versions, and catalog-evidence fingerprint so a decision can be audited and replayed without implying an uncalibrated probability.

The resolver returns human-readable reasons, for example:

```json
{
  "kind": "recipe",
  "templateId": "companion-field-guide",
  "templateVersion": 1,
  "selectionKind": "niche_match",
  "routingVersion": 1,
  "registryVersion": 1,
  "catalogFingerprint": "sha256:…",
  "score": 12,
  "runnerUpScore": 3,
  "margin": 9,
  "confidenceBand": "high",
  "breakdown": [],
  "reasons": ["Prompt mentions specialty pet health", "Catalog includes supplements and pet-care collections"]
}
```

### 4.4 Required routing examples

| Prompt | Expected result |
|---|---|
| “Build a sustainable refill shop” | Commons Index recipe |
| “A clean skincare store for sensitive skin” | Soft Chemistry recipe |
| “Personalized and custom engraved gifts” | Custom Bench recipe |
| “Use Atelier Grid for my jewelry label” | Atelier Grid recipe |
| “Build a completely new skincare store from scratch” | Custom compiler; explicit custom wins over niche |
| “Do not use Atelier; create something one of a kind” | Custom compiler |
| “One-of-a-kind engraved gifts” | Custom Bench recipe; product language is not custom-store intent |
| “Use Atelier and make it unique” | Atelier Grid recipe |
| “Don't build from scratch; use a clean skincare layout” | Soft Chemistry recipe |
| “Don't use Atelier; use Soft Chemistry” | Soft Chemistry recipe |
| “Try Atelier Grid or Soft Chemistry” | Custom/ambiguous until the merchant chooses a recipe |
| “Make me a store” with an ambiguous catalog | Custom compiler; low confidence |
| Empty prompt with a strongly pet-health catalog | Companion Field Guide recipe |
| “Make something completely new” | Custom compiler; explicit standalone imperative |

### 4.5 Builder experience

As the merchant types, the welcome surface shows one of:

- **Recipe recommendation:** the matching interactive recipe preview, populated with the merchant's current store and catalog data, a concise “Why this matches” explanation, and the other recipes as overrides.
- **Original AI build:** a clear explanation that the prompt will create a new design rather than apply a template, with the expected generation stages and cost/quota status.

Selecting another recipe updates the preview without changing catalog data. Selecting “Create something original” changes `mode` to `custom`. The merchant's explicit selection persists until they return to auto mode; subsequent prompt edits must not silently override it.

On submit, the client sends `StoreDesignRequest`. The first build-stream event contains the frozen authoritative resolution; no generation work begins before that event. If catalog evidence changed after the debounced recommendation, the UI replaces its recommendation with the frozen server result and explains the change. The progress UI can then honestly display either `Applying <recipe>` or `Creating original concepts`.

## 5. Recipe catalog

All recipes implement the shared commerce surface contract in section 6 while retaining distinct route composition, typography, iconography, interaction patterns, and scroll behavior.

| ID | Name | Niche | Visual and interaction signature |
|---|---|---|---|
| `custom-bench` | Custom Bench | Personalized and custom products | Workshop configurator, material swatches, engraved previews, stepwise customization, utilitarian grotesk plus monospaced labels |
| `commons-index` | Commons Index | Sustainable micro-niches | Cooperative directory, impact ledger, refill loops, material provenance, earthy serif plus civic sans |
| `soft-chemistry` | Soft Chemistry | Beauty and clean personal care | Clinical softness, ingredient transparency, routine builder, skin-concern filters, refined serif plus clean humanist sans |
| `companion-field-guide` | Companion Field Guide | Pet products and specialty pet health | Field-guide navigation, pet profiles, species/life-stage filters, dosage and stock facts, friendly slab plus readable sans |
| `daily-protocol` | Daily Protocol | Health and wellness products | Routine ledger, time-of-day shopping, protocol stacks, dosage facts, disciplined neo-grotesk plus mono data labels |
| `room-modes` | Room Modes | Smart home and lifestyle decor | Scene-based browsing, room modes, device protocol facts, spatial transitions, architectural sans plus technical mono |
| `rep-rest` | Rep / Rest | Athleisure and home fitness equipment | Split training/recovery journeys, high-contrast performance type, equipment comparisons, sticky workout storytelling |
| `diagnostic-deck` | Diagnostic Deck | Resale and refurbished electronics | Diagnostic cards, grade and warranty evidence, spec comparisons, inventory status, terminal mono plus condensed display |
| `ritual-almanac` | Ritual Almanac | Functional foods and specialty beverages | Time and ritual browsing, flavor/sourcing stories, subscription cadence, editorial serif plus compact sans |
| `broadcast-patch-bay` | Broadcast Patch Bay | Gaming and creator economy products | Modular signal-chain builder, rig modes, compatibility graph, neon broadcast UI, display grotesk plus console mono |
| `atelier-nine` | Atelier Grid | Editorial fashion, beauty, jewelry, and quiet luxury | Asymmetric magazine grid, condensed display type, thin rules, warm-white canvas, vermilion accent, restrained motion |

Recipe IDs are stable. A material recipe change increments `templateVersion`; existing published releases remain pinned to the prior version until a merchant chooses to upgrade or rebuild.

### 5.1 Committed recipe baselines

The approved prototype HTML is a versioned design input, not disposable brainstorm output:

- Ten niche baselines live at `docs/superpowers/prototypes/storefront-recipes/<template-id>.html`.
- Atelier Grid's approved baseline remains `public/atelier-grid/index.html` with its owned local assets.
- A `baselineArtifact` and fixed-catalog desktop/mobile screenshot set are required metadata for every recipe version.

Each recipe version also declares a route blueprint for `shell`, `home`, `collection`, `product`, `search`, `cart`, and `checkout`: composition family, required hero treatment, scroll model, font IDs, icon rules, card topology, protected commerce-slot placement, signature interactions, and explicitly forbidden generic structures. Route blueprints must differ within a recipe while sharing its design system; they may not all collapse to the same header/hero/grid/footer skeleton.

The committed HTML prototypes contain temporary design-reference imagery/fonts where noted and are not production assets. Before a recipe is activated, its asset manifest must replace every temporary/hotlinked image with merchant catalog media, newly generated owned media, or an explicitly licensed owned asset. It records source, license/provenance, hash, intended slot, and fallback. Recipe fonts must resolve to the curated self-hosted font catalog; external font imports are removed. Production recipe validation fails on any external asset or unresolved font.

Recipe implementation produces visual-regression baselines from a fixed merchant/catalog fixture at the required viewports in section 17.5. A recipe version cannot ship merely because it shares colors or copy with its prototype; its route blueprint, structural signature, signature interactions, and fixed-fixture screenshots must pass.

## 6. Shared commerce surface contract

Every recipe and custom bundle must provide these surfaces:

### 6.1 Global shell

- Store name or logo.
- Collection navigation appropriate to the design.
- Search trigger and usable search experience.
- Account entry point when enabled.
- Cart trigger with live count.
- Mobile navigation.
- Footer with store identity and required policy links.

The shell is design-owned. The platform injects trusted links, account state, cart count, and policy destinations.

### 6.2 Home

- Image-led or deliberately art-directed hero.
- Clear primary shopping action.
- At least one live collection or product merchandising surface.
- Enough real commerce content to make the opening page recognizably shoppable.
- Optional niche modules only when the catalog supports them; unsupported modules disappear cleanly.

### 6.3 Collection

- Collection identity and imagery when available.
- Product grid or an intentionally different shoppable arrangement.
- Sort, available facets, availability state, pagination or incremental loading.
- Empty and no-results states.
- Product cards with image, title, current price, availability, and a working product or quick-add action.

### 6.4 Product detail

- Product title, live price, availability, media gallery, description, options/variants, quantity, and add-to-cart.
- Sold-out and unavailable-variant states.
- Niche-specific facts when available, such as ingredients, device protocol, refurbishment grade, pet life stage, or serving cadence.
- Related products or collection continuation when supported.

### 6.5 Search

- Search input, query state, results, filters/sort where available, clear action, empty state, and keyboard behavior.
- Server-backed search; the browser never receives the entire catalog merely to filter locally.

### 6.6 Cart

- Drawer and/or full cart page, according to the design.
- Live lines, quantities, removal, subtotal, discounts when supported, fulfillment messaging, empty state, and checkout action.
- All totals come from server pricing, never generated markup.

### 6.7 Checkout

- A polished design-specific shell and order-summary composition.
- Trusted contact, shipping, delivery, consent, payment, error, and submit islands.
- Server-authoritative price, discounts, shipping, tax, inventory reservation, order creation, and Stripe Payment Element.
- Preview mode visually exercises the full flow with simulated data but cannot initiate payment or reserve inventory.

## 7. Live merchant data contract

Recipes and custom HTML bind against a public, shop-scoped presentation DTO. Generated artifacts store stable references, never signed URLs or copied catalog values.

Public bindings may expose:

- Store name, logo, public policies, and public social links.
- Product and variant IDs scoped to the current store, handles, titles, public descriptions, option values, public prices, compare-at prices, availability booleans/labels, and owned image references.
- Collection handles, titles, public descriptions, imagery, product counts, and configured facets.
- Cart line IDs, public line descriptions, quantities, public prices, discounts, and totals.
- Public custom fields that have an explicit storefront exposure policy.

Bindings must not expose:

- Internal `shop_id`, service credentials, supplier costs, margin, private notes, or inventory ledger/location details.
- Customer data outside the trusted account and checkout islands.
- Exact inventory counts unless a future merchant-controlled setting explicitly publishes them.

Catalog strings are data, not instructions. They are inserted as text nodes or validated attributes and never concatenated into executable source.

Field ownership is explicit:

- **Live at request time:** store name/logo, public policies and social links, catalog titles/descriptions, prices shown while browsing, product/variant availability, collection membership, account state, cart state, and owned media resolution.
- **Pinned to the release:** tagline/brand copy used by the design, palette, layout, compiled HTML tree, scoped CSS, generated editorial copy, design tokens, font/icon choices, interaction manifest, and generated editorial assets.
- For bundle-rendered stores, the legacy `store_settings.palette` and `voice_tagline` are ignored at render time. A Studio palette, tagline, typography, or generated-copy edit compiles a new draft bundle version. Operational settings and normal catalog edits do not require design regeneration.

`requiredData` is a closed, versioned enum of capped query plans such as `currentProduct`, `currentCollection`, `featuredProducts(limit, collectionHandle?)`, `relatedProducts(limit)`, `cart`, and `searchResults(limit)`. The model cannot invent fields, joins, expressions, or unbounded queries. Missing referenced products/collections are removed cleanly and activate the route's validated empty state.

## 8. Unified storefront bundle

Both paths resolve to an immutable, versioned storefront release:

```ts
export interface StorefrontBundleV1 {
  schemaVersion: 1;
  runtimeVersion: 1;
  validationProfileVersion: 1;
  source:
    | { kind: "recipe"; templateId: StoreTemplateId; templateVersion: number }
    | {
        kind: "custom";
        generationId: string;
        promptHash: string;
        derivedFromVersionId?: string;
        derivedFromTemplateId?: StoreTemplateId;
        derivedFromTemplateVersion?: number;
      };
  concept: {
    name: string;
    rationale: string;
    noveltySignature: string[];
  };
  designSystem: {
    displayFontId: CuratedFontId;
    bodyFontId: CuratedFontId;
    tokens: Record<string, string>;
    breakpoints: Record<string, number>;
    iconStyle: string;
    motionStyle: string;
    globalCss: string;
  };
  shell: RouteArtifact;
  routes: {
    home: RouteArtifact;
    collection: RouteArtifact;
    product: RouteArtifact;
    search: RouteArtifact;
    cart: RouteArtifact;
    checkout: CheckoutRouteArtifact;
  };
  assets: AssetManifest;
}

export interface RouteArtifact {
  html: string;
  tree: CompiledNode[];
  bindings: CompiledBinding[];
  css: string;
  requiredData: DataRequirement[];
  requiredCapabilities: RuntimeCapability[];
  interactions: InteractionManifestV1;
  trustedSlots: TrustedSlotManifest[];
}

export interface CheckoutRouteArtifact {
  decorativeHtml: string;
  decorativeTree: CompiledNode[];
  bindings: CompiledBinding[];
  decorativeCss: string;
  layout: CheckoutLayoutManifest;
  requiredData: Array<{ kind: "storeIdentity" | "policyLinks" }>;
}

export type PublicDataRef =
  | { kind: "data"; scopeId: string; path: PublicBindingPath }
  | { kind: "state"; stateId: string }
  | { kind: "event"; field: "value" | "checked" | "key" | "progress01" }
  | { kind: "literal"; value: string | number | boolean | null };

export interface RouteTarget {
  routeId: "home" | "collection" | "product" | "search" | "cart" | "checkout" | "account" | "policy";
  params: Partial<Record<"handle" | "query" | "policyId", PublicDataRef>>;
}

export interface TrustedSlotManifest {
  id: string;
  kind: "variantPicker" | "addToCart" | "cartLineControls" | "cartSummary" | "cartDrawer" | "quickViewCommerce";
  scopeId?: string;
  hostSize: "inline" | "block" | "panel" | "page";
  themeTokenIds: string[];
}

export interface CheckoutLayoutManifest {
  columnMode: "single" | "summaryAside" | "summaryFirst";
  sectionOrder: Array<"contact" | "shipping" | "delivery" | "consent" | "payment" | "summary">;
  spacingTokenId: string;
  surfaceTokenIds: string[];
}

export interface InteractionManifestV1 {
  version: 1;
  state: Array<{
    id: string;
    type: "boolean" | "enum" | "boundedNumber" | "index" | "textQuery";
    initial: boolean | string | number;
    allowedValues?: string[];
    min?: number;
    max?: number;
  }>;
  bindings: Array<{
    targetId: string;
    property: "hidden" | "expanded" | "selected" | "activeIndex" | "textQuery" | "classToken" | "progress01";
    stateId: string;
  }>;
  transitions: Array<{
    on: "click" | "change" | "input" | "keydown" | "inview" | "scrollProgress";
    sourceId: string;
    action: RuntimeActionSpec;
  }>;
}

export type RuntimeActionSpec =
  | { type: "state.set" | "state.increment" | "state.decrement"; stateId: string; value?: PublicDataRef }
  | { type: "surface.open" | "surface.close" | "surface.toggle"; surfaceId: string }
  | { type: "tabs.select" | "accordion.toggle" | "gallery.select"; targetId: string; value: PublicDataRef }
  | { type: "carousel.previous" | "carousel.next"; targetId: string }
  | { type: "collection.filter"; facetId: string; value: PublicDataRef }
  | { type: "collection.sort" | "collection.view"; value: PublicDataRef }
  | { type: "collection.page"; cursor: PublicDataRef }
  | { type: "search.update" | "search.submit"; query: PublicDataRef }
  | { type: "search.clear" }
  | { type: "scroll.to"; targetId: string }
  | { type: "navigate"; target: RouteTarget };
```

`tree`/`decorativeTree` and the closed `bindings` plan are the authoritative runtime representation. The HTML strings are deterministic compiler output retained only for diagnostics, hashing, and cache inspection; public and preview renderers never reparse them or pass them to `dangerouslySetInnerHTML`.

Every installed recipe and custom release persists or content-addresses the exact compiled artifact. An in-code registry entry alone is not an immutable release. The installed recipe release pins its template ID/version, artifact hash, compiled routes, assets, and merchant-selected configuration, so a later deploy cannot change an existing published store. Custom bundles persist the same compiled artifact shape.

Generated links and interaction targets use compiler-issued local IDs. Links use validated `RouteTarget` values, never hardcoded `/storefront` URLs. Repeaters introduce a compiler-issued `scopeId`; a `PublicDataRef` may read only allowlisted fields from its current/referenced scope, so a product row can bind its own variant while a cart row can bind its own line ID without string-expression evaluation. Cross-scope references fail compilation.

The AI-facing `data-cd-action`/`data-cd-*` attributes are source syntax only. The compiler resolves them into `InteractionManifestV1`, removes action expressions from the compiled presentation tree, and treats the typed manifest as the single authority. There is no second literal `value` channel or precedence rule. The public and preview adapters resolve route/action specs. Interaction state is local, typed, bounded, and serializable; manifests cannot contain selectors, expressions, callbacks, code, arbitrary URLs, or unbounded state. Compiler limits cap states/transitions per route.

## 9. AI Storefront Compiler

### 9.1 Model output

The custom path generates full HTML and scoped CSS plus a declarative data/interaction language. It does not generate public executable JavaScript.

Example:

```html
<section class="collection-wall" data-cd-repeat="collection.products">
  <article data-cd-key="product.id">
    <a data-cd-href="product.url">
      <img data-cd-src="product.primaryImage" data-cd-alt="product.title">
      <h3 data-cd-text="product.title"></h3>
      <span data-cd-money="product.price"></span>
    </a>
    <div data-cd-slot="addToCart" data-cd-product="product.id"></div>
  </article>
</section>
```

This remains fully interactive HTML in the browser because the trusted Storefront Runtime compiles and hydrates the validated attributes. The compiler replaces the `addToCart` source slot with the platform-owned, recipe-themed trusted island; generated transitions cannot call cart or variant mutations directly.

### 9.2 Trusted interaction vocabulary

Initial runtime capabilities must cover the approved prototypes:

- Open, close, toggle, modal, drawer, popover, tabs, and accordion.
- Carousel previous/next, gallery media selection, and thumbnail navigation.
- Collection filter, sort, pagination, and view switching.
- Search query, predictive results, clear, and submit.
- Trusted variant-selection islands and availability refresh.
- Trusted quantity, add-to-cart, cart line update/removal, clear-cart, and checkout controls placed in design-owned slots.
- Scroll-to, sticky regions, progress indicators, intersection reveals, bounded parallax, and reduced-motion behavior.
- Recipe features such as pet profiles, room modes, routines, comparisons, custom-product steps, and creator rig builders when expressible as local state over public catalog data.

Compiler-issued local IDs are used for targets. The model cannot supply arbitrary selectors for commerce operations.

Commerce mutations are available only inside trusted-slot components, never as `RuntimeActionSpec` actions. Generated presentation may navigate, open the platform cart/quick-view surface, and place/theme commerce slots, but it cannot author an alternative cart button that bypasses island validation.

`scrollProgress` events expose only normalized `progress01` clamped to `[0,1]`. A `progress01` binding writes a compiler-issued `--cd-progress` value to its local target; precompiled CSS may consume it only through allowlisted opacity and bounded translate/scale transforms. It cannot bind arbitrary CSS properties, layout dimensions, URLs, content, z-index, or protected-island hosts. Reduced-motion mode fixes progress-driven effects at their usable resting state.

Unsupported actions invalidate the candidate. They do not degrade into inert controls. A genuinely new interaction that requires a new trusted capability is a separate runtime feature, not an excuse to execute generated code.

### 9.3 Trusted commerce islands

These controls remain platform-authored components placed into AI- or recipe-designed slots:

- Account/login controls.
- Variant ownership and availability validation.
- Add-to-cart mutation boundary.
- Cart pricing and mutation boundary.
- Delivery promise and shipping quote.
- Checkout contact, address, delivery, consent, Stripe Payment Element, error, and submit lifecycle.

The design can control surrounding grid, hierarchy, labels, typography, spacing, borders, colors, and summary placement through validated markup and tokens. It cannot replace the commerce logic.

Trusted cart and checkout components are also outside generated CSS authority, with one mechanism per island class:

- Inline commerce islands such as variant picker and add-to-cart render in closed Shadow DOM with a platform reset. Generated CSS may size the host only through an allowlisted host contract and may pass allowlisted `--cd-slot-*` tokens.
- Drawers, search overlays, quick-view dialogs, and notices mount in a platform-owned top-layer portal outside the generated bundle root. The portal owns stacking, backdrop, focus trap/restore, Escape handling, inert-background behavior, and protected commerce sub-islands. Each recipe/custom bundle may project validated compiled presentation nodes and scoped portal CSS into an allowlisted presentation region, so overlay composition, icons, imagery, result layout, scroll treatment, and motion remain design-specific. Quick-view variant/add controls and cart mutations remain protected Shadow DOM islands inside that presentation.
- Checkout contact, shipping, consent, payment, totals, errors, and submit render in a platform-owned sibling root outside the generated bundle root. The bundle supplies a validated `CheckoutLayoutManifest` (column order, summary placement, approved tokens, and bounded spacing), not arbitrary CSS over the trusted form.

`CheckoutRouteArtifact` is deliberately narrower than `RouteArtifact`. Its decorative HTML/CSS may render store identity, owned decorative media, and platform-provided policy links only. The compiler rejects form/input/button controls, cart/order/price/customer bindings, submit/payment/cart actions, dialogs/drawers/top-layer surfaces, fixed overlays, and anything overlapping the sibling checkout root. The platform root owns the order summary, totals, editable fields, CTA, legal copy, and every error state; there can be no fake or duplicate checkout controls beside it.

The platform owns field visibility, legal/consent text, totals, error presentation, focus rings, hit targets, stacking order, and Stripe styling. Generated pseudo-content, overlays, opacity, transforms, or pointer rules cannot cover or disable a protected island. Browser validation includes element hit-testing, visibility, stacking, and focusability for every protected control.

## 10. Custom generation pipeline

### 10.1 Context assembly

Build a bounded merchant snapshot containing:

- Original prompt and explicit reference images.
- Store identity and existing public brand assets.
- Catalog taxonomy, collections, representative products, variants/options, price ranges, availability capabilities, and image aspect metadata.
- Existing owned generated assets that may be reused.
- The recipe novelty signatures used only as “do not converge on these” comparisons.

Limit catalog payload size deterministically while preserving collection coverage. Treat all merchant/catalog strings as untrusted data.

### 10.2 Parallel creative exploration

Generate three structurally different concept candidates in parallel. Each candidate includes:

- Design-system tokens and a curated, self-hosted font pairing.
- Shell and homepage HTML/CSS.
- Mobile and desktop composition.
- Icon and imagery direction.
- Interaction plan and required runtime capabilities.
- Asset request plan.
- `noveltySignature`: layout topology, type treatment, section rhythm, color structure, navigation model, and interaction style.

Candidate prompts receive different structural constraints, not merely different mood adjectives.

### 10.3 Deterministic compile

Before visual selection, parse HTML and CSS with AST-based compilers and enforce:

- Schema validity and supported route keys.
- HTML tag/attribute allowlists.
- Binding, repeater, slot, and action allowlists.
- Valid internal routes and catalog reference shapes.
- Required commerce slots for each route.
- Unique/namespaced IDs and keyframes.
- Scoped selectors that cannot escape the bundle root.
- No scripts, event handlers, arbitrary forms, remote imports, external CSS URLs, dynamic code, or arbitrary fetch destinations.
- DOM, CSS, interaction, animation, font, image, and total-byte budgets.
- Static usability if client hydration or an optional effect fails.

Invalid structured output gets one compiler-diagnostic repair attempt before the candidate is rejected.

### 10.4 Real-data render and visual selection

Every valid concept is rendered with the merchant's actual public data at mobile and desktop breakpoints. The visual judge scores:

- Prompt fit.
- Originality and distance from all eleven recipes.
- Ecommerce clarity and product prominence.
- Typography, imagery, hierarchy, and composition.
- Responsive quality.
- Interaction affordance clarity.
- Accessibility and reduced-motion integrity.

A candidate that resembles a recipe too closely is rejected from the custom path even if visually attractive.

### 10.5 Winner expansion

After the home/shell winner is selected, generate route groups in parallel:

- Collection and search.
- Product detail.
- Cart and checkout shell.

Every route call receives the winning design system, shell, homepage, interaction vocabulary, binding contract, and live data shape. Routes should feel related without repeating one page layout.

### 10.6 Asset production

Asset priority:

1. Merchant catalog photography.
2. Merchant-owned uploaded brand assets.
3. Original generated editorial/hero art when requested or required by the winning concept.
4. Deterministic designed placeholders when an optional asset is unavailable.

Generated and uploaded assets are persisted to owned storage. The bundle stores asset keys, not temporary signed URLs. Fonts come from a curated self-hosted catalog. Icons are validated inline SVG or trusted icon IDs. No production hotlinks.

Assets are immutable and content-addressed. Generation writes them to a staging namespace, records size/hash/type, and verifies existence before draft installation. A failed candidate cannot publish dangling asset references. Garbage collection only removes assets unreachable from the current draft, published release, retained release history, or active generation checkpoints; asset keys are never overwritten in place.

### 10.7 Browser proof and repair

Render a route-by-device matrix and exercise:

- Navigation and mobile menu.
- Search, filters, sorting, pagination, and no-results states.
- Gallery, quick view, variant selection, sold-out states, and add-to-cart.
- Cart quantity, removal, totals, empty state, and checkout transition.
- Checkout layout with simulated preview islands.
- Keyboard navigation, focus trap/restore, Escape behavior, visible focus, and reduced motion.
- Missing-image, empty-collection, low-inventory, sale, and long-copy cases.
- Console errors, failed assets, dead links, unexpected network requests, and rejected bridge actions.

Repair only the failing route or region, passing the compiler/browser diagnostics and screenshots back to the repair call. Permit at most two targeted repairs. If the winner still fails, evaluate the next valid concept. Never combine an unrelated fallback route with the winning store.

### 10.8 Atomic installation

Candidates and checkpoints are stored separately from the merchant's current draft. Only a complete bundle that passes all required gates becomes the new draft release. A failed, timed-out, or cancelled generation leaves the existing draft untouched.

### 10.9 Prompt-directed editing

The Store Studio composer edits the current immutable draft instead of treating every follow-up as a new-store request. An edit request includes the merchant prompt, the expected base bundle ID and artifact hash, the active preview route, and optional platform-issued region/element IDs from preview markup. The server rejects stale bases with `409 storefront_edit_conflict`; it never applies a patch to a newer draft implicitly.

Every accepted edit produces a new candidate bundle version and an audit record. Published bundles are never mutated. The candidate passes the same compiler, security, data-binding, accessibility, route, browser, and asset gates as a new build before an atomic draft-pointer swap. Failure leaves the current draft and published release untouched. Undo installs the recorded base version through the same compare-and-swap path rather than attempting an inverse text patch.

Edits use the narrowest safe path:

1. A deterministic intent parser handles supported token, copy, visibility, and bounded ordering changes such as palette tokens, typography IDs, announcement text, hero copy, section visibility, and movement within a validated container. These edits do not spend model quota.
2. A targeted AI patch compiler handles layout, composition, imagery direction, and interaction changes. It receives only the validated bundle schema, current route/region artifact, public presentation data needed for that region, and the merchant instruction. It returns a typed `StorefrontBundlePatchV1`, never executable JavaScript or an unconstrained whole-store replacement.
3. A recipe remains `source.kind = "recipe"` while the change fits its declared override surface. A structural patch outside that surface creates `source.kind = "custom"` with `derivedFromVersionId`, `derivedFromTemplateId`, and the original recipe version recorded in provenance. Detachment starts from the currently rendered artifact and changes only the requested scope; it does not regenerate unrelated routes.
4. A custom bundle always receives a targeted patch. A whole-store redesign requires an explicit new-build intent such as “start over” or “create a completely new site,” and follows the normal prompt router/custom-build flow.

`StorefrontBundlePatchV1` is a closed discriminated union of design-token updates, trusted text replacements, route/region subtree replacements, scoped CSS replacements, interaction-manifest replacements, and owned-asset reference changes. Every operation names compiler-issued IDs and carries precondition hashes. Arbitrary selectors, data queries, URLs, form actions, scripts, and raw database IDs are forbidden. The patch compiler applies all operations in memory, validates the complete resulting bundle, and persists only the resulting immutable bundle plus the audit patch; the runtime never interprets an unapplied patch.

The build stream distinguishes `routing`, `editing`, `compiling`, `validating`, `proofing`, and `installed` stages. The completion message states which routes/regions changed and whether a recipe was detached. Preview reloads to the new draft only after installation. The same prompt, base hash, compiler/profile versions, and deterministic catalog snapshot are retained for replay and support diagnostics.

## 11. Storefront Runtime and APIs

### 11.1 Rendering

The public storefront server-renders validated compiled nodes for SEO and first paint, then hydrates supported behavior with the trusted first-party runtime. The live storefront is not a whole-page iframe.

The current block-document renderer remains available only for legacy releases during migration. New recipe and custom builds use the bundle renderer.

Preview and public rendering use the exact same compiled bundle renderer, route resolver, presentation DTO, and asset resolver. The only substitution is the commerce capability adapter: public uses the real server-authoritative adapter; preview uses a simulation adapter. Public collection/product handles that do not exist return the platform-owned `404` route. Preview may deliberately bind the first valid sample record when no handle is selected.

The platform, never generated HTML, owns document `<head>` output: title, description, canonical URL, robots directives, social metadata, structured data, policy destinations, and error metadata. Product/collection SEO derives from trusted live route data. Search, cart, account, and checkout are `noindex`. Generated routes render inside a platform-owned error boundary and cannot author `<html>`, `<head>`, `<base>`, canonical, robots, or JSON-LD nodes.

### 11.2 Cache and tenant isolation

Cache policy is part of the renderer contract:

- Public home/collection/product HTML may be shared-cached only after tenant resolution, keyed by resolved shop, published bundle ID/hash, route kind/params, catalog revision, and relevant public settings revision. Publish, catalog mutation, owned-media replacement, and public-brand changes invalidate the affected keys.
- Cacheable public HTML SSRs a neutral account/cart shell; the trusted runtime hydrates account state and cart count from private no-store endpoints. Cookie-personalized markup is never inserted into a shared-cached document.
- Cart, account, checkout, preview, signed-media responses, and every cookie/customer-personalized API response use `Cache-Control: private, no-store`. Cart JSON is never CDN-cached or reused across hosts, shops, sessions, or cookies.
- Private responses use appropriate `Vary` headers; public cache keys include the resolved tenant host/shop rather than trusting a client-supplied shop ID. Tenant resolution occurs before any cache lookup.
- Preview uses the authenticated shop/session in its cache key but remains `private, no-store`.

### 11.3 Cart bridge

Add same-origin, shop-resolved cart endpoints that reuse existing services:

```text
GET  /storefront/api/cart
POST /storefront/api/cart/add
POST /storefront/api/cart/quantity
POST /storefront/api/cart/remove
POST /storefront/api/cart/clear
```

Every mutation derives the shop and cart from the tenant host/session and signed cookie, validates origin and CSRF posture, rate-limits, and verifies variant ownership/availability. Client-supplied title, price, discount, currency, shop, or totals are ignored.

Pricing preserves the existing buyer contract: browse and PDP prices/availability are live; add-to-cart creates authoritative server-side title/price/currency snapshots; cart totals are recomputed from those trusted line snapshots; checkout revalidates shop ownership, variant availability, and inventory while preserving the agreed snapshots. Live repricing after add-to-cart is outside this renderer project and would require a separate commerce migration and buyer-facing price-change flow.

### 11.4 Search and facets

Add server-backed search/facet endpoints over the shop-scoped catalog. Do not send the capped full catalog to the browser. Query length, filters, sort values, result limits, and pagination cursors are validated.

### 11.5 Preview runtime

Preview loads the complete draft bundle and real public merchant data. It supports route navigation and all non-destructive interactions. Preview cart state persists across preview-route navigation in a preview-scoped signed session or iframe-local runtime store and never reads or writes the buyer `cd_cart` cookie. Checkout uses simulated trusted islands. Preview never reserves inventory, creates orders, mounts a real Payment Element, or navigates the iframe to the live/demo tenant.

## 12. Persistence, publish, and rollback

Introduce immutable bundle versions and atomic release pointers:

```text
storefront_bundle_version
  id uuid primary key
  shop_id uuid not null references shops(id) on delete cascade
  source_kind text check (source_kind in ('legacy','recipe','custom'))
  template_id text null
  template_version int null
  status text check (status in ('candidate','validated','failed'))
  schema_version int not null
  runtime_version int not null
  validation_profile_version int not null
  artifact_hash text not null
  bundle_json jsonb not null
  asset_manifest jsonb not null
  validation_report jsonb
  generation_prompt text
  resolution_json jsonb not null
  created_at timestamptz not null
  unique (shop_id, id)
  check (source_kind = 'recipe' and template_id is not null and template_version is not null
      or source_kind in ('legacy','custom') and template_id is null and template_version is null)
  check (source_kind = 'legacy' and runtime_version = 0 and validation_profile_version = 0
      or source_kind in ('recipe','custom') and runtime_version >= 1 and validation_profile_version >= 1)

storefront_release
  shop_id uuid primary key references shops(id) on delete cascade
  draft_version_id uuid null
  published_version_id uuid null
  updated_at timestamptz not null
  foreign key (shop_id, draft_version_id)
    references storefront_bundle_version(shop_id, id)
  foreign key (shop_id, published_version_id)
    references storefront_bundle_version(shop_id, id)

storefront_release_history
  id uuid primary key
  shop_id uuid not null references shops(id) on delete cascade
  from_version_id uuid null
  to_version_id uuid not null
  operation text check (operation in ('capture_legacy','install_draft','edit_draft','publish','rollback'))
  actor_id uuid null references auth.users(id) on delete set null
  created_at timestamptz not null
  foreign key (shop_id, from_version_id)
    references storefront_bundle_version(shop_id, id)
  foreign key (shop_id, to_version_id)
    references storefront_bundle_version(shop_id, id)

storefront_asset_object
  shop_id uuid not null references shops(id) on delete cascade
  asset_key text not null
  content_hash text not null
  media_type text not null
  byte_size bigint not null
  state text check (state in ('staged','verified','deleting','deleted','failed'))
  generation bigint not null default 1
  created_at timestamptz not null
  primary key (shop_id, asset_key)

storefront_bundle_asset
  shop_id uuid not null references shops(id) on delete cascade
  bundle_id uuid not null
  asset_key text not null
  status text check (status in ('verified','locked','failed'))
  created_at timestamptz not null
  primary key (shop_id, bundle_id, asset_key)
  foreign key (shop_id, bundle_id)
    references storefront_bundle_version(shop_id, id) on delete cascade
  foreign key (shop_id, asset_key)
    references storefront_asset_object(shop_id, asset_key)
```

All reads and writes are shop-scoped through server-side repositories. Tables use RLS and revoke direct anon/authenticated access, matching existing service-role patterns.

Validated bundle rows are immutable; database permissions/triggers reject artifact mutation after `status = 'validated'`. Draft install and publish occur only through transactional database functions:

- `install_storefront_draft(shop_id, validated_version_id, expected_draft_version_id)` verifies same shop, validated status, supported schema/runtime/profile, a one-to-one match between the asset manifest, `verified` bundle references, and `verified` asset-object rows, plus the expected current draft. In one transaction it row-locks/marks those references `locked`, conditionally swaps the pointer, and appends history.
- `publish_storefront_release(shop_id, expected_draft_version_id, expected_published_version_id)` verifies the draft is still current/validated/supported, conditionally swaps the published pointer, and appends history.
- `rollback_storefront_release(shop_id, target_version_id, expected_published_version_id)` verifies a retained same-shop validated/supported target before the conditional swap and history append.

Zero-row conditional updates are conflicts, not successes. Publishing never promotes route-by-route. Release history provides deterministic one-click rollback and audit. Publication verifies renderer support before the pointer moves. Deploys retain renderers for all supported pinned runtime versions until explicit migration; emergency fallback may select the newest compatible retained history entry rather than rereading the same unsupported pointer.

Before the first bundle publish, the transaction captures the current published `page_document` set and relevant store settings as an immutable `source_kind = 'legacy'`, `runtime_version = 0` release artifact, then records it in history. The legacy adapter renders that exact snapshot. This makes the promised legacy rollback a real version target rather than a mutable read from whatever rows happen to exist later.

The persisted artifact is an explicit union:

```ts
export type StoredReleaseArtifact =
  | { sourceKind: "recipe" | "custom"; bundle: StorefrontBundleV1 }
  | { sourceKind: "legacy"; snapshot: LegacyReleaseSnapshot };

export interface LegacyReleaseSnapshot {
  schemaVersion: 1;
  runtimeVersion: 0;
  validationProfileVersion: 0;
  pageDocuments: Record<"home" | "collection" | "pdp", BlockDocument | null>;
  storeSettings: LegacyStoreSettingsSnapshot;
  referencedAssetKeys: string[];
  capturedAt: string;
}
```

Legacy rows store `resolution_json = { "kind": "legacy_capture" }`, an asset manifest for referenced owned assets, and a legacy-adapter validation report proving documents deserialize, sanitize, resolve tenant-scoped data, and render without a server error. Runtime/profile `0` is a deliberately supported compatibility pair, exempt from the new bundle visual profile but still required to pass that adapter validation before capture/rollback. `StorefrontBundleV1` recipe/custom rows require validation profile `1` or a later supported version. Artifact hashing includes schema, runtime, validation-profile version, compiled artifact/snapshot, and asset manifest.

Asset storage verification occurs before the database function and is durably represented by `storefront_asset_object.state = 'verified'` plus a bundle reference with `status = 'verified'`; the function does not pretend to query object storage transactionally. Reference creation and garbage collection both acquire the same shop-scoped `storefront_asset_object` row lock. GC rechecks all bundle/checkpoint references, increments `generation`, and marks the object `deleting` before commit. New references to `deleting`/`deleted` objects are refused and must use a new immutable asset key. Immediately before asynchronous object deletion, the worker reacquires the row lock and verifies the same `generation`, `deleting` state, and zero references; only then does it delete and mark `deleted`. This tombstone/generation protocol prevents a new bundle reference from racing an asynchronous deletion.

## 13. Security and isolation

- Model HTML is untrusted and always compiled/sanitized before persistence as a validated bundle.
- Model JavaScript, inline event handlers, `eval`, dynamic imports, arbitrary form actions, workers, iframes, and arbitrary network access are forbidden.
- CSS is AST-validated, scoped, and budgeted; regex-only `@import`/`expression()` stripping is insufficient.
- Storefront routes use a storefront-specific document/link policy rather than inheriting remote admin fonts or permissive embedded-app rules. Compiled CSS, fonts, icons, and images are content-addressed first-party assets. First-party runtime and Remix hydration use nonces/hashes; model-authored inline script/style is forbidden. CSP restricts `script-src`, `style-src`, `connect-src`, `font-src`, `img-src`, `frame-src`, `object-src`, `worker-src`, `form-action`, and `base-uri` per route. Only checkout receives the additional Stripe origins it needs.
- Product/catalog strings are bound as text or validated attributes, never HTML or code.
- Generated commerce actions contain stable public IDs only; the server rederives and revalidates all authority.
- The model never receives credentials, internal tenant identifiers, private customer data, costs, or private inventory details.
- Asset fetches go through approved owned-storage/proxy paths.

If raw model JavaScript is ever used as a disposable internal concept aid, it must run only in an opaque-origin `sandbox="allow-scripts"` frame with `connect-src 'none'`, `form-action 'none'`, no same-origin permission, no real commerce bridge, and no publish path. It is not part of the production design.

## 14. Failure behavior

- **Provider transient error:** bounded retry with backoff within the generation budget.
- **Invalid concept output:** one schema/compiler repair, then reject that candidate.
- **Broken route:** targeted repair; do not replace it with a generic route.
- **Optional effect failure:** remove the enhancement while preserving usable content and controls.
- **Editorial asset failure:** use merchant photography or a clearly recorded designed placeholder.
- **All candidates fail:** preserve the current draft and return an honest failure with diagnostics and retry action.
- **Timeout/cancellation:** retain audit checkpoints but install nothing.
- **Catalog changes after generation:** resolve browse prices, availability, variants, images, collection membership, and cart state at request time; existing cart lines keep authoritative add-time snapshots; no design regeneration is required.
- **Unsupported runtime version:** publication refuses unsupported versions. If a deploy loses support unexpectedly, select the newest compatible retained history entry, alert operators, and never blank the storefront.

## 15. Observability and budgets

Generation audit records:

- Raw request and authoritative routing resolution.
- The bounded normalized catalog-evidence snapshot used for routing, its fingerprint, and the immutable routing/registry metadata required to replay the decision. A fingerprint alone is not treated as replay data.
- Recipe/template version or custom generation ID.
- Model/provider and prompt-contract versions.
- Candidate and repair counts.
- Token, image, browser, and wall-time usage.
- Compiler diagnostics and rejected capabilities.
- Visual/novelty scores.
- Route validation results and screenshot artifact references.
- Final artifact hash and installed bundle version.

Budget limits are explicit and configurable: candidates, model tokens, generated images, browser time, repair attempts, DOM/CSS bytes, runtime capabilities, and total bundle size. A budget breach is visible and cannot silently install a lower-quality generic store.

## 16. Migration and compatibility

1. Existing published `page_document` stores continue rendering through the legacy renderer.
2. The first successful recipe or custom bundle build creates `storefront_release.draft_version_id` without changing the published legacy store.
3. Publishing the bundle switches the shop to the new bundle renderer atomically.
4. Rollback may target a prior bundle or the immutable captured legacy release version while legacy runtime support remains.
5. The current `templateGenerationBrief()` behavior is transitional and removed when recipe bundles ship. Selecting a recipe must instantiate that exact recipe, not append visual prose to the old generator.
6. The current `generateStore()` endpoint may remain temporarily for legacy/internal callers, but the Store builder must not invoke it for new custom builds after cutover.

### 16.1 Legacy experiment cutover

The current document/vibe A/B experiment system is not bundle-aware. To prevent a legacy `variant_doc` from overriding a bundle route or stamping misleading attribution:

- Recipe/custom build and bundle publish return `409 experiment_running` while a legacy storefront experiment is running. The merchant must finish or explicitly stop it first.
- Publishing the first bundle marks the storefront as bundle-rendered; bundle routes bypass all legacy `page_document`/vibe experiment resolution and exposure stamping.
- Historical legacy experiments remain readable in reporting but are never automatically resumed after bundle publish or rollback.
- Rolling back to legacy documents is allowed only when no bundle-native or legacy experiment is running and does not reactivate a historical experiment.
- Bundle-native experimentation is a separate future design using immutable bundle versions and explicit route/metric attribution. It is not emulated by mixing legacy challenger documents into a bundle release.

## 17. Testing

### 17.1 Router tests

- Every recipe's strong phrases, prompt terms, catalog terms, aliases, score threshold, and margin threshold.
- Manual override precedence.
- Explicit custom phrase precedence over niche terms.
- The exact standalone imperative “make something completely new” invokes custom generation.
- `custom` as a bare niche word does not trigger custom generation.
- “One-of-a-kind” product language does not trigger custom generation.
- Negated custom phrases do not trigger custom generation.
- Exact recipe name plus soft originality language still selects the recipe.
- Exact recipe name selection.
- One positive and one negated recipe name selects the positive recipe; multiple positive names are ambiguous.
- Alias collision and duplicate-term registry validation.
- Invalid `mode`/`templateId` combinations return 422.
- Unicode, punctuation, apostrophe, hyphen, and plural fixture coverage.
- Repeated words do not inflate scores and strong-phrase tokens do not double count.
- Ambiguous/tied prompts route to custom.
- Empty prompt catalog inference and low-confidence fallback.
- Debounced recommendation/build-resolution parity when the catalog is unchanged.
- A catalog change between recommendation and submit produces and freezes the new authoritative resolution.
- Routing/registry version, catalog fingerprint, breakdown, and stable reasons are persisted.

### 17.2 Compiler tests

- HTML and CSS AST parsing, selector scoping, ID/keyframe namespacing, size limits, and static fallback.
- Allowed/unknown bindings, repeaters, slots, and actions.
- Repeater-scoped `PublicDataRef`, per-action payload schemas, `RouteTarget` parameters, trusted-slot manifests, checkout-layout manifests, and cross-scope rejection.
- AI-facing action attributes compile into one authoritative manifest and do not survive as a conflicting execution channel.
- Rejection of scripts, handlers, remote imports/URLs, arbitrary forms/fetches, escaping selectors, and unsafe CSS.
- Required route and commerce-slot invariants.
- Catalog text escaping and owned-asset resolution.
- Closed/capped `requiredData` query plans and missing-record empty states.
- Restricted checkout artifacts reject form-like controls, commerce/customer bindings, duplicate totals/CTAs, top-layer surfaces, and overlap with the platform sibling root.

### 17.3 Runtime and commerce tests

- Drawer/modal focus behavior, tabs, carousels, variants, filters, sorting, search, quantities, and reduced motion.
- Shop-scoped cart APIs, CSRF/origin checks, rate limits, variant ownership, live pricing, availability errors, and signed cart identity.
- Search/facet validation and pagination.
- Trusted checkout islands and refusal of generated payment logic.
- Protected-island style isolation, visibility, hit-testing, stacking, and focusability.
- Browse-live versus cart-snapshot price behavior.
- Public neutral-shell hydration and private `no-store` cart/account responses; no cross-shop/host/cookie cache reuse.
- Recipe/custom overlay projection remains design-specific while focus, stacking, and commerce islands remain platform-owned.

### 17.4 Browser matrix

- All eleven recipes across home, collection, product, search, cart, and checkout at mobile and desktop widths.
- At least three custom prompts with materially different compositions.
- Realistic large, small, empty, image-missing, sold-out, sale, multi-variant, and long-copy catalogs.
- Full browse-to-checkout journey in public test mode and simulated preview mode.
- Accessibility scans, keyboard-only flows, console/network assertions, visual regression, and performance budgets.

### 17.5 Validation profile v1

The validation profile is versioned and stored with each bundle. V1 is pass/fail, not advisory:

- Required viewports: `390×844`, `768×1024`, and `1440×1000`; every route renders at all three.
- Zero uncaught console errors, failed required assets, unexpected external requests, unresolved bindings, dead internal links, or visible controls without a working allowed action.
- Axe: zero critical or serious violations. Required keyboard assertions cover shell navigation, search, filters, gallery, variants, cart, dialogs, and checkout; every dialog traps/restores focus and closes with Escape.
- Reduced motion: every route is usable with `prefers-reduced-motion: reduce`; no required content depends on animation and no autoplay includes sound.
- Representative lab targets: CLS `< 0.10`, LCP `< 2.5s`, no generated-runtime long task `> 50ms`, route compiled HTML+CSS `≤ 250KB`, interaction manifest `≤ 40KB`, and full bundle excluding images `≤ 1.5MB`.
- Recipe fixed-fixture visual regression: pixel difference `≤ 0.5%` against the approved versioned baseline at each viewport, excluding explicitly masked dynamic price/availability/media regions.
- Custom visual judge: overall score `≥ 80/100` and no quality dimension below `70`. Prompt fit, ecommerce clarity, hierarchy, responsive quality, and interaction clarity are required dimensions.
- Custom novelty gate: its structural signature must differ from every recipe on at least three of five axes—layout topology, type treatment, section sequence, navigation/scroll model, and interaction style—and receive novelty score `≥ 75/100`. A tie or failed threshold rejects the candidate; it is never rounded up or manually implied by registry order.
- Protected commerce controls pass visibility, hit-testing, stacking, keyboard, and focus assertions before preview/install.

Threshold changes create a new validation-profile version. Existing published releases retain the profile they passed; publishing/rollback still requires a currently supported runtime and profile.

### 17.6 Publish tests

- Candidate creation does not alter draft/published pointers.
- Validation atomically installs draft.
- Publish atomically swaps the published pointer.
- Same-shop composite FKs, validated-version checks, expected-pointer CAS conflicts, and artifact immutability.
- Asset existence/hash verification before install and reachability-safe garbage collection.
- Durable staged/verified/locked asset transitions plus asset-object lock/tombstone/generation coverage for new-reference versus asynchronous-GC races.
- Failure during generation or publish leaves the prior release intact.
- Rollback restores an earlier version without regenerating.
- Legacy snapshot capture, runtime/profile-0 adapter validation, immutable legacy rollback, and legacy asset retention.
- Validation-profile identity is persisted, hashed, and checked for publish/rollback compatibility.
- Unsupported runtime publication refusal and compatible-history emergency fallback.
- Running legacy experiments block bundle build/publish; bundle routes never serve legacy variants.

## 18. Rollout sequence

Implementation planning will decompose this design, but the architectural dependency order is:

1. Deploy inert schema/functions, release history, asset staging, and legacy-capture support. No storefront reads change.
2. Implement the legacy-experiment guard before enabling any bundle build/install/publish endpoint.
3. Ship the shared routing resolver, versioned eleven-recipe metadata, AST compiler, scoped CSS, binding/interaction language, and bundle renderer behind disabled flags.
4. Ship the trusted runtime, cart/search APIs, protected checkout islands, storefront-specific CSP, and exact preview/public renderer parity behind disabled flags.
5. Convert recipes one at a time from committed baselines. Activate each recipe only after its complete route matrix, owned asset manifest, and validation profile pass in internal/shadow mode.
6. Enable bundle reads for internal shops, then a small merchant canary. Keep legacy rendering as the default and monitor render errors, commerce bridge errors, checkout starts/completions, performance, and rollback rate.
7. Enable recipe recommendation/build, then recipe publish, with separate kill switches. A kill switch disables new bundle operations; it never routes the merchant into the disliked old generator.
8. Ship AI concept generation, visual/novelty judging, route expansion, asset pass, browser proof, and repair in shadow mode against test shops and custom-generation quota accounting.
9. Enable custom preview for internal/canary shops, then custom install/publish after failure rate, validation time, model/image spend, and browser-gate telemetry meet explicit launch thresholds.
10. Cut the Store builder over from `templateGenerationBrief()` / current StoreGen for all new builds. Retain the old endpoint only for named legacy/internal callers until telemetry proves it removable.

Feature flags/kill switches are independent: `STOREFRONT_BUNDLE_READ`, `STOREFRONT_RECIPE_BUILD`, `STOREFRONT_BUNDLE_PUBLISH`, and `STOREFRONT_CUSTOM_BUILD`. Database migrations and legacy capture land before readers; readers land before writers; writers land before publish. Rollback signals include increased render/bridge errors, checkout conversion regression, CSP violations, validation false positives, generation failure/spend regression, or any cross-shop/pointer invariant failure.

Recipes should ship before the custom compiler so the runtime and commerce contract are proven against deterministic artifacts. The custom compiler then authors against a stable, tested language rather than inventing its runtime while generating stores.

## 19. Acceptance criteria

This project is complete when:

1. The ten niche recipes and Atelier Grid are all selectable and auto-recommended through the documented resolver.
2. Every recipe preview uses the logged-in merchant's real store/catalog data and supports the complete commerce surface contract.
3. Explicit original/no-template prompts invoke the new AI Storefront Compiler, not the current StoreGen.
4. Ambiguous prompts route to custom rather than an irrelevant recipe.
5. Custom generation produces a coherent, materially original six-route storefront bundle with distinct fonts, imagery, icons, layouts, scroll behavior, and interactions.
6. Recipe and custom stores pass the same binding, security, accessibility, browser, and commerce gates.
7. Public cart and checkout remain server-authoritative: totals are recomputed from trusted line snapshots while ownership, availability, inventory, shipping, tax, consent, order creation, and payment are revalidated by platform services.
8. Draft installation, publish, and rollback are atomic at bundle level.
9. A failed generation never damages or partially replaces the merchant's current draft or published store.
10. Legacy stores continue rendering until the merchant successfully publishes a new bundle.
