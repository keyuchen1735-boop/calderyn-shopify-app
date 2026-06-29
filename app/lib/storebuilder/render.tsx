// app/lib/storebuilder/render.tsx
// The single renderer, shared by the live storefront (published_json) and (later) the editor
// preview (draft_json). Pure and defensive: never throws, never blanks on a bad block.
import { createElement, type ReactNode } from "react";
import type { BlockDocument, RenderContext } from "./types";
import { getBlockMeta } from "./registry";

export function renderBlocks(doc: BlockDocument, ctx: RenderContext): ReactNode[] {
  return [...doc.blocks]
    // Optional-chain the layout: an untrusted/malformed block (no layout) must not throw out of
    // sort() and blank the whole page — it sorts as 0 and is rendered (or skipped) like any other.
    .sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0))
    .map((block) => {
      const meta = getBlockMeta(block.type);
      if (!meta) return null; // unknown type (forward-compat) → skip
      let props: Record<string, unknown>;
      try { props = meta.validateProps(block.props) as Record<string, unknown>; }
      catch { return null; } // defensive: skip a malformed block, never crash the page (docs may be unvalidated)
      return createElement(meta.Component as (a: { props: unknown; ctx: RenderContext }) => ReactNode, { key: block.id, props, ctx });
    });
}
