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
