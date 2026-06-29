// app/lib/storebuilder/registry.ts
import type { BlockMeta, BlockType } from "./types";
import { STARTER_BLOCKS } from "./blocks";

export const BLOCK_REGISTRY: Partial<Record<BlockType, BlockMeta>> = Object.fromEntries(
  STARTER_BLOCKS.map((b) => [b.type, b]),
) as Partial<Record<BlockType, BlockMeta>>;

export function getBlockMeta(type: BlockType): BlockMeta | undefined {
  return BLOCK_REGISTRY[type];
}
