// app/lib/storebuilder/registry.ts
import type { BlockMeta, BlockType } from "./types";
import { STARTER_BLOCKS } from "./blocks";
import { STARTER_PRODUCT_BLOCKS } from "./blocks-product";

export const BLOCK_REGISTRY: Partial<Record<BlockType, BlockMeta>> = Object.fromEntries(
  [...STARTER_BLOCKS, ...STARTER_PRODUCT_BLOCKS].map((b) => [b.type, b]),
) as Partial<Record<BlockType, BlockMeta>>;

export function getBlockMeta(type: BlockType): BlockMeta | undefined {
  return BLOCK_REGISTRY[type];
}
