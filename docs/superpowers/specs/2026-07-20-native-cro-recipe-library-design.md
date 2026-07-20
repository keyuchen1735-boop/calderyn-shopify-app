# Native CRO Recipe Library and Ten Storefront Recipes

**Date:** 2026-07-20  
**Owner:** Eric  
**Status:** Approved design, pending written-spec review  
**Branch:** `feat/native-cro-recipes-v2`

## 1. Decision

Add ten production storefront recipes to Calderyn's native recipe/compiler/runtime system. They are new recipe identities alongside the existing eleven, not aliases, replacements, versions, or reskins.

The work also starts a reusable recipe component and media library for these ten recipes and future recipes. The library shares trusted commerce, media, accessibility, and motion behavior; each recipe continues to own its DOM, CSS, typography, copy, rhythm, and niche-specific composition.

The new recipes are:

| ID | Niche | Identity | Signature conversion mechanic |
|---|---|---|---|
| `volt` | Premium wireless audio | System-first architecture with a cinematic rim-lit hero | Spec comparison and ecosystem builder |
| `atelier` | Elevated apparel basics | Garment fit laboratory and calm fabric studies | Fit finder and size-confidence evidence |
| `gilt` | Minimal gold jewelry | Intimate object ceremony | Gifting flow and engraving personalizer |
| `larder` | Pantry staples | Tactile working pantry | Subscribe-and-save, reordering, build-a-box |
| `ember` | Hot sauce and snacks | Blackened tasting counter and heat spectrum | Heat selector, tasting flights, UGC |
| `roast` | Specialty coffee | Origin and brew notebook | Grind selector, brew quiz, cadence picker |
| `fizz` | Functional soda | Modular flavor playground | Variety pack, flavor quiz, first-box offer |
| `forge` | Pro hand tools | Jobsite blueprint and exploded specifications | Compatibility filter and project bundles |
| `haven` | Modular furniture | Spatial quiet and material studies | Room-fit checker, delivery estimate, swatches |
| `glow` | Clinical skincare | High-key clinical light and liquid macro | Skin quiz, routine builder, evidence comparison |

### 1.1 Universal single-product routing

In automatic mode, a merchant with exactly one active product resolves to the internal `volt` recipe before niche scoring. Explicit merchant choices still win: a manual recipe override or explicit custom-build request is never replaced by the catalog-size rule.

`volt` is therefore a universal single-product composition, not an audio-only storefront. Its cinematic hero, comparison rhythm, proof architecture, and ecosystem builder remain, while product name, description, imagery, variants, specifications, compatible additions, policies, and niche language come from live merchant data. Audio-specific fixture copy is proof-only and never appears in another merchant's store.

## 2. Why this is native, not a Next.js monorepo

Store Builder previews and publishes immutable, compiler-validated HTML/CSS/interaction bundles with `data-cd-*` bindings. Ten independent Next.js applications would create a second runtime and would not install faithfully into Store Builder.

The source prompt's framework choices are therefore translated into native Calderyn equivalents:

- App Router pages become compiled storefront routes.
- React/Zustand commerce state becomes trusted Calderyn cart and checkout slots.
- Tailwind styling becomes recipe-owned scoped CSS.
- GSAP, Lenis, and Framer Motion become a trusted declarative motion runtime. Recipe-authored arbitrary JavaScript remains forbidden.
- A mock checkout becomes Calderyn's real protected checkout flow.
- JSON seed catalogs exist only as deterministic proof fixtures. Production content always comes from the logged-in merchant's live catalog and commerce services.

## 3. Goals

- Deliver ten visually and structurally distinct, production-ready recipes.
- Preserve the merchant's live products, collections, images, variants, prices, availability, inventory presentation, reviews where available, policies, and store identity.
- Provide complete Home, Collections Index, Collection, Product, Search, Story, Cart, Checkout, and 404 experiences for every new recipe.
- Generate and ship three coherent videos per recipe: `hero`, `hero-alt`, and `pdp-detail`, each with MP4, WebM, poster, and gradient fallback.
- Make preview render the same compiled bundle and exact asset hashes as publication.
- Start a small reusable component/media library that future recipes can pull from without collapsing into a shared visual template.
- Prove behavior through public compiler, renderer, preview, and storefront interfaces using vertical TDD slices.

## 4. Non-goals

- Retrofitting or visually changing the existing eleven recipes.
- Exposing template names or selection mechanics to merchants; recipes remain an internal Store Builder implementation detail.
- A generic page-builder DSL or arbitrary HTML/JavaScript execution.
- Inventing reviews, scarcity, shipping promises, subscription availability, product compatibility, or other conversion claims when the merchant has not supplied supporting data.
- Checking large generated video binaries into Git.
- Showing proof-fixture product photography in a merchant storefront.

## 5. Route contract

The existing Home, Collection, Product, Search, Cart, and Checkout routes remain required. The compiled bundle contract gains optional `collections`, `story`, and `notFound` routes so old recipe versions remain valid without modification.

All ten new recipes provide every route. Platform routing selects the optional compiled surface when present and uses the existing platform fallback when absent. The 404 surface is visual only; HTTP status remains platform-owned. Checkout forms, payment methods, pricing, tax, shipping, and order creation remain protected platform authority.

Metadata and structured data remain platform-owned and are derived from live merchant/product data. New recipes receive route-specific title/description/OG presentation plus Product, Offer, and Review JSON-LD when the underlying facts exist.

## 6. Recipe component library

Create a small library under `app/lib/storefront-recipes/library/`. Its public concept is a typed `RecipeFragment`: scoped HTML, scoped CSS, declarative interaction requirements, live-data requirements, protected-slot requirements, and logical asset requirements.

The library initially contains only behaviors used by at least two of the new recipes:

- Poster-first video hero/detail media.
- Review summary and proof band.
- Product rail/carousel and horizontal marquee.
- Sticky desktop purchase area and mobile purchase bar.
- Cart drawer free-shipping progress and order bump.
- Accessible disclosure, comparison, and before/after controls.
- Exit-intent email/SMS capture trigger.
- Scroll progress, reveal, parallax, count-up, and pinned-section declarations.

Recipes explicitly compose fragments and supply recipe-owned wrappers, classes, copy, tokens, and layout. The library does not choose sections, generate a page skeleton, or expose a universal card component. A niche mechanic stays local until a second real recipe needs the same behavior.

## 7. Trusted niche mechanics

Recipe code may present niche-specific controls, but any mutation of commerce truth routes through protected platform slots/actions:

- `volt`: compare live specifications and add compatible products as a system.
- `atelier`: recommend size from declared garment/fit facts and retain the chosen variant.
- `gilt`: attach validated engraving, gift note, wrap, and recipient metadata to the cart line.
- `larder`: choose an available selling plan, build a bounded multi-line box, and expose reorder reminders only when enabled.
- `ember`: filter by merchant-supplied heat facts and add a tasting-flight bundle.
- `roast`: map brew answers to catalog tags/options, retain grind selection, and choose an available cadence.
- `fizz`: assemble a bounded variety pack and apply only a real eligible first-box offer.
- `forge`: filter and bundle only from merchant-supplied compatibility/project facts.
- `haven`: calculate room fit from declared product dimensions, show real delivery estimates, and add available swatch SKUs.
- `glow`: map skin answers to merchant-supplied concern/ingredient facts and choose available replenishment plans.

Unsupported capabilities disappear cleanly. Preview fixtures exercise the complete mechanic; production never displays a false claim or unusable control.

## 8. Media asset library

Generated media is stored in Calderyn-owned object storage using immutable content-addressed keys. Checked-in recipe manifests record:

- Logical key and recipe/version ownership.
- SHA-256 content hash, media type, byte size, dimensions, and duration where applicable.
- Generation brief identity and asset provenance.
- MP4, WebM, poster, and gradient-fallback relationships.
- Visual-quality approval keyed to the exact master hash.

Recipe-owned media covers heroes, editorial environments, textures, and detail studies. Merchant product photography always binds to the live catalog. When a merchant product has no usable image, the existing owned-asset fill path may generate one with Gemini and persist it as merchant-owned media; a recipe never substitutes its proof-fixture product shot.

The compiler accepts safe video markup only through the trusted media contract. The renderer resolves logical keys; recipes never embed generated URLs. The playback controller enforces `muted`, `autoplay`, `playsinline`, `loop`, poster-first loading, off-screen pause/resume, and reduced-motion behavior.

The low-motion fallback is the pinned poster. If the poster cannot load, recipe-owned CSS renders the declared gradient. A missing, unsupported, unapproved, or hash-mismatched required media asset blocks draft installation and publication.

## 9. Media briefs, generation, and visual quality

Each recipe owns `video-brief.md` with exactly three sections using the requested `[VIDEO BRIEF — <slug> / <role>]` format:

- `hero`: 8-12 second seamless brand loop with a calm top-left headline zone.
- `hero-alt`: lifestyle/environment context with the same product identity and art direction.
- `pdp-detail`: macro material, ingredient, finish, or mechanism study.

Proof and recipe-owned stills are generated through the configured Gemini API using a reference chain: establish one canonical product or material identity, then generate variants and accessory scenes from that approved reference. Video generation uses the configured Gemini video endpoint with the same art direction; if the account lacks video-model access, the task fails loudly instead of silently substituting unrelated footage. Secrets remain in ignored `.env.local` files and never enter source, logs, manifests, or browser bundles.

Generation output is provider-independent after creation. The existing import path normalizes approved masters, derives MP4/WebM/poster variants, hashes them, and persists them through Calderyn-owned storage. Static review pages run from a no-HMR server and are opened once after a coherent asset set passes review.

Art direction follows the approved identity table. `volt` specifically uses the approved hybrid: system-first commerce composition with a dark cinematic rim-lit hero.

Video GREEN requires both deterministic and judgment-based proof:

1. Technical proof verifies duration, dimensions, supported codecs, MP4/WebM/poster presence, byte bounds, hashes, playback, and loop-boundary integrity.
2. Full-loop visual review verifies stable product identity and geometry, coherent motion, no morphing/flicker/exposure pumping, no accidental text/logos/close faces, correct niche art direction, low-noise headline space, and a visually clean loop.
3. Approval is stored against the exact master hash. Any replacement invalidates approval.
4. Failed clips are regenerated; a poster fallback never converts a failed video into a passing asset.

Still-image GREEN uses the same identity standard: coherent geometry and materials across hero, listing, product-detail, and bundle scenes; no accidental text, logos, duplicate parts, implausible accessories, or mismatch with the approved hero product.

## 10. Preview and publication data flow

1. A recipe composes typed fragments and declares live-data, slot, interaction, and asset requirements.
2. Generated output is normalized into the required formats, visually approved, hashed, and uploaded.
3. Compilation validates safe markup, bindings, routes, interactions, accessibility-critical attributes, and complete media manifests.
4. Draft installation pins the compiled bundle version and exact asset hashes.
5. Preview resolves that saved immutable bundle, injects the logged-in merchant's live presentation data, and resolves the pinned assets.
6. Publication promotes the same validated artifact; it does not rebuild or reinterpret the recipe.
7. Recipe/media changes require a fresh draft/install. Existing drafts and releases remain unchanged.

## 11. Motion and performance

Recipes declare motion; the trusted runtime executes it. Supported declarations cover video progress/scrubbing, pinned storytelling, reveal-once grids, horizontal galleries, sticky PDP media, long-form progress indicators, parallax layers, marquees, and proof count-ups.

The runtime batches reads/writes, animates transform/opacity, uses `will-change` only during active motion, pauses off-screen video, and disables nonessential motion under `prefers-reduced-motion`. Posters load before video. Every media element declares stable dimensions/aspect ratio. Performance targets remain CLS below 0.1 and LCP below 2.5 seconds on representative mobile proof runs.

## 12. Conversion and content integrity

Every new recipe includes:

- A single dominant above-fold CTA and nearby real social proof when available.
- Live stock/shipping urgency only when backed by commerce data.
- Risk reversal near purchase controls from real merchant policies.
- Sticky desktop/mobile purchase controls with 44px minimum tap targets.
- Cart drawer, shipping-threshold progress, and eligible order bump.
- Exit-intent email/SMS capture with a merchant-configured incentive; never on initial load.
- Semantic landmarks, keyboard/focus behavior, AA contrast, and accessible names/state.
- Live Product/Offer/Review structured data where facts exist.

Fixed proof fixtures contain at least 16 realistic products and four collections per recipe, including variants, inventory, reviews, policies, and niche facts. Fixture content proves layouts and behavior only and never leaks into a merchant storefront.

## 13. Failure behavior

- Compiler errors name recipe, route, component, and logical asset/binding where applicable.
- Missing or mismatched required assets block installation/publication.
- Network playback failure falls back to poster, then gradient; it does not mutate the pinned artifact.
- Missing optional merchant data hides the dependent claim/control without leaving broken layout.
- A preview proof, accessibility, route, or visual-quality failure blocks integration.
- Screenshot and video approval baselines are never automatically updated to make failures pass.
- Existing recipe versions and saved drafts remain regression fixtures throughout the work.

## 14. TDD strategy

Use vertical RED-GREEN-REFACTOR slices through public interfaces. Do not write all tests before implementation and do not mock internal compiler/runtime modules.

1. Tracer: a library video hero fails through compile/render/preview; implement the minimum trusted video path until it passes.
2. Add one failing asset-integrity/fallback behavior at a time, then make it pass.
3. Add one failing optional-route behavior at a time, then make it pass without changing old bundles.
4. Build `volt` end to end as the exemplar, testing observable live-catalog, CRO, media, and reduced-motion behavior.
5. Extract only proven shared fragments, keeping the suite green after each extraction.
6. Build each remaining recipe one at a time inside its isolated task, adding the next behavior test immediately before its minimum implementation.
7. Run focused tests, the representative browser-proof slice, dense `storefrontProofContext(27)`, and then the full route/viewport matrix.

Final gates are the repository code review, patch sanity, serial test suite, typecheck, lint, production build, storefront bundle verifier, visual/media approvals, and preview/live-route smoke.

## 15. Parallel and subagent execution

All work starts from current `origin/main` in isolated worktrees. The shared compiler/runtime/library contract is implemented and reviewed serially first, then frozen for recipe lanes.

With three worker slots available, recipe work runs in waves:

1. `volt`, `atelier`, `gilt`
2. `larder`, `ember`, `roast`
3. `fizz`, `forge`, `haven`
4. `glow` plus integration cleanup

Each recipe implementer owns only its recipe folder, proof fixture, briefs, and asset manifest/approval artifacts. Shared registry/type changes are prepared in the core lane or a serialized integration task, preventing worktree conflicts.

Every task uses a fresh implementer, self-review, committed focused diff, generated review package, and a separate reviewer for both spec compliance and code quality. Critical or Important findings return to a fixer and re-review. Approved commits are integrated only after review. The completed branch receives one broad final review and one full verification run.

## 16. Completion criteria

The project is complete only when:

- All ten new recipe IDs are registered alongside the existing eleven.
- Automatic routing selects `volt` for exactly one active product while preserving explicit merchant overrides.
- Every new recipe provides all nine routes and its niche mechanic through trusted commerce behavior.
- The new library is consumed by the ten recipes without imposing shared visual composition.
- All 30 briefs and 30 coherent approved master videos exist, with MP4/WebM/poster/fallback derivatives pinned by hash.
- Preview and publication use the same immutable bundle/assets, and fresh-install behavior is proven.
- Fixed and dense live-catalog fixtures render without missing, repeated, clipped, or stale content.
- Focused tests, full serial tests, typecheck, lint, build, bundle proof, accessibility, media proof, and live smoke are green.
- No existing recipe or saved release changes unexpectedly.
