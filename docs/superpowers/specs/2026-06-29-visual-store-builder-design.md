# Visual Store Builder — Design Spec (Calderyn Platform Pivot)

**Date:** 2026-06-29
**Owner:** Eric
**Status:** Design agreed in brainstorming (2026-06-29). Architecture-of-record for the unified builder; per-unit implementation plans follow via writing-plans, one sub-project at a time.
**Relates to / supersedes:** master pivot spec `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` §#16 (agentic store generator, lines 526–559), §#8 (visual store builder, lines 975–1003), §#7 (storefront, 393–420), §#5 (owned catalog, 93–117). **Supersedes** #16's flat fixed-template / `store_settings.layout_json` output approach with a block-document model.

---

## Decision (founder, 2026-06-29)

Build a **unified visual store builder** — one product, three capabilities on one block-document model:

1. **Agentic generate** (#16, "Replit-like"): describe-it / connect-catalog → AI composes a complete published store.
2. **Manual drag-and-drop** (#8): add/move/resize components on a canvas.
3. **Inline "tweak in box"** (#8): click a block, edit text/props in place.

…across **all page types** (home, generic pages, collection, PDP).

**This overrides the master spec's Tier-3 deferral of #8** (was Step 12). #16 + #8 are built together now. This is a deliberate scope increase chosen by the founder; it pulls a heavy subsystem into the MVP. See **Sequencing impact** and **What's cut**.

---

## Grounding (what exists vs net-new)

**EXISTS (reuse):**
- Claude harness — `app/lib/assistant/anthropic.server.ts` (`getAnthropic`, `DEFAULT_ASSISTANT_MODEL = claude-sonnet-4-6`, `DEFAULT_DIGEST_MODEL = claude-haiku-4-5`), `turn.server.ts`, cache-breakpoint prompt. **No new model infra.**
- Locked-contract discipline — `engine/calderyn_engine/claude_layer.py` (`_assert_covers_input`, untrusted-evidence, deterministic `_fallback`) — pattern mirrored in TS, not run in Python.
- Catalog read contract — `app/lib/storefront/catalog.ts` (`StorefrontCatalog`: `listProducts/getProduct/listCollections`; `StoreProduct/StoreVariant/StoreCollection`). Fixture stub now; John's owned impl (§#5) later behind the same interface.
- Settings stub — `app/lib/storefront/settings.ts` (`StoreSettings { storeName, logoUrl, palette }`, hardcoded; "shadows the eventual store_settings_dim").
- Storefront SSR routes — `app/routes/storefront.*` (home / collection / PDP / cart / checkout / confirmation). Public, unauthenticated, `shop_id`-scoped (no RLS).
- Checkout core landing now — #1 buyer identity, #2 order spine, #3 Stripe (migrations `20260629100000_buyer_identity`, `20260629110000_order_spine`, `20260628120000_stripe_payments`; routes `storefront.cart/checkout/confirmation`).
- **Drag substrate** — `react-grid-layout@1.5.3` already in deps **and** already used by the dashboard tile layout (`app/components/dashboard/screens/dashboard-layout.ts`).
- Dashboard stack — `app/routes/dashboard.*`, `app/components/dashboard/*`, `cd-*`/`CDIcon` (Lucide). **Not** Polaris (embedded admin retired).

**NET-NEW:** the block-document model + registry, the `#7` block renderer, the generator orchestrator, the visual editor (canvas + inline edit + props panel + publish), two persistence tables.

---

## Architecture — the shared spine (build FIRST; both units bind to it)

### Block document model
```ts
type BlockDocument = {
  kind: 'singleton' | 'template';   // template => rendered per catalog record
  pageKey: string;                  // 'home' | 'page:about' | 'pdp' | 'collection'
  blocks: Block[];
};
type Block = {
  id: string;                       // stable; survives edits
  type: BlockType;                  // from the registry (enum)
  props: Record<string, unknown>;   // schema per type
  layout: { x: number; y: number; w: number; h: number }; // react-grid-layout cell
};
```

### Block registry — three flavors (starter set; grow by adding blocks, NOT schema changes)
- **static** — `hero · richText · image · button`. Author-set props. Valid on any doc.
- **dynamic** — `productGallery · productTitle · price · productDescription · collectionGrid · collectionHeader · breadcrumbs`. Bound to render `ctx`; **forbidden to carry hardcoded catalog ids on a template doc** (they read the current record).
- **functional** — `addToCart · variantPicker`. **Wired to the real cart/checkout (#2/#3).** The editor may move/restyle; it **may not remove or unwire them on PDP** (rule 12 — buy path is sacred). Required-present invariant enforced at publish.

Each registry entry declares: `flavor`, `propsSchema` (Zod), `allowedDocKinds`, `defaultProps`, `defaultLayout`, and an SSR component.

### Singleton vs template documents (the "all page types" mechanism)
- **Singleton** (`home`, `page:*`): one document per `(shop_id, pageKey)`; static/dynamic blocks may reference **specific** catalog ids (e.g. a `collectionGrid` pinned to collection `summer`), validated against real ids.
- **Template** (`pdp`, `collection`): **one** document per `(shop_id, pageKey)`, rendered for **every** product/collection via context. `productGallery` → `ctx.product.images`, `collectionGrid` → `ctx.collection.products`. Editing one PDP template applies to all products. No per-product documents.

### Renderer (in `#7`)
```ts
renderBlocks(doc: BlockDocument, ctx?: { product?: StoreProduct; collection?: StoreCollection }): ReactNode
```
- `ctx` present for `template` docs (the current record), absent for `singleton`.
- **Single renderer**, consumed by BOTH the live storefront (`published_json`) and the editor preview (`draft_json`) — no divergence.
- Storefront routes resolve `shop_id` → load `page_document` → `renderBlocks`. Missing/empty doc → deterministic default doc (storefront never blank).

### Persistence (shop_id-scoped; migrations numbered AFTER John's commerce-core)
```sql
page_document(
  shop_id text, page_key text, kind text,           -- PK (shop_id, page_key)
  draft_json jsonb, published_json jsonb, updated_at timestamptz
);
store_generation(
  id, shop_id, run_id, source 'brief'|'catalog', brief_text,
  model, status 'draft'|'applied'|'published'|'failed', token_cost, created_at
);  -- run/audit, rule 12
store_generation_proposal(run_id PK, shop_id, plan_json, created_at);  -- raw AI BlockPlan (audit, pre-validation); draft_json holds the validated, editable doc
```
- `draft_json` vs `published_json` = the only versioning (two columns; **no history table** — YAGNI).
- `store_settings` (chrome: name/logo/palette) — promoted from the stub to a real per-shop row, read by `getStoreSettings`; written only at publish. No fixed-template enum survives (the block doc IS the layout). **Heads-up to John:** this is the table §#5/#7 assumed — coordinate so it's not double-built.

### Carried discipline (from #16 / `claude_layer`)
- **Id validation:** every catalog id a generated block references ∈ real ids from `StorefrontCatalog`; violation → drop + log (rule 12), never publish fabricated ids.
- **Untrusted evidence:** catalog text into Claude is wrapped as untrusted data (no instruction-following) — prompt-injection containment.

---

## Unit ① — #16 Agentic generator (emits block documents)

`app/lib/storegen/*` (server-only), reusing the Claude harness.

- `generateStore({ shopId, mode: 'brief'|'catalog', brief? })`: deterministic control flow (rule 5). Load catalog facts via `StorefrontCatalog`; pick a starting layout preset (initial block arrangement, not a persisted enum); compose **all doc kinds in one pass** — singleton `home` + `pdp`/`collection` templates.
- **Claude does only language work** (`claude-haiku-4-5`): bounded store/collection/hero copy under a **locked `BlockPlan` contract** → parse → validate (real ids, prop schemas, enum types, length bounds).
- **Deterministic fallback** (`fallback.ts`): on Claude error / timeout / invalid JSON / token-budget exceeded → compose a valid block document from catalog facts + `defaultProps`/`defaultLayout`. Always publishable.
- **Functional-block guarantee:** PDP template always gets `addToCart` + `variantPicker` + `price` from defaults — never AI-omitted.
- Writes `page_document.draft_json` for each doc + `store_generation` (audit) → **opens the editor** (the review surface). No separate text-edit gate; never auto-publishes.
- Empty catalog → chrome + structure, `store_generation` flagged `no_products` (rule 12).
- Per-run token/cost budget (rule 6).

## Unit ② — #8 Visual editor (drag-drop + tweak-in-box)

Dashboard-stack route group (`app/routes/dashboard.builder.*`), first-party, product-neutral.

- **Canvas** — `react-grid-layout` (existing dep): a **block palette** (add), drag-move, resize. Per-doc; template docs preview against a **sample record** picker (sample product/collection → `ctx`).
- **Inline "tweak in box"** — native `contenteditable` + a small first-party formatting toolbar for text props; click-to-select → **per-block props panel** for non-text props (image url, button link, bound-field selector). No Slate/Tiptap/Lexical, **no design-tool/Claude bridge, no `postMessage` prototype bridge** (CLAUDE.md hygiene). Nothing browser-visible carries provenance/"Claude Design" naming.
- **Live preview** uses the same `renderBlocks` as the storefront.
- **Persistence** — autosave to `draft_json`; **Publish** copies `draft_json → published_json` (idempotent on `(shop_id, page_key)`). Loaders read-only; actions save/publish; redirect after publish.
- **Guardrails** — functional blocks can be moved/restyled, not removed on PDP (publish-time validation); dynamic blocks on templates can't be pinned to a specific id.

**Dependency order:** Spine → (Generator ∥ Editor) once the block contract is frozen.

---

## Data flow

1. Merchant: dashboard → "Generate my store" (mode/brief) **or** opens the builder directly.
2. Generator → validated `BlockPlan` (or fallback) → writes `draft_json` for home + pdp + collection (+ pages) → opens editor.
3. Editor: drag/resize, inline-edit, props panel → autosave `draft_json` (sample-record preview for templates).
4. **Publish:** re-validate (ids, functional-block presence, schemas) → `draft_json → published_json` → `store_settings` chrome row.
5. Storefront `#7` resolves `shop_id` → loads `published_json` → `renderBlocks(doc, ctx)`; PDP/collection apply the template per record.

---

## Error handling / safety (rules 5, 6, 12)

- Deterministic fallback (generator) — always a publishable doc.
- Renderer never blanks — missing doc → default doc.
- Hard per-run token budget (rule 6) → fallback + log on breach.
- No auto-publish; merchant approval implicit in the editor→publish step; public copy gated.
- **Functional-block invariant** enforced at publish (PDP must keep addToCart/variantPicker/price wired) — fail the publish visibly, don't silently ship a broken buy path.
- Untrusted catalog text; id validation; copy never executed.
- Every dropped id / skipped product / fallback / rejected publish surfaced in `store_generation` (rule 12).

---

## Dashboard parity

Builder + generator live on the dashboard stack (this repo's `app/routes/dashboard.*` ARE the dashboard). Mirror per the parity rule — the standalone dashboard re-implements the same contracts (block doc, generate, publish) against its own postgres/`withShopContext` stack; match the contract, not the JSX.

---

## Build order (sub-projects, each its own writing-plans cycle)

0. **Spine** — block model + registry (6 starter blocks) + `page_document` persistence + `renderBlocks` in `#7` + storefront route wiring. *Freezes the block contract — the gate for everything else.*
1. **Generator (#16)** — orchestrator, `BlockPlan` locked contract, Haiku copy, id-validation, deterministic fallback, functional-block guarantee, audit tables.
2. **Editor (#8)** — canvas (react-grid-layout) + palette + inline contenteditable + props panel + sample-record preview + autosave/publish + functional-block guardrails.
3. **Page-type rollout within 0–2** — `home` (singleton) → `collection` (template) → `pdp` (template, functional blocks last). Dashboard parity per unit.

---

## Sequencing & ownership impact (stated honestly, rule 12)

- Pulls #8 (Step 12 / Tier-3) into the MVP → **Eric owns** generator + editor + shared block model; **John keeps** catalog/commerce-core. `store_settings` / block-model coordination heads-up to John stands.
- First-sale-readiness: checkout (#2/#3) is independent and still gates the sale; the builder is the content surface. PDP/collection becoming templates means the **buy-path blocks (addToCart/variantPicker/price) must stay wired** — the one place the builder touches the sale, protected by the functional-block invariant. The `product_dim` vs `*_sot` naming fix remains John's #5/#13.promote concern; the builder is insulated by `StorefrontCatalog`.

---

## What's cut / deferred

- Version history beyond draft/published (no timeline/rollback table).
- Original generated imagery — #9 / Higgsfield re-prompt (hotlink imported product images; single imagery-source seam for the later swap).
- Advanced/exotic block types beyond the 6 starters.
- Theme-port / SEO equity bridge (#13.aesthetics-seo).
- Per-block A/B (that's #15 experimentation — later; the block model is its future substrate).
- Responsive/per-breakpoint layouts beyond react-grid-layout's defaults (single layout first).

---

## Risks

- **Scope vs time** — #8-in-MVP is a multi-week lift; mitigate by the spine-first gate + page-type rollout (home → collection → pdp) so value lands incrementally.
- **Functional-block breakage** — editor must not let a merchant ship an unbuyable PDP; publish-time invariant + tests.
- **Template data-binding** — dynamic blocks must never carry hardcoded ids on templates; schema + validation enforce it.
- **Hotlinked imagery** can rotate — acceptable for pilot; seam localizes the #9 swap.
- **Prompt-injection** via catalog text — untrusted-evidence discipline + id validation.
- **react-grid-layout mobile/responsive** — single-layout first; responsive is a known follow-up.
- **John coordination** — `store_settings` table + catalog read shape; one heads-up, build behind `StorefrontCatalog`.

---

## Open contract to freeze before coding (gate)

`BlockDocument` + the 6-block registry `propsSchema`s + `renderBlocks` signature. Frozen in sub-project 0; generator and editor are blocked on it (clean, intentional gate — no circular dependency).
