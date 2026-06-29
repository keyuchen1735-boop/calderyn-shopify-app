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
