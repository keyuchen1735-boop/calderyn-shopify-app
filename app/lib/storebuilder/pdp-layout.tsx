// app/lib/storebuilder/pdp-layout.tsx
// The ONE column composition for doc-driven PDPs, shared by the live storefront and the
// dashboard previews so merchants approve the exact layout that publishes. .cd-pdp is a
// two-column grid; without explicit columns the doc's blocks auto-place into it and zigzag
// (title next to gallery, price under the gallery, add-to-cart orphaned). Compose the layout
// the doc actually encodes: half-width blocks (w<=6) bucket into left (x<6) and right (x>=6)
// columns; full-width blocks (w>6, e.g. a below-the-fold featureRow) span both columns,
// before or after the column pair by their y position. Callers wrap this in
// <article className="cd-pdp cd-pdp--blocks">.
import type { ReactNode } from "react";
import { renderBlocks } from "./render";
import type { Block, BlockDocument, RenderContext } from "./types";

export interface PdpBlockColumnsProps extends RenderContext {
  doc: BlockDocument;
  /** Rendered at the end of the right column (the storefront's DeliveryPromise slot). */
  children?: ReactNode;
}

export function PdpBlockColumns({ doc, data, record, links, children }: PdpBlockColumnsProps) {
  const sorted: Block[] = [...doc.blocks].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const left = sorted.filter((b) => b.layout.w <= 6 && b.layout.x < 6);
  const right = sorted.filter((b) => b.layout.w <= 6 && b.layout.x >= 6);
  const columnTopY = Math.min(...[...left, ...right].map((b) => b.layout.y), Infinity);
  const fullAbove = sorted.filter((b) => b.layout.w > 6 && b.layout.y < columnTopY);
  const fullBelow = sorted.filter((b) => b.layout.w > 6 && b.layout.y >= columnTopY);
  const sub = (blocks: Block[]) => renderBlocks({ ...doc, blocks }, { data, record, links });
  return (
    <>
      {fullAbove.length > 0 ? <div className="cd-pdp__col cd-pdp__col--full">{sub(fullAbove)}</div> : null}
      {left.length > 0 ? <div className="cd-pdp__col">{sub(left)}</div> : null}
      <div className={left.length > 0 ? "cd-pdp__col" : "cd-pdp__col cd-pdp__col--full"}>
        {sub(right)}
        {children}
      </div>
      {fullBelow.length > 0 ? <div className="cd-pdp__col cd-pdp__col--full">{sub(fullBelow)}</div> : null}
    </>
  );
}
