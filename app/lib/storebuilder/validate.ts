// app/lib/storebuilder/validate.ts
// WRITE-TIME document validation — the publish path (the future generator #16 / editor #8) MUST
// call this before publishing, to drop fabricated catalog ids and disallowed/unknown blocks and
// (rule 12) surface every drop. The renderer (render.tsx) is INDEPENDENTLY defensive at read time
// (skips bad blocks; the shop-scoped resolver neutralizes any stale id), so this is the data-quality
// gate, not the only line of defense. Pure + isomorphic.
import type { BlockDocument, BlockType, PageKey } from "./types";
import { getBlockMeta } from "./registry";

export interface ValidIds { productIds: Set<string>; collectionHandles: Set<string> }
export interface DroppedRef { blockId: string; kind: "type" | "docKind" | "product" | "collection"; ref: string }
export interface ValidationResult { doc: BlockDocument; dropped: DroppedRef[]; missingFunctional: BlockType[] }

export function requiredFunctionalBlocks(pageKey: PageKey): BlockType[] {
  // productTitle is display, not buy-path, but a product page without the
  // product's name is as broken to a buyer as one without a buy button.
  return pageKey === "pdp" ? ["addToCart", "variantPicker", "price", "productTitle"] : [];
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
