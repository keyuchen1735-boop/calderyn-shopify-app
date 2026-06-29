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
