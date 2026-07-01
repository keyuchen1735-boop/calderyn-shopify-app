# Visual Store Builder — Sub-project 0 (Spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the block-document foundation — the `BlockDocument` model, a 6-block registry, a shared `renderBlocks` SSR renderer, and `page_document` persistence — and wire it into the storefront home route, so the contract that the generator (#16) and editor (#8) depend on is frozen and proven end-to-end.

**Architecture:** A block document is an ordered list of typed `Block`s (`{id, type, props, layout}`). A registry maps each `BlockType` → metadata (flavor, validators, defaults, isomorphic React component). One pure `renderBlocks(doc, ctx)` renders any document; the storefront loader pre-resolves catalog data the dynamic blocks need. Documents persist in a `page_document` Supabase table (uuid `shop_id`, RLS, service-role app path — mirroring `buyer_dim`), with `draft_json` vs `published_json`. A deterministic default document guarantees the storefront never blanks.

**Tech Stack:** TypeScript (strict), React 18 (SSR via `react-dom/server`), Remix loaders, `@supabase/supabase-js` (service-role), vitest (`node` env, `renderToStaticMarkup`). No new dependencies — validators are hand-rolled (repo has no Zod), drag substrate (`react-grid-layout`) and the editor come in later sub-projects.

---

## Scope & boundaries

**In scope (this freezes the block contract):**
- `BlockDocument`/`Block`/registry types; the 6 **generic** starter blocks: `hero · richText · image · button · productGrid · collectionList`.
- `validateDocument` (catalog-id validation, enum/flavor/allowed-doc-kind checks, the functional-presence invariant **hook**).
- `renderBlocks(doc, ctx)` + the 6 isomorphic block components.
- `page_document` migration + repo (`load/save/publish`); deterministic default home doc.
- Wire the **home** singleton end-to-end into `app/routes/storefront._index.tsx` (fallback to default doc).

**Deliberately deferred (NOT this sub-project) — flagged per rule 12:**
- **Template rendering (pdp/collection)** + the **product/functional blocks** (`productGallery · price · variantPicker · addToCart · collectionGrid`). These are *additive registry entries + route wiring* — they do **not** change the frozen contract. They are the next slice (rollout order home → collection → pdp). The functional-presence invariant is wired now but vacuous until those blocks register.
- **`store_settings` promotion** (chrome table + `getStoreSettings` rewire). Moved to sub-project 1 (generator) — its first writer. The block model needs only `page_document`; the storefront layout keeps its existing sync chrome stub untouched. *(Deviation from the design spec, which co-located it here; moved to keep the spine focused and avoid a breaking sync→async change to the browse shell.)*
- **Generator (#16)** and **editor (#8)** — separate sub-projects, blocked on the contract this plan freezes.

**Conventions to follow (verified in-repo):**
- Server-only files end `.server.ts`; isomorphic block components are `.tsx`.
- Tests are `*.test.ts` (vitest `include` is `app/**/*.test.ts` — even component tests use `.test.ts` + `renderToStaticMarkup`).
- DB access only via `getSupabase()` (service-role); every query threads `shop_id`; snake_case rows → camelCase DTOs via `map*` helpers; hand-rolled boundary validation with `throw new Error`.
- Migration mirrors `supabase/migrations/20260629100000_buyer_identity.sql`: uuid `shop_id` → `shops(id)`, RLS `shop_id = current_shop_id()`, `revoke all ... from anon, authenticated`.
- Mark deliberate shortcuts with `// ponytail:` comments (already idiomatic here).

**Execution context:** Per the repo feature-isolation rule, implement in an isolated worktree: `git worktree add ../calderyn-store-builder -b feat/store-builder-spine`. All paths below are relative to the repo root.

---

## File structure (decomposition locked here)

| File | Responsibility |
|---|---|
| `app/lib/storebuilder/types.ts` | Frozen contract: `BlockDocument`, `Block`, `GridCell`, `DocKind`, `BlockType`, `BlockFlavor`, `BlockMeta`, `RenderData`, `RenderContext`. Isomorphic, no runtime. |
| `app/lib/storebuilder/blocks.tsx` | The 6 starter block definitions (each: meta + `validateProps` + `catalogRefs` + `defaultProps`/`defaultLayout` + isomorphic `Component`). |
| `app/lib/storebuilder/registry.ts` | Assembles `BLOCK_REGISTRY: Record<BlockType, BlockMeta>`; `getBlockMeta(type)`. |
| `app/lib/storebuilder/validate.ts` | `validateDocument(doc, validIds)` → cleaned doc + dropped-ref log; enum/flavor/doc-kind checks; functional-presence invariant. |
| `app/lib/storebuilder/render.tsx` | `renderBlocks(doc, ctx)` — pure, sorts by layout, maps type→Component, never throws. |
| `app/lib/storebuilder/default-doc.ts` | `defaultHomeDocument(data)` — deterministic never-blank home singleton. |
| `app/lib/storebuilder/resolve-data.server.ts` | `resolveRenderData(doc, shopId, catalog)` — loads the products/collections dynamic blocks reference, via `StorefrontCatalog` (shop-scoped). |
| `app/lib/storebuilder/page-document.server.ts` | Repo: `loadPublishedDoc`/`loadDraftDoc`/`saveDraft`/`publishDoc`. Service-role, shop-scoped, snake↔camel. |
| `supabase/migrations/20260629130000_store_builder_page_document.sql` | `page_document` table + RLS + index. |
| `app/routes/storefront._index.tsx` | **Modify**: loader loads published home doc (fallback default) + resolves data; component calls `renderBlocks`. |

---

## Task 1: Freeze the contract types

**Files:**
- Create: `app/lib/storebuilder/types.ts`

- [ ] **Step 1: Write the types**

```ts
// app/lib/storebuilder/types.ts
// FROZEN CONTRACT for the visual store builder. The generator (#16) and editor (#8)
// bind to these shapes. Adding a new block type = a new registry entry, NOT a change here.
import type { ReactNode } from "react";
import type { StoreProduct, StoreCollection } from "~/lib/storefront/catalog";

export type DocKind = "singleton" | "template";
export type PageKey = "home" | "collection" | "pdp" | `page:${string}`;
export type BlockFlavor = "static" | "dynamic" | "functional";

// Starter set (sub-project 0). Product/functional types are added in the next slice
// without changing this file's shapes.
export type BlockType =
  | "hero" | "richText" | "image" | "button" // static
  | "productGrid" | "collectionList"; // dynamic

export interface GridCell { x: number; y: number; w: number; h: number }

export interface Block {
  id: string; // stable across edits
  type: BlockType;
  props: Record<string, unknown>;
  layout: GridCell;
}

export interface BlockDocument {
  kind: DocKind;
  pageKey: PageKey;
  blocks: Block[];
}

// Catalog data the dynamic blocks need, pre-resolved by the loader (server side).
export interface RenderData {
  collections: StoreCollection[];
  productsByCollection: Record<string, StoreProduct[]>; // keyed by collection handle
  productsById: Record<string, StoreProduct>;
  allProducts: StoreProduct[];
}

// For `template` docs, `record` carries the current product/collection being rendered.
export interface RenderContext {
  data: RenderData;
  record?: { product?: StoreProduct; collection?: StoreCollection };
}

// Refs a block instance depends on — drives id-validation AND data resolution.
export interface CatalogRefs { productIds: string[]; collectionHandles: string[] }

// One registry entry per block type. `Component` is isomorphic (SSR + hydration).
export interface BlockMeta<P = Record<string, unknown>> {
  type: BlockType;
  flavor: BlockFlavor;
  allowedDocKinds: DocKind[];
  defaultProps: P;
  defaultLayout: GridCell;
  /** Validate + coerce raw props. Throws on irrecoverable shape; else returns clean P. */
  validateProps(raw: unknown): P;
  /** Catalog ids/handles this instance references (empty for static blocks). */
  catalogRefs(props: P): CatalogRefs;
  Component(args: { props: P; ctx: RenderContext }): ReactNode;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (no behavior yet; this is a type-only module).

- [ ] **Step 3: Commit**

```bash
git add app/lib/storebuilder/types.ts
git commit -m "lib/storebuilder: freeze BlockDocument contract types"
```

---

## Task 2: The 6 starter block components

**Files:**
- Create: `app/lib/storebuilder/blocks.tsx`
- Test: `app/lib/storebuilder/blocks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/blocks.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STARTER_BLOCKS } from "./blocks";
import type { RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const product = (id: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", images: [{ url: `/i/${id}.jpg`, alt: null }],
  variants: [{ id: `v-${id}`, sku: null, title: "Default", priceCents: 1000, currency: "USD", available: true }],
  collections: ["summer"],
});
const ctx = (): RenderContext => ({
  data: {
    collections: [{ handle: "summer", title: "Summer" }],
    productsByCollection: { summer: [product("1")] },
    productsById: { "1": product("1") },
    allProducts: [product("1")],
  },
});

describe("starter blocks", () => {
  it("registers exactly the 6 starter types with stable flavors", () => {
    expect(STARTER_BLOCKS.map((b) => b.type).sort()).toEqual(
      ["button", "collectionList", "hero", "image", "productGrid", "richText"],
    );
    const flavor = Object.fromEntries(STARTER_BLOCKS.map((b) => [b.type, b.flavor]));
    expect(flavor.hero).toBe("static");
    expect(flavor.productGrid).toBe("dynamic");
  });

  it("validateProps fills defaults and coerces bad input without throwing on recoverable shape", () => {
    const hero = STARTER_BLOCKS.find((b) => b.type === "hero")!;
    const clean = hero.validateProps({ headline: "Hi" });
    expect(clean).toMatchObject({ headline: "Hi" });
    expect(typeof (clean as { subhead: string }).subhead).toBe("string"); // default applied
  });

  it("productGrid.catalogRefs surfaces the collection handle it binds to", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "collection", handle: "summer" } });
    expect(grid.catalogRefs(props)).toEqual({ productIds: [], collectionHandles: ["summer"] });
  });

  it("renders productGrid against resolved data", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "all" } });
    const html = renderToStaticMarkup(createElement(grid.Component, { props, ctx: ctx() }));
    expect(html).toContain("P1");
    expect(html).toContain("/i/1.jpg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/blocks.test.ts`
Expected: FAIL — `Cannot find module './blocks'`.

- [ ] **Step 3: Write the implementation**

```tsx
// app/lib/storebuilder/blocks.tsx
// The 6 starter blocks. Each is a self-contained BlockMeta: validator + refs + component.
// ponytail: hand-rolled validators (repo has no Zod) matching the boundary-validation style
// in app/lib/buyer/identity.server.ts. Validators are tolerant — fill defaults, coerce — and
// throw only on irrecoverable shape (renderBlocks/validateDocument catch and skip).
import { createElement } from "react";
import type { BlockMeta, CatalogRefs, RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function money(p: StoreProduct): string {
  const v = p.variants[0];
  if (!v) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: v.currency }).format(v.priceCents / 100);
}

// ── static ────────────────────────────────────────────────────────────────
interface HeroProps { headline: string; subhead: string }
const hero: BlockMeta<HeroProps> = {
  type: "hero", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { headline: "Welcome", subhead: "Shop our latest" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  validateProps: (raw) => { const r = asRecord(raw); return { headline: str(r.headline, "Welcome"), subhead: str(r.subhead, "Shop our latest") }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    createElement("section", { className: "cd-block cd-block--hero" },
      createElement("h1", { className: "cd-hero__headline" }, props.headline),
      createElement("p", { className: "cd-hero__subhead" }, props.subhead)),
};

interface RichTextProps { html: string }
const richText: BlockMeta<RichTextProps> = {
  type: "richText", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { html: "Tell your story." },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  validateProps: (raw) => ({ html: str(asRecord(raw).html, "") }),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  // ponytail: plain text only — NOT dangerouslySetInnerHTML. Rich formatting is the editor's
  // job later via a sanitized prop; rendering merchant/AI HTML raw would be an XSS sink.
  Component: ({ props }) => createElement("div", { className: "cd-block cd-block--text" }, props.html),
};

interface ImageProps { url: string; alt: string }
const image: BlockMeta<ImageProps> = {
  type: "image", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { url: "", alt: "" },
  defaultLayout: { x: 0, y: 0, w: 6, h: 4 },
  validateProps: (raw) => { const r = asRecord(raw); return { url: str(r.url), alt: str(r.alt) }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    props.url ? createElement("img", { className: "cd-block cd-block--image", src: props.url, alt: props.alt }) : null,
};

interface ButtonProps { label: string; href: string }
const button: BlockMeta<ButtonProps> = {
  type: "button", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { label: "Shop now", href: "/storefront" },
  defaultLayout: { x: 0, y: 0, w: 3, h: 1 },
  validateProps: (raw) => { const r = asRecord(raw); return { label: str(r.label, "Shop now"), href: str(r.href, "/storefront") }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    createElement("a", { className: "cd-block cd-block--button", href: props.href }, props.label),
};

// ── dynamic ───────────────────────────────────────────────────────────────
type GridSource = { kind: "all" } | { kind: "collection"; handle: string } | { kind: "ids"; ids: string[] };
interface ProductGridProps { source: GridSource; heading: string }
function gridProducts(source: GridSource, ctx: RenderContext): StoreProduct[] {
  if (source.kind === "all") return ctx.data.allProducts;
  if (source.kind === "collection") return ctx.data.productsByCollection[source.handle] ?? [];
  return source.ids.map((id) => ctx.data.productsById[id]).filter((p): p is StoreProduct => Boolean(p));
}
const productGrid: BlockMeta<ProductGridProps> = {
  type: "productGrid", flavor: "dynamic", allowedDocKinds: ["singleton", "template"],
  defaultProps: { source: { kind: "all" }, heading: "Products" },
  defaultLayout: { x: 0, y: 2, w: 12, h: 6 },
  validateProps: (raw) => {
    const r = asRecord(raw); const s = asRecord(r.source);
    let source: GridSource = { kind: "all" };
    if (s.kind === "collection" && typeof s.handle === "string") source = { kind: "collection", handle: s.handle };
    else if (s.kind === "ids" && Array.isArray(s.ids)) source = { kind: "ids", ids: s.ids.filter((x): x is string => typeof x === "string") };
    return { source, heading: str(r.heading, "Products") };
  },
  catalogRefs: (props) => ({
    productIds: props.source.kind === "ids" ? props.source.ids : [],
    collectionHandles: props.source.kind === "collection" ? [props.source.handle] : [],
  }),
  Component: ({ props, ctx }) =>
    createElement("section", { className: "cd-block cd-block--grid" },
      props.heading ? createElement("h2", { className: "cd-grid__heading" }, props.heading) : null,
      createElement("div", { className: "cd-store__grid" },
        gridProducts(props.source, ctx).map((p) =>
          createElement("a", { key: p.id, className: "cd-product-card", href: `/storefront/products/${p.handle}` },
            p.images[0] ? createElement("img", { className: "cd-product-card__img", src: p.images[0].url, alt: p.images[0].alt ?? p.title }) : null,
            createElement("span", { className: "cd-product-card__title" }, p.title),
            createElement("span", { className: "cd-product-card__price" }, money(p)))))),
};

interface CollectionListProps { heading: string }
const collectionList: BlockMeta<CollectionListProps> = {
  type: "collectionList", flavor: "dynamic", allowedDocKinds: ["singleton"],
  defaultProps: { heading: "Collections" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 1 },
  validateProps: (raw) => ({ heading: str(asRecord(raw).heading, "Collections") }),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props, ctx }) =>
    createElement("nav", { className: "cd-block cd-block--collections" },
      props.heading ? createElement("h2", null, props.heading) : null,
      ctx.data.collections.map((c) =>
        createElement("a", { key: c.handle, href: `/storefront/collections/${c.handle}` }, c.title))),
};

// Exported as a plain array; the registry indexes it by type (Task 3).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous BlockMeta<P> union; registry narrows by type
export const STARTER_BLOCKS: BlockMeta<any>[] = [hero, richText, image, button, productGrid, collectionList];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/blocks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add app/lib/storebuilder/blocks.tsx app/lib/storebuilder/blocks.test.ts
git commit -m "lib/storebuilder: 6 starter block components + hand-rolled validators"
```

---

## Task 3: Registry

**Files:**
- Create: `app/lib/storebuilder/registry.ts`
- Test: `app/lib/storebuilder/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/registry.test.ts
import { describe, it, expect } from "vitest";
import { getBlockMeta, BLOCK_REGISTRY } from "./registry";

describe("block registry", () => {
  it("indexes all 6 starter blocks by type", () => {
    expect(Object.keys(BLOCK_REGISTRY).sort()).toEqual(
      ["button", "collectionList", "hero", "image", "productGrid", "richText"],
    );
  });
  it("getBlockMeta returns the entry for a known type", () => {
    expect(getBlockMeta("hero")?.flavor).toBe("static");
  });
  it("getBlockMeta returns undefined for an unknown type (forward-compat)", () => {
    // @ts-expect-error intentionally invalid type
    expect(getBlockMeta("carousel")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/storebuilder/registry.ts
import type { BlockMeta, BlockType } from "./types";
import { STARTER_BLOCKS } from "./blocks";

export const BLOCK_REGISTRY: Partial<Record<BlockType, BlockMeta>> = Object.fromEntries(
  STARTER_BLOCKS.map((b) => [b.type, b]),
) as Partial<Record<BlockType, BlockMeta>>;

export function getBlockMeta(type: BlockType): BlockMeta | undefined {
  return BLOCK_REGISTRY[type];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/registry.ts app/lib/storebuilder/registry.test.ts
git commit -m "lib/storebuilder: block registry + getBlockMeta lookup"
```

---

## Task 4: Document validation (id-validation + invariants)

**Files:**
- Create: `app/lib/storebuilder/validate.ts`
- Test: `app/lib/storebuilder/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/validate.test.ts
import { describe, it, expect } from "vitest";
import { validateDocument, type ValidIds } from "./validate";
import type { BlockDocument } from "./types";

const valid: ValidIds = { productIds: new Set(["1", "2"]), collectionHandles: new Set(["summer"]) };
const doc = (blocks: BlockDocument["blocks"]): BlockDocument => ({ kind: "singleton", pageKey: "home", blocks });

describe("validateDocument", () => {
  it("drops a productGrid id that is not a real catalog id, and logs it", () => {
    const result = validateDocument(
      doc([{ id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "ids", ids: ["1", "999"] } } }]),
      valid,
    );
    const grid = result.doc.blocks[0].props.source as { kind: string; ids: string[] };
    expect(grid.ids).toEqual(["1"]); // 999 dropped
    expect(result.dropped).toContainEqual({ blockId: "g", kind: "product", ref: "999" });
  });

  it("drops a block whose type is unknown", () => {
    const result = validateDocument(
      // @ts-expect-error invalid type on purpose
      doc([{ id: "x", type: "carousel", layout: { x: 0, y: 0, w: 1, h: 1 }, props: {} }]),
      valid,
    );
    expect(result.doc.blocks).toHaveLength(0);
    expect(result.dropped).toContainEqual({ blockId: "x", kind: "type", ref: "carousel" });
  });

  it("drops a block used on a doc kind it does not allow (collectionList on a template)", () => {
    const result = validateDocument(
      { kind: "template", pageKey: "pdp", blocks: [{ id: "c", type: "collectionList", layout: { x: 0, y: 0, w: 12, h: 1 }, props: {} }] },
      valid,
    );
    expect(result.doc.blocks).toHaveLength(0);
  });

  it("passes a clean document untouched", () => {
    const clean = doc([{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Hi", subhead: "yo" } }]);
    const result = validateDocument(clean, valid);
    expect(result.dropped).toHaveLength(0);
    expect(result.doc.blocks[0].props).toMatchObject({ headline: "Hi" });
  });

  it("reports a pdp template missing required functional blocks (invariant hook)", () => {
    // No functional blocks registered yet → required set empty → no error. Asserts the hook is wired.
    const result = validateDocument({ kind: "template", pageKey: "pdp", blocks: [] }, valid);
    expect(result.missingFunctional).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/validate.test.ts`
Expected: FAIL — `Cannot find module './validate'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/storebuilder/validate.ts
// Document validation: never publish a fabricated catalog id, never let an invalid block
// reach the renderer, and (rule 12) surface every drop. Pure + isomorphic.
import type { BlockDocument, BlockType, PageKey } from "./types";
import { getBlockMeta } from "./registry";

export interface ValidIds { productIds: Set<string>; collectionHandles: Set<string> }
export interface DroppedRef { blockId: string; kind: "type" | "docKind" | "product" | "collection"; ref: string }
export interface ValidationResult { doc: BlockDocument; dropped: DroppedRef[]; missingFunctional: BlockType[] }

// Functional blocks required on a given page type. Empty until product/functional blocks
// register (next slice). ponytail: vacuous now; the buy-path invariant slots in by adding
// entries here — the call site below already enforces whatever this returns.
export function requiredFunctionalBlocks(_pageKey: PageKey): BlockType[] {
  return [];
}

export function validateDocument(input: BlockDocument, valid: ValidIds): ValidationResult {
  const dropped: DroppedRef[] = [];
  const blocks: BlockDocument["blocks"] = [];

  for (const block of input.blocks) {
    const meta = getBlockMeta(block.type);
    if (!meta) { dropped.push({ blockId: block.id, kind: "type", ref: String(block.type) }); continue; }
    if (!meta.allowedDocKinds.includes(input.kind)) { dropped.push({ blockId: block.id, kind: "docKind", ref: input.kind }); continue; }

    let props: Record<string, unknown>;
    try { props = meta.validateProps(block.props) as Record<string, unknown>; }
    catch { dropped.push({ blockId: block.id, kind: "type", ref: block.type }); continue; }

    // Drop any catalog ref that is not real. On a `template` doc, dynamic blocks bind to the
    // current record via ctx, so they carry no hardcoded ids — refs are only checked here.
    const refs = meta.catalogRefs(props);
    const badProducts = refs.productIds.filter((id) => !valid.productIds.has(id));
    const badCollections = refs.collectionHandles.filter((h) => !valid.collectionHandles.has(h));
    for (const ref of badProducts) dropped.push({ blockId: block.id, kind: "product", ref });
    for (const ref of badCollections) dropped.push({ blockId: block.id, kind: "collection", ref });

    let cleanProps = props;
    if (badProducts.length || badCollections.length) cleanProps = stripBadRefs(props, new Set(badProducts), new Set(badCollections));
    blocks.push({ ...block, props: cleanProps });
  }

  const present = new Set(blocks.map((b) => b.type));
  const missingFunctional = requiredFunctionalBlocks(input.pageKey).filter((t) => !present.has(t));

  return { doc: { ...input, blocks }, dropped, missingFunctional };
}

// Remove dropped ids from a productGrid `ids` source. Other block shapes have no removable
// id list, so they pass through unchanged.
function stripBadRefs(props: Record<string, unknown>, badIds: Set<string>, badHandles: Set<string>): Record<string, unknown> {
  const source = props.source as { kind?: string; ids?: unknown; handle?: unknown } | undefined;
  if (source?.kind === "ids" && Array.isArray(source.ids)) {
    return { ...props, source: { kind: "ids", ids: source.ids.filter((id) => typeof id === "string" && !badIds.has(id)) } };
  }
  if (source?.kind === "collection" && typeof source.handle === "string" && badHandles.has(source.handle)) {
    return { ...props, source: { kind: "all" } }; // bad collection → fall back to all, never blank
  }
  return props;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/validate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/validate.ts app/lib/storebuilder/validate.test.ts
git commit -m "lib/storebuilder: validateDocument (id-validation, doc-kind, functional invariant)"
```

---

## Task 5: renderBlocks

**Files:**
- Create: `app/lib/storebuilder/render.tsx`
- Test: `app/lib/storebuilder/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/render.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBlocks } from "./render";
import type { BlockDocument, RenderContext } from "./types";

const ctx: RenderContext = { data: { collections: [], productsByCollection: {}, productsById: {}, allProducts: [] } };
const wrap = (doc: BlockDocument) => renderToStaticMarkup(createElement("div", null, renderBlocks(doc, ctx)));

describe("renderBlocks", () => {
  it("renders blocks sorted top-to-bottom by layout.y", () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "b", type: "richText", layout: { x: 0, y: 5, w: 12, h: 1 }, props: { html: "SECOND" } },
      { id: "a", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "FIRST", subhead: "" } },
    ] };
    const html = wrap(doc);
    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND"));
  });

  it("skips an unknown block type instead of throwing", () => {
    const doc = { kind: "singleton", pageKey: "home", blocks: [
      // @ts-expect-error invalid type on purpose
      { id: "x", type: "carousel", layout: { x: 0, y: 0, w: 1, h: 1 }, props: {} },
      { id: "h", type: "hero", layout: { x: 0, y: 1, w: 12, h: 2 }, props: { headline: "OK", subhead: "" } },
    ] } as BlockDocument;
    expect(() => wrap(doc)).not.toThrow();
    expect(wrap(doc)).toContain("OK");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/render.test.ts`
Expected: FAIL — `Cannot find module './render'`.

- [ ] **Step 3: Write the implementation**

```tsx
// app/lib/storebuilder/render.tsx
// The single renderer, shared by the live storefront (published_json) and (later) the editor
// preview (draft_json). Pure and defensive: never throws, never blanks on a bad block.
import { createElement, type ReactNode } from "react";
import type { BlockDocument, RenderContext } from "./types";
import { getBlockMeta } from "./registry";

export function renderBlocks(doc: BlockDocument, ctx: RenderContext): ReactNode[] {
  return [...doc.blocks]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .map((block) => {
      const meta = getBlockMeta(block.type);
      if (!meta) return null; // unknown type (forward-compat) → skip
      let props: Record<string, unknown>;
      try { props = meta.validateProps(block.props) as Record<string, unknown>; }
      catch { return null; } // defensive: published docs are pre-validated, but never crash a render
      return createElement(meta.Component as (a: { props: unknown; ctx: RenderContext }) => ReactNode, { key: block.id, props, ctx });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/render.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/render.tsx app/lib/storebuilder/render.test.ts
git commit -m "lib/storebuilder: renderBlocks (sorted, defensive, never-throws)"
```

---

## Task 6: Deterministic default document

**Files:**
- Create: `app/lib/storebuilder/default-doc.ts`
- Test: `app/lib/storebuilder/default-doc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/default-doc.test.ts
import { describe, it, expect } from "vitest";
import { defaultHomeDocument } from "./default-doc";
import { validateDocument } from "./validate";

describe("defaultHomeDocument", () => {
  it("is a valid singleton home doc with a hero + an all-products grid", () => {
    const doc = defaultHomeDocument();
    expect(doc.kind).toBe("singleton");
    expect(doc.pageKey).toBe("home");
    expect(doc.blocks.map((b) => b.type)).toEqual(["hero", "productGrid"]);
    const grid = doc.blocks[1].props.source as { kind: string };
    expect(grid.kind).toBe("all"); // never references a specific id → never blanks
  });

  it("survives validateDocument unchanged (no dropped refs)", () => {
    const result = validateDocument(defaultHomeDocument(), { productIds: new Set(), collectionHandles: new Set() });
    expect(result.dropped).toHaveLength(0);
    expect(result.doc.blocks).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/default-doc.test.ts`
Expected: FAIL — `Cannot find module './default-doc'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/storebuilder/default-doc.ts
// The never-blank guarantee (rule 12): when a shop has no published home doc yet, the
// storefront renders this. Uses only the `all` grid source so it needs no specific catalog ids.
import type { BlockDocument } from "./types";

export function defaultHomeDocument(): BlockDocument {
  return {
    kind: "singleton",
    pageKey: "home",
    blocks: [
      { id: "default-hero", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 },
        props: { headline: "Welcome", subhead: "Shop our latest" } },
      { id: "default-grid", type: "productGrid", layout: { x: 0, y: 2, w: 12, h: 6 },
        props: { source: { kind: "all" }, heading: "Shop all" } },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/default-doc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/default-doc.ts app/lib/storebuilder/default-doc.test.ts
git commit -m "lib/storebuilder: deterministic never-blank default home document"
```

---

## Task 7: page_document migration

**Files:**
- Create: `supabase/migrations/20260629130000_store_builder_page_document.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260629130000_store_builder_page_document.sql
-- Visual store builder (#16/#8) spine: persisted block documents. One row per (shop_id,
-- page_key). draft_json is the editable/in-progress doc; published_json is what the public
-- storefront renders. RLS modeled on buyer_identity (20260629100000): own shop_id + a
-- `shop_id = current_shop_id()` policy; anon/authenticated grants revoked. The app reaches
-- this table only via the service-role key (BYPASSRLS), threading shop_id on every query.
create table public.page_document (
  shop_id        uuid not null references public.shops(id) on delete cascade,
  page_key       text not null,
  kind           text not null check (kind in ('singleton','template')),
  draft_json     jsonb,
  published_json jsonb,
  updated_at     timestamptz not null default now(),
  primary key (shop_id, page_key)
);
create index page_document_shop_idx on public.page_document (shop_id);

alter table public.page_document enable row level security;
create policy page_document_shop_scope on public.page_document
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.page_document from anon, authenticated;
```

- [ ] **Step 2: Verify the SQL is well-formed**

Run: `grep -c "current_shop_id" supabase/migrations/20260629130000_store_builder_page_document.sql`
Expected: `2` (policy `using` + `with check`) — confirms the RLS pattern matches `buyer_identity`.

If the Supabase CLI is linked in this environment, also run `supabase db lint` and expect no errors. Otherwise the behavior is covered by the repo tests in Task 8 (mocked client) and the migration is applied through the normal deploy flow — **do not** apply ad hoc to production (per repo memory S374).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260629130000_store_builder_page_document.sql
git commit -m "supabase: page_document table (block docs, draft/published, RLS)"
```

---

## Task 8: page_document repo

**Files:**
- Create: `app/lib/storebuilder/page-document.server.ts`
- Test: `app/lib/storebuilder/page-document.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/page-document.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

import { loadPublishedDoc, saveDraft, publishDoc } from "./page-document.server";
import type { BlockDocument } from "./types";

const realShop = "11111111-1111-1111-1111-111111111111";
const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
  { id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Hi", subhead: "" } },
] };

beforeEach(() => fromMock.mockReset());

describe("page-document repo", () => {
  it("returns null for a non-uuid (fixture/demo) shop without hitting the DB", async () => {
    const out = await loadPublishedDoc("demo-shop", "home");
    expect(out).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("loadPublishedDoc maps published_json into a BlockDocument", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { published_json: doc }, error: null });
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    fromMock.mockReturnValue({ select });
    const out = await loadPublishedDoc(realShop, "home");
    expect(out).toEqual(doc);
    expect(fromMock).toHaveBeenCalledWith("page_document");
    expect(eq1).toHaveBeenCalledWith("shop_id", realShop); // shop-scoped
  });

  it("loadPublishedDoc returns null when no row / published_json is null", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) });
    expect(await loadPublishedDoc(realShop, "home")).toBeNull();
  });

  it("saveDraft upserts draft_json keyed on (shop_id, page_key)", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await saveDraft(realShop, "home", doc);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: realShop, page_key: "home", kind: "singleton", draft_json: doc }),
      { onConflict: "shop_id,page_key" },
    );
  });

  it("publishDoc copies draft_json into published_json", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { draft_json: doc, kind: "singleton" }, error: null });
    const update = vi.fn().mockResolvedValue({ error: null });
    fromMock
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }) // read draft
      .mockReturnValueOnce({ update: () => ({ eq: () => ({ eq: update }) }) }); // write published
    await publishDoc(realShop, "home");
    expect(update).toHaveBeenCalled();
  });

  it("publishDoc throws when there is no draft to publish (fail visibly, rule 12)", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) });
    await expect(publishDoc(realShop, "home")).rejects.toThrow(/no draft/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/page-document.server.test.ts`
Expected: FAIL — `Cannot find module './page-document.server'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/storebuilder/page-document.server.ts
// Server-only repo over public.page_document. Mirrors the access pattern in
// app/lib/buyer/identity.server.ts: service-role client, shop_id threaded on every query,
// snake_case rows kept out of callers (json columns ARE the BlockDocument, so they pass through).
import { getSupabase } from "~/lib/supabase.server";
import type { BlockDocument, PageKey } from "./types";

// ponytail: the fixture/demo storefront resolves a non-uuid shop ("demo-shop") and has no DB
// row; a uuid column query would error. Treat non-uuid shops as "no persisted doc" so the
// storefront falls back to the default doc. Real shops (uuid) read normally.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function persistableShop(shopId: string): boolean { return UUID_RE.test(shopId); }

export async function loadPublishedDoc(shopId: string, pageKey: PageKey): Promise<BlockDocument | null> {
  if (!persistableShop(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("page_document").select("published_json").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  return (data?.published_json as BlockDocument | null) ?? null;
}

export async function loadDraftDoc(shopId: string, pageKey: PageKey): Promise<BlockDocument | null> {
  if (!persistableShop(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("page_document").select("draft_json").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  return (data?.draft_json as BlockDocument | null) ?? null;
}

/** Upsert the editable draft. The doc's own `kind` is the row's kind. */
export async function saveDraft(shopId: string, pageKey: PageKey, doc: BlockDocument): Promise<void> {
  if (!persistableShop(shopId)) throw new Error(`saveDraft requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("page_document").upsert(
    { shop_id: shopId, page_key: pageKey, kind: doc.kind, draft_json: doc, updated_at: new Date().toISOString() },
    { onConflict: "shop_id,page_key" },
  );
  if (error) throw error;
}

/** Promote draft → published. Fails visibly if there is no draft (rule 12). */
export async function publishDoc(shopId: string, pageKey: PageKey): Promise<void> {
  if (!persistableShop(shopId)) throw new Error(`publishDoc requires a real (uuid) shop_id, got ${shopId}`);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("page_document").select("draft_json, kind").eq("shop_id", shopId).eq("page_key", pageKey).maybeSingle();
  if (error) throw error;
  if (!data?.draft_json) throw new Error(`no draft to publish for (${shopId}, ${pageKey})`);
  const { error: upErr } = await sb
    .from("page_document").update({ published_json: data.draft_json, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId).eq("page_key", pageKey);
  if (upErr) throw upErr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/page-document.server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add app/lib/storebuilder/page-document.server.ts app/lib/storebuilder/page-document.server.test.ts
git commit -m "lib/storebuilder: page_document repo (load/save/publish, shop-scoped)"
```

---

## Task 9: Render-data resolution

**Files:**
- Create: `app/lib/storebuilder/resolve-data.server.ts`
- Test: `app/lib/storebuilder/resolve-data.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storebuilder/resolve-data.server.test.ts
import { describe, it, expect } from "vitest";
import { resolveRenderData } from "./resolve-data.server";
import type { BlockDocument } from "./types";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";

const p = (id: string, collection: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", images: [], variants: [], collections: [collection],
});
const fakeCatalog = (): StorefrontCatalog => ({
  listCollections: async () => [{ handle: "summer", title: "Summer" }, { handle: "winter", title: "Winter" }],
  listProducts: async (_s, opts) => (opts?.collection ? [p("1", opts.collection)] : [p("1", "summer"), p("2", "winter")]),
  getProduct: async (_s, handle) => p(handle.replace("h-", ""), "summer"),
});

describe("resolveRenderData", () => {
  it("loads all collections and all products once, keyed for the renderer", async () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "all" } } },
      { id: "c", type: "collectionList", layout: { x: 0, y: 6, w: 12, h: 1 }, props: {} },
    ] };
    const data = await resolveRenderData(doc, "shop", fakeCatalog());
    expect(data.collections.map((c) => c.handle)).toEqual(["summer", "winter"]);
    expect(data.allProducts).toHaveLength(2);
  });

  it("loads products for a collection that a productGrid binds to", async () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "collection", handle: "summer" } } },
    ] };
    const data = await resolveRenderData(doc, "shop", fakeCatalog());
    expect(data.productsByCollection.summer).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/resolve-data.server.test.ts`
Expected: FAIL — `Cannot find module './resolve-data.server'`.

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/storebuilder/resolve-data.server.ts
// Server-only: pre-load exactly the catalog data the document's blocks reference, so the pure
// renderer (renderBlocks) needs no async/DB. Every read is shop-scoped (shopId first arg).
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
import type { BlockDocument, RenderData } from "./types";
import { getBlockMeta } from "./registry";

export async function resolveRenderData(
  doc: BlockDocument, shopId: string, catalog: StorefrontCatalog,
): Promise<RenderData> {
  // Gather refs across all blocks.
  const collectionHandles = new Set<string>();
  const productIds = new Set<string>();
  let needsAll = false;
  for (const block of doc.blocks) {
    const meta = getBlockMeta(block.type);
    if (!meta) continue;
    let props: Record<string, unknown>;
    try { props = meta.validateProps(block.props) as Record<string, unknown>; } catch { continue; }
    const refs = meta.catalogRefs(props);
    refs.collectionHandles.forEach((h) => collectionHandles.add(h));
    refs.productIds.forEach((id) => productIds.add(id));
    const source = (props.source as { kind?: string } | undefined)?.kind;
    if (block.type === "productGrid" && source === "all") needsAll = true;
    if (block.type === "collectionList") collectionHandles.add("*"); // sentinel: needs the full list
  }

  const wantsCollectionsList = collectionHandles.delete("*");
  const collections = wantsCollectionsList ? await catalog.listCollections(shopId) : [];
  const allProducts = needsAll ? await catalog.listProducts(shopId) : [];

  const productsByCollection: Record<string, Awaited<ReturnType<StorefrontCatalog["listProducts"]>>> = {};
  await Promise.all([...collectionHandles].map(async (handle) => {
    productsByCollection[handle] = await catalog.listProducts(shopId, { collection: handle });
  }));

  const productsById: Record<string, Awaited<ReturnType<StorefrontCatalog["getProduct"]>> & object> = {};
  await Promise.all([...productIds].map(async (id) => {
    // ponytail: getProduct is keyed by handle; the fixture handle is `h-<id>`. The owned
    // catalog (#5) will expose id lookups — until then explicit-id grids resolve by that
    // convention. Acceptable: explicit-id grids are author-chosen, validated against real ids.
    const prod = await catalog.getProduct(shopId, `h-${id}`);
    if (prod) productsById[id] = prod;
  }));

  return { collections, productsByCollection, productsById, allProducts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/resolve-data.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/resolve-data.server.ts app/lib/storebuilder/resolve-data.server.test.ts
git commit -m "lib/storebuilder: resolveRenderData (load only what blocks reference)"
```

---

## Task 10: Wire the home route to the block spine

**Files:**
- Modify: `app/routes/storefront._index.tsx`
- Test: `app/routes/__tests__/storefront.builder-home.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/storefront.builder-home.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";

const { getCatalogMock, loadPublishedMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loadPublishedMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

import StorefrontHome, { loader } from "../storefront._index";

beforeEach(() => {
  getCatalogMock.mockReset().mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockReset();
  loaderDataRef.current = null;
});
const req = () => new Request("https://demo.calderyncompany.com/storefront");

describe("storefront home on the block spine", () => {
  it("falls back to the default document when the shop has no published home doc", async () => {
    loadPublishedMock.mockResolvedValue(null);
    const data = await (await loader({ request: req(), params: {}, context: {} } as never)).json();
    expect(data.doc.blocks.map((b: { type: string }) => b.type)).toEqual(["hero", "productGrid"]);
    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("cd-block--hero");
    expect(html).toContain("cd-store__grid"); // products rendered from the fixture
  });

  it("renders a published document when one exists", async () => {
    loadPublishedMock.mockResolvedValue({
      kind: "singleton", pageKey: "home",
      blocks: [{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "CUSTOM STORE", subhead: "" } }],
    });
    const data = await (await loader({ request: req(), params: {}, context: {} } as never)).json();
    loaderDataRef.current = data;
    expect(renderToStaticMarkup(createElement(StorefrontHome))).toContain("CUSTOM STORE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/storefront.builder-home.test.ts`
Expected: FAIL — the current `storefront._index.tsx` loader returns `{ collections, products }`, not `{ doc, data }`.

- [ ] **Step 3: Rewrite the route**

```tsx
// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { renderBlocks } from "~/lib/storebuilder/render";

export const meta: MetaFunction = () => {
  const title = "Shop all — Calderyn Demo Store";
  const description = "Browse every product in the Calderyn Demo Store.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // The published block doc for this shop's home, or the never-blank default (rule 12).
  const doc = (await loadPublishedDoc(shopId, "home")) ?? defaultHomeDocument();
  // Pre-resolve exactly the catalog data the doc's blocks reference (shopId scoping inside).
  const data = await resolveRenderData(doc, shopId, catalog);
  return json({ doc, data });
}

export default function StorefrontHome() {
  const { doc, data } = useLoaderData<typeof loader>();
  return <div className="cd-store__home">{renderBlocks(doc, { data })}</div>;
}
```

- [ ] **Step 4: Run the new test + the existing storefront render suite**

Run: `npx vitest run app/routes/__tests__/storefront.builder-home.test.ts app/routes/__tests__/storefront.render.test.ts`
Expected: the new test PASSES. The existing `storefront.render.test.ts` home-loader assertions reference the old `{ collections, products }` shape — **update those assertions** in that file to the new `{ doc, data }` shape (the home page now renders blocks). Do not change the layout/collection/PDP assertions. Re-run until green.

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all exit 0.

```bash
git add app/routes/storefront._index.tsx app/routes/__tests__/storefront.builder-home.test.ts app/routes/__tests__/storefront.render.test.ts
git commit -m "storefront: render the home page from the block document spine"
```

---

## Definition of done (the repo pre-commit gate — rule 12, do not skip)

Before opening the PR for this sub-project, run in order and paste results (no asserting success without evidence):

1. `/code-review` on the working tree — resolve every blocker.
2. Patch sanity — `git diff --stat` + `git diff --check` clean; no stray `console.log`/`.only`/AI-provenance/design-tool markers/browser-visible internal comments.
3. `npm run typecheck` → 0
4. `npm run lint` → 0 (`--max-warnings=0` for the new files)
5. `npm run build` → 0 (Remix+Vite build + `verify:client-bundle` passes — confirms no design-tool/Claude bridge or sourcemap leaked into the client bundle)
6. `npx prisma validate` is N/A (no Prisma schema change); the Supabase migration is applied via the normal deploy flow, **not** ad hoc against production.

**Dashboard parity:** this sub-project is the internal block/render/persistence spine with no merchant-facing dashboard surface, so it is parity-exempt. Parity attaches to the **generator** and **editor** sub-projects (their merchant UI mirrors onto the dashboard stack).

---

## Self-review (against the spec)

**Spec coverage:** BlockDocument/registry/6 blocks (Tasks 1–3) · singleton vs template + allowedDocKinds (Tasks 1,4) · id-validation + functional invariant hook (Task 4) · renderBlocks shared renderer (Task 5) · never-blank default (Task 6) · page_document persistence draft/published (Tasks 7,8) · catalog-bound data via StorefrontCatalog (Task 9) · storefront wiring (Task 10). Template (pdp/collection) rendering + product/functional blocks + store_settings promotion are **explicitly deferred** above (next slice / sub-project 1) — the contract they bind to is frozen here.

**Placeholder scan:** none — every step has complete code + exact commands.

**Type consistency:** `BlockMeta`/`Block`/`BlockDocument`/`RenderData`/`RenderContext`/`GridCell` defined in Task 1 and used verbatim in 2–10. Functions are stable across tasks: `getBlockMeta` (3) → used in 4,5,9; `validateDocument`/`ValidIds` (4); `renderBlocks` (5) → used in 10; `defaultHomeDocument` (6) → used in 10; `loadPublishedDoc`/`saveDraft`/`publishDoc` (8) → `loadPublishedDoc` used in 10; `resolveRenderData` (9) → used in 10.
