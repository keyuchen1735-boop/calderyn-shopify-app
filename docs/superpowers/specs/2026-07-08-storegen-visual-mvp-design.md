# Storegen Visual MVP — Replit-style generation for every shop

**Date:** 2026-07-08
**Owner:** Eric
**Status:** Approved design, pre-implementation
**Branch:** `feat/storegen-visual-mvp`
**Relates to:** platform-pivot spec `2026-06-27-calderyn-platform-pivot-design.md` (feature #16, Step 7b — agentic store generator)

---

## 1. Problem — why generated previews look sparse today

It's a design choice, not a technical limitation — and it's fixable.

1. **The preview only renders the real catalog.** `app/lib/storebuilder/resolve-data.server.ts` pre-loads exactly the products/collections a page's blocks reference from the shop's actual catalog. There is no mock-data layer anywhere in the pipeline. This was deliberate (rule 12): every deep-link must point at a real handle — hallucinated product/collection links get rewritten to the shop home so nothing fake ever ships.
2. **Empty catalog = the generator barely runs.** In `app/lib/storegen/generate.server.ts:131`, if a shop has zero products, zero collections, no brief, and no reference images, the LLM calls are skipped entirely (`skipLlm`) and the run degrades to the deterministic fallback — a text-only skeleton. Product grids and the buy-box render nothing when the list is empty (`blocks-product.tsx:81`) rather than showing sample cards.
3. **Image generation exists but is narrowly wired.** The `ImageProvider` seam (`app/lib/storegen/imagery/`, Higgsfield-backed) generates *listing* images on demand (`enhanceListing`), persisted to owned storage and applied at read time via `applyAssetOverrides` (already wired into the draft preview). But hero images are optional — no safe `imageUrl` → classic text hero (`blocks.tsx:40`) — and nothing auto-generates imagery during a generation run.
4. **A product with no image renders nothing.** `blocks-product.tsx:107`: no `images[0]` → no element at all in the card's image slot. Pre-image cards are bare title + price.

### 1.1 The fx machinery fires — the taste is the failure

The platform already has a full "stunning moving" stack (`app/lib/storebuilder/fx/`): LLM-authored **WebGL shaders** (`data-fx-shader` — animated GLSL backgrounds with brand-palette uniforms) and **GSAP motion choreography** (`data-fx-motion`). Sanitized (the sanitizer allowlists `data-*`), capped (2 shader hosts / 8 motion hosts), lazy-loaded, hydrated by `RawHtmlBlock` → `hydrateStoreFx`. The studio preview (`dashboard.store.preview.tsx`) is a real hydrated Remix route framed with `sandbox="allow-same-origin allow-scripts"`, so effects mount there too.

Verified against prod (`page_document`, 2026-07-08): the two newest generated home docs **do** carry both `data-fx-shader` and `data-fx-motion`. The plumbing is intact end-to-end. What the model authors through it is the problem:

- **The shader is a near-copy of the prompt's own example.** `prompts.ts:145` shows a sample shader with `u_time*0.08` mixing three colors; the generated one is `t=u_time*0.08` mixing three colors. At that speed the animation is imperceptible — it reads as a static block.
- **The palette is monochromatic.** The newest generated home is `#052e16 / #166534 / #bef7d0` — three greens. Hero = green gradient, statement = dark green block, cards = green tints. Even a working shader blending shades of one hue looks like a flat color field.
- **Zero imagery anywhere.** The rawHtml home path was explicitly designed to "look fully designed WITHOUT depending on product imagery" — right call when no images existed, but it institutionalized the color-block look.
- The prompt marks fx as *"optional… use with restraint: none is fine"* (`prompts.ts:135`), so on many runs the model plays it safe and emits plain blocks; on empty-catalog runs the LLM never runs at all (point 2 above), so the fx pipeline is dead on arrival for exactly the shops that need to be wowed.

## 2. Decisions (made 2026-07-08)

| Decision | Choice |
|---|---|
| Empty-catalog runs | **Always call the LLM** — remove the `skipLlm` short-circuit; deterministic fallback remains only for actual API failures |
| Where demo products live | **Real seeded catalog rows** (Replit 1:1) — not preview-only mocks |
| Sample marking | Reserved tag **`calderyn:sample`** on the existing `tags` array — no `is_sample` migration (`ponytail:` simplification) |
| Product + hero images | **AI-generated, async fill-in** via existing Higgsfield `store_asset` pipeline; instant styled placeholders, crossfade on ready |
| Moving visuals | **Mandatory, not optional** — shader hero + motion floor on every generated home |

## 3. Design

### 3.1 Seed stage (generate.server.ts)

- Remove the `skipLlm` short-circuit. Every run calls the model.
- New stage before brand, only when `products.length === 0`: **`seed`** — one LLM call invents a demo catalog from the brief/reference images (or a generic-but-tasteful one when there's neither): 2–3 collections + 6–9 products (title, description, price, tags, option/variant where it makes sense, collection assignment), plus per-product visual hints (§3.3).
- Write through the existing `createCollection` / `createProduct` in `app/lib/catalog/catalog.server.ts` — no new write path. Each product carries the `calderyn:sample` tag and `status: "active"` (so the storefront preview renders them; the sample chip in §3.6 is the guardrail).
- Re-fetch the catalog after seeding so brand/home/collection/PDP stages, the link-safety set, and the menu all build against **real handles** — PDPs, grids, and cart work 1:1 with zero renderer changes.
- Deterministic fallback if the seed call fails or returns junk: a small hardcoded seed catalog (fallback.ts pattern) so the run still produces a full store; the degraded run is surfaced in the existing verification report (rule 12).

### 3.2 Async imagery — reuse the `store_asset` pipeline as-is

- After generation returns, the studio client calls an image-fill endpoint (`requireDashboardSession` + `requireSameOrigin`) that runs the existing `enhanceListing()` (Higgsfield → `persistExternalImage` → `store_asset` upsert) per sample product.
- **The hero lifestyle image is generated FIRST**, before any product image, in `lifestyle_scene` mode prompted from the brand plan (store name, tagline, vibe, top collection) — the most-viewed visual lands in ~60–90s. When ready it is patched into the home doc's hero slot via `saveDraft`.
- Preview already applies `applyAssetOverrides()`, so images swap in on refetch — the store paints instantly with placeholder art and fills in over ~1–2 min. No new infra, no background workers on Vercel.

### 3.3 Description-aware placeholder art (not color blocks)

A product with no image currently renders nothing; placeholders must relate to the product, be instant, and cost zero requests:

- **Seeded products:** the seed LLM emits two extra fields per product in the same call — `iconHint` (a name from the Lucide/`CDIcon` registry: `coffee`, `shirt`, `gem`, `lamp`, …) and `phTone` (warm/cool/neutral hue nudge) — so a "Stoneware Pour-Over Mug" shows a coffee glyph on a warm tile, not a random initial.
- **Real shops with image-less products:** a ~20-line keyword→icon map over title/description gives the same effect (fallback: product initial).
- **Tile rendering:** `cd-product-card__ph` element in the image slot — deterministic composition from `hash(product.handle)` + store palette feeding inline CSS custom properties (`--ph-hue`, `--ph-angle`); layered gradient mesh + large glyph in the vibe's display type. Vibe-aware shapes: `minimal` → soft radial duotone; `bold` → hard diagonal fields; `playful` → offset blobs. Two products never look identical; everything stays on-brand.
- **Shimmer on pending:** while a `store_asset` generation is in flight the tile gets a slow sheen — "image coming," not "image missing." Real image crossfades in on ready.
- Same code path improves real shops with image-less products — no sample special-casing.

### 3.4 Opening-site visual — the home page is the flagship

- **Pre-image hero is never a text block:** palette gradient mesh + seeded collection icons as a subtle motif + the generated headline in the vibe's display type. Designed launch page at second zero, not a loading state.
- The generated home doc always leads hero → featureRow (3 value props the LLM writes) → productGrid, so the opening viewport has structure before any image exists (prompt/ordering constraint — no new blocks).
- Hero lifestyle image lands first (§3.2) and crossfades in.

### 3.5 Mandatory motion + taste layer (prompts.ts)

- **Shader hero by default:** the home prompt *requires* an animated shader hero (palette-fed GLSL over a designed gradient fallback) unless the vibe explicitly calls for stillness, plus one accent section. Restraint language stays for everything else.
- **Motion floor:** every generated home includes at least one `data-fx-motion` entrance (hero type reveal + card stagger). Reduced-motion users get the resting state — already handled by the runtime.
- **Diverse, high-quality shader examples:** replace the single slow example with 2–3 distinct ones (grain/noise, aurora mesh, marching gradients) and an explicit floor — "motion must be clearly visible within 2 seconds" — plus a ban on copying examples verbatim. Same diversification for motion specs (current outputs are all the same fade-up).
- **Palette contrast requirement** in the brand stage: accent hue ≥90° from the base hue, or an explicit neutral+accent scheme — no more three-shades-of-green pages.
- **Imagery-slotted rawHtml:** the home prompt composes around image slots (hero lifestyle image, texture band, product grid) that the async pipeline fills — instead of designing imagery out.

### 3.6 Sample-ness surfaced, not hidden

Studio shows a "Sample products — replace with your own" chip when `calderyn:sample` products exist, with a one-click clear (delete products carrying the tag).

## 4. Not doing (YAGNI)

- Per-product image regeneration UI
- Sample-product editing flows (the normal product editor already handles them)
- Blocking image-generation mode
- Bloom provider swap
- `is_sample` schema migration (tags cover it)

## 5. Testing & verification

- Unit: seed-plan parser (junk/partial JSON → fallback), fallback seed catalog, `calderyn:sample` tag filtering + clear endpoint, keyword→icon map, placeholder hash determinism, image-fill endpoint auth.
- Existing storegen test suites extended for the removed `skipLlm` path and the new stage order.
- **Browser verification (verification-loop):** in the studio preview, confirm the shader canvas actually mounts and visibly moves (chrome-devtools), motion entrances play, placeholder tiles render per-product glyphs, and a Higgsfield-ready image crossfades in. Attribute-in-DB is not sufficient evidence.
- Pre-commit gate per CLAUDE.md (typecheck, lint, build, /code-review) before merge.
