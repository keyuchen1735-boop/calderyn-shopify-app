# Visual Store Builder — Sub-project 1: Agentic Generator (#16) + Page-Type Rollout + Conversion Imagery

**Date:** 2026-06-29
**Owner:** Eric
**Status:** Design agreed in brainstorming (2026-06-29). Per-phase implementation plans follow via writing-plans.
**Relates to:** `docs/superpowers/specs/2026-06-29-visual-store-builder-design.md` (architecture-of-record; this is its sub-project 1) and the spine plan `docs/superpowers/plans/2026-06-29-visual-store-builder-spine.md` (sub-project 0, which froze the block contract). Implements master pivot spec §#16 (agentic generator), pulls forward §#9 (Higgsfield imagery) as a bounded slice, and lands the page-type rollout the spine deferred.

---

## Decision (founder, 2026-06-29)

Build the generator across **all page types** in one combined, three-phase spec, with maximum agentic freedom and a conversion-imagery feature:

1. **All page types now** (home singleton + collection template + PDP template) — pulls the spine's deferred "page-type rollout" (new blocks + template rendering + functional invariant) into this sub-project as **Phase A**.
2. **Generator pipeline** with **full props + layout** freedom for Claude, made safe by a deterministic validate/repair layer and isolated per-doc fallback — **Phase B**.
3. **Conversion imagery** via Higgsfield for **selected weak listings** (detector-flagged, merchant-selected — never a blind full-catalog pass) — **Phase C**.

This deliberately overrides two design-spec defaults, recorded here per rule 7:
- The spine plan deferred the product/functional blocks + collection/PDP rendering to a *separate* slice → **pulled into Phase A**.
- The design spec chose a fixed "layout preset" (line 101) → **superseded by full-props freedom + a sanitize/repair layer** (below).
- The design spec deferred imagery to a later #9 (line 170, "single imagery-source seam") → **the seam is built and a bounded v1 ships in Phase C**.

---

## Grounding (verified in-repo)

**Frozen contract (reuse, do not redesign)** — `app/lib/storebuilder/*` on `feat/store-builder-spine`:
- `types.ts`: `BlockDocument`, `Block`, `GridCell`, `DocKind`, `PageKey`, `BlockFlavor`, `BlockType`, `RenderData`, `RenderContext` (carries optional `record`), `CatalogRefs`, `BlockMeta`.
- `blocks.tsx`: 6 starter blocks (`hero · richText · image · button · productGrid · collectionList`).
- `registry.ts` (`BLOCK_REGISTRY`, `getBlockMeta`), `validate.ts` (`validateDocument`, `ValidIds`, `DroppedRef`, `requiredFunctionalBlocks`), `render.tsx` (`renderBlocks`), `default-doc.ts`, `resolve-data.server.ts` (`resolveRenderData`), `page-document.server.ts` (`loadPublishedDoc/loadDraftDoc/saveDraft/publishDoc`).

**Claude harness (reuse, no new model infra)** — `app/lib/assistant/anthropic.server.ts`: `getAnthropic()` (usage-instrumented), `digestModel()` → `claude-haiku-4-5`. The idiom to mirror: `app/lib/github-digest/summarize.server.ts` (Haiku → JSON-only system prompt → tolerant `parseAi` → deterministic fallback → `mode: "ai" | "template"`) and the engine's locked-contract discipline `engine/calderyn_engine/claude_layer.py` (HARD-RULES system prompt, untrusted-evidence wrapping, `_assert_covers_input`, deterministic `_fallback`, template-only skip).

**Catalog read contract** — `app/lib/storefront/catalog.ts` (`StorefrontCatalog`: `listProducts/getProduct/listCollections`; `StoreProduct/StoreVariant/StoreCollection`). Fixture stub now; John's owned impl (§#5) later behind the same interface.

**Settings stub** — `app/lib/storefront/settings.ts` (`StoreSettings { storeName, logoUrl, palette }`, hardcoded `getStoreSettings`). This sub-project is its **first real writer** (spine plan line 24).

**Storefront SSR routes** — `app/routes/storefront.*` (home wired to the spine on the branch; collection / PDP / cart / checkout / confirmation exist). PDP already has an **add-to-cart form** (commit `2e9d336`) backed by the shipped cart cookie + add-to-cart action — the functional `addToCart` block renders against that, it is not net-new commerce.

**Imagery providers available** — Higgsfield (`higgsfield-product-photoshoot` skill / CLI, conversion-oriented modes: `product_shot`, `lifestyle_scene`, `hero_banner`, `ad_creative_pack`) and Bloom (MCP). Higgsfield is the Phase-C impl; Bloom is a later swap behind the same seam.

**NET-NEW:** the 5 rollout blocks + template wiring (Phase A), the `app/lib/storegen/*` generator (Phase B), the imagery seam + detector + Higgsfield impl (Phase C), four shop-scoped tables (`store_settings` promotion, `store_generation`, `store_generation_proposal`, `store_asset`), and a generate action + read-only draft-preview route.

---

## Phase A — Page-type rollout (prerequisite; additive contract extension)

Makes collection + PDP documents renderable, so Phase B has something to generate *into* that actually renders. Purely additive to the frozen contract — the sanctioned extension path the spine's `types.ts` comment names ("a new block type = a new registry entry").

### A1. New block types (widen the `BlockType` union)
- **functional:** `addToCart · variantPicker · price` — wired to the existing cart/checkout (#2/#3). Read `ctx.record.product.variants`.
- **template-dynamic:** `productGallery` (→ `ctx.record.product.images`) · `collectionGrid` (→ `ctx.record.collection` products).

Add these as new `BlockMeta` entries in a new module `app/lib/storebuilder/blocks-product.tsx` (keep `blocks.tsx` focused; the registry assembles from both arrays). Each declares `flavor`, `allowedDocKinds`, `defaultProps`, `defaultLayout`, tolerant `validateProps`, `catalogRefs` (template blocks carry **no** hardcoded ids — they read the record), and an isomorphic `Component`.

### A2. Template rendering
`renderBlocks(doc, ctx)` already accepts `ctx.record`; no signature change. The new dynamic/functional components read `ctx.record.product` / `ctx.record.collection`. A template block rendered with no record degrades to empty (never throws) — consistent with the renderer's defensive contract.

### A3. Storefront wiring
The collection route and PDP route load the published **template** doc → `resolveRenderData` → `renderBlocks` with `record` = the current product/collection (resolved via `StorefrontCatalog`). When a shop has no template doc, fall back to the route's current rendering (never blank). `resolveRenderData` extended so template docs resolve the current record (not hardcoded ids).

### A4. Functional-block invariant (turn it on)
`requiredFunctionalBlocks('pdp')` returns `['addToCart','variantPicker','price']` (was vacuous). `validateDocument.missingFunctional` now reports real gaps; enforced at publish (and by Phase B's generator guarantee). The buy path is sacred (rule 12): a PDP template missing any required functional block fails publish visibly.

---

## Phase B — Generator pipeline (`app/lib/storegen/*`, server-only)

`generateStore({ shopId, mode: 'brief' | 'catalog', brief? }): Promise<GenerationResult>` — deterministic control flow (rule 5). Orchestration is **staged (brand → per-doc)** for cross-page brand coherence + isolated fallback.

### B1. Inputs & catalog menu
Load catalog facts via `StorefrontCatalog` (shop-scoped). Build a **catalog menu** (real product ids/handles/titles, collection handles/titles) handed to Claude so it can only reference real things, and the `ValidIds` set used for validation. **Empty catalog** → compose chrome + structural defaults only; `store_generation` flagged `no_products` (rule 12); still publishable.

### B2. Stage 1 — brand (1 Haiku call → `store_settings`)
Locked JSON contract → `{ storeName, palette, voiceTagline }`. Tolerant parse; deterministic fallback (derive name from shop, default palette/voice). Writes the promoted `store_settings` row. The brand is threaded into every Stage-2 call so copy stays on-brand.

### B3. Stage 2 — per-doc block generation (1 Haiku call per doc kind, isolated)
For each kind ∈ {`home` (singleton), `collection` (template), `pdp` (template)}, one Haiku call emits a **`BlockPlan`** (full props + layout) fed: the Stage-1 brand, the catalog menu, and — in `brief` mode — the merchant brief **wrapped as untrusted evidence** (no instruction-following; prompt-injection containment). Each doc is processed **independently**:

1. **Parse** — tolerant, fenced-JSON aware (mirror `parseAi`).
2. **Validate + repair** — `validateDocument` drops unknown block types, blocks used on a disallowed doc-kind, and **fabricated catalog ids**, logging every drop (rule 12). Then a **layout sanitizer** clamps each `GridCell` to the 12-col grid (`0 ≤ x`, `1 ≤ w ≤ 12`, `x+w ≤ 12`, `h ≥ 1`, `y ≥ 0`); overlaps are harmless because `renderBlocks` orders by `y`-then-`x` into a vertical flow. **Copy length bounds** truncate over-long strings. Each block's tolerant `validateProps` fills defaults / coerces.
3. **Functional-block guarantee (PDP)** — inject `addToCart` + `variantPicker` + `price` from defaults if Claude omitted any. Never an unbuyable PDP.
4. **Fallback (isolated)** — on parse / validation-empty / API error / timeout / token-budget breach, compose a **deterministic fallback doc for that kind only** from catalog facts + `defaultProps`/`defaultLayout`. A malformed PDP plan never loses the good home doc.

### B4. Persistence & audit
Write each validated doc to `page_document.draft_json` via the spine's `saveDraft` (reuse; never publish — no auto-publish). Record:
- `store_generation` — run row: `source` (`brief`/`catalog`), `brief_text`, `model`, `status` (`draft`/`failed`/`no_products`), `token_cost`, per-doc fallback flags.
- `store_generation_proposal` — the **raw pre-validation BlockPlan** per run (audit; diff against the cleaned doc).

Per-run token budget (rule 6) → on breach, stop calling Claude, fall back, and log. The `BlockPlan` is a TS type + a HARD-RULES system prompt (allowed block-type enum, length bounds, ids only from the menu, JSON only); validators are the second line of defense.

---

## Phase C — Conversion imagery (Higgsfield; selected weak listings)

### C1. `ImageProvider` seam
`app/lib/storegen/imagery/provider.ts`: `interface ImageProvider { generateListingImage(req): Promise<{ url: string }> }`. Higgsfield impl (`higgsfield.server.ts`) calls the product-photoshoot path with a conversion mode (`product_shot` / `lifestyle_scene`). Bloom is a later swap behind the same interface. All generated URLs flow through this one seam so blocks, editor, and storefront never care about provenance.

### C2. Improvement detector (deterministic, rule 5)
`findImprovableListings(catalog) → ImprovableListing[]` ranks products with weak imagery — **0 images · 1 image · no secondary/lifestyle shot** — each with a `reason`. Pure heuristics; not the model's job. This is the "selected products that can be improved" gate — never the whole catalog.

### C3. Selection (not automatic)
The detector's candidates are surfaced in the draft preview (C5) with a per-item **"enhance"** action, bounded by an image budget. Only candidates the merchant/operator selects call Higgsfield. No blind full-catalog re-shoot.

### C4. Generation → seam → override
Each selected candidate → `ImageProvider.generateListingImage` → URL persisted to `store_asset` (shop-scoped, product-keyed, `source`, `status`). `resolveRenderData` / the catalog read path consult `store_asset` and **override** that product's image with the generated one. Async; **image budget** (rule 6); on failure/over-budget → keep the source image + log (rule 12).

*Deferred within C:* hero/banner creative (the seam supports it; not in v1) and original concept imagery beyond product-photoshoot.

---

## Data (new tables; shop-scoped uuid `shop_id`; RLS mirroring `20260629100000_buyer_identity`)

```sql
store_settings(            -- promoted from the stub; first written by the generator (Stage 1)
  shop_id uuid pk references shops(id) on delete cascade,
  store_name text, palette jsonb, logo_url text, voice_tagline text,
  updated_at timestamptz not null default now());

store_generation(          -- run/audit (rule 12)
  id uuid pk, shop_id uuid, run_id text, source text check (source in ('brief','catalog')),
  brief_text text, model text,
  status text check (status in ('draft','failed','no_products')),
  token_cost int, created_at timestamptz default now());

store_generation_proposal( -- raw pre-validation BlockPlan, per run (audit)
  run_id text pk, shop_id uuid, plan_json jsonb, created_at timestamptz default now());

store_asset(               -- imagery seam
  shop_id uuid, product_id text, source text, url text,
  status text, created_at timestamptz default now(),
  primary key (shop_id, product_id, source));
```

All four: RLS `shop_id = current_shop_id()`, `revoke all ... from anon, authenticated`, reached only via the service-role client threading `shop_id`. Migrations numbered after commerce-core. `getStoreSettings` is rewired from the hardcoded stub to read `store_settings` (a **sync → async** change — update every caller; this is the change the spine deliberately deferred here).

---

## Trigger + preview (this cycle, no editor yet)

- **Generate action** — a minimal `app/routes/dashboard.builder.generate` action: validate inputs, call `generateStore`, write drafts, redirect to the preview.
- **Draft-preview route** — read-only: loads `draft_json` for home/collection/PDP, `resolveRenderData` (a **sample record** for the templates), renders via the same `renderBlocks`, and lists the imagery candidates with per-item "enhance." Lets you *see* the generated store across all page types + improvable listings before the editor (#8, sub-project 2) exists.

---

## Cross-cutting

- **Error handling / safety (rules 5/6/12):** deterministic per-doc fallback; never-blank renderer; per-run token + image budgets; no auto-publish; PDP functional invariant; untrusted catalog/brief; id validation; every dropped id / skipped product / fallback / over-budget surfaced in `store_generation`.
- **Dashboard parity:** generator + imagery are merchant-facing → mirror the `generate` and `enhance` contracts on the dashboard stack (postgres / `withShopContext`) — match the contract, not the JSX. Phase-A storefront rendering is public/internal → parity-exempt (like the spine).
- **Testing (TDD):** vitest `node` env, mocked Anthropic + `ImageProvider`. Coverage: new-block render + `catalogRefs`; template rendering against a record; functional invariant non-vacuous; `BlockPlan` parse/validate/repair; layout clamp; id-drop logging; functional-block injection; per-doc isolated fallback; empty-catalog path; `store_settings` write + `getStoreSettings` async rewire; detector heuristics; seam override; token/image budget breach → fallback.
- **Execution context:** isolated worktree branched from the spine — `git worktree add ../calderyn-store-generator -b feat/store-generator feat/store-builder-spine`.

---

## File structure (decomposition)

| File | Phase | Responsibility |
|---|---|---|
| `app/lib/storebuilder/types.ts` | A | **Modify**: widen `BlockType` union (5 additive types). |
| `app/lib/storebuilder/blocks-product.tsx` | A | The 5 functional/template blocks (`addToCart·variantPicker·price·productGallery·collectionGrid`). |
| `app/lib/storebuilder/registry.ts` | A | **Modify**: assemble from both block arrays. |
| `app/lib/storebuilder/validate.ts` | A | **Modify**: `requiredFunctionalBlocks('pdp')` non-vacuous. |
| `app/lib/storebuilder/resolve-data.server.ts` | A | **Modify**: resolve the current record for template docs. |
| `app/routes/storefront.collections.$handle.tsx` / `storefront.products.$handle.tsx` | A | **Modify**: render published template doc per record (fallback to current). |
| `app/lib/storegen/block-plan.ts` | B | `BlockPlan` TS contract + parser. |
| `app/lib/storegen/prompts.ts` | B | HARD-RULES system prompts (brand + per-doc); untrusted-evidence wrapping. |
| `app/lib/storegen/sanitize.ts` | B | Layout clamp + copy length bounds + functional-block injection. |
| `app/lib/storegen/fallback.ts` | B | Deterministic per-doc fallback composer. |
| `app/lib/storegen/generate.server.ts` | B | `generateStore` orchestrator (Stage 1 → Stage 2 → persist → audit). |
| `app/lib/storegen/audit.server.ts` | B | `store_generation` + `store_generation_proposal` repo. |
| `app/lib/storefront/settings.server.ts` | B | Promoted `getStoreSettings` (async, reads `store_settings`) + writer. |
| `app/lib/storegen/imagery/provider.ts` | C | `ImageProvider` seam. |
| `app/lib/storegen/imagery/higgsfield.server.ts` | C | Higgsfield impl. |
| `app/lib/storegen/imagery/detector.ts` | C | `findImprovableListings` heuristics. |
| `app/lib/storegen/imagery/asset.server.ts` | C | `store_asset` repo + catalog override. |
| `app/routes/dashboard.builder.generate.tsx` | B/C | Generate action. |
| `app/routes/dashboard.builder.preview.tsx` | B/C | Read-only draft preview + enhance actions. |
| `supabase/migrations/2026*_store_generator.sql` | B/C | `store_settings`, `store_generation`, `store_generation_proposal`, `store_asset`. |

---

## What's cut / deferred

- **Editor (#8)** — sub-project 2 (drag-drop, inline edit, publish).
- **Full-catalog auto re-shoot** and **hero/banner imagery** — seam supports both; not v1.
- **Bloom provider impl** — seam ready, Higgsfield first.
- **Version history** beyond `draft_json`/`published_json`.
- **Responsive / per-breakpoint layouts.**

---

## Risks

- **Scope** — A+B+C is a multi-week lift. Mitigate: phase gating (A renderable → B generates → C enhances), isolated per-doc fallback, hard budgets.
- **Full-props freedom** → a large validation/repair surface. Mitigate: reuse `validateDocument` + the layout sanitizer + tolerant `validateProps`; the contract is unbreakable regardless of model output.
- **Higgsfield async / credits / auth** — image budget + seam + source-image fallback localize the blast radius.
- **`BlockType` union widening touches the "frozen" `types.ts`** — additive only; this is the sanctioned extension path, not a contract break.
- **John coordination** — `store_settings` table + catalog image-override seam; one heads-up, build behind `StorefrontCatalog`.

---

## Build order (phases; each its own writing-plans section)

1. **Phase A** — rollout blocks + template rendering + storefront wiring + functional invariant. *Gate: collection + PDP render from a doc.*
2. **Phase B** — `BlockPlan` contract, staged Haiku (brand → per-doc), sanitize/validate/repair, isolated fallback, audit tables, `store_settings` promotion, generate action + draft preview. *Gate: `generateStore` produces validated drafts for all 3 kinds; preview shows them.*
3. **Phase C** — `ImageProvider` seam + detector + Higgsfield impl + `store_asset` + enhance action. *Gate: selected weak listings get conversion imagery via the seam, budgeted, with fallback.*
