// app/lib/storegen/sanitize.ts
// Turn a raw BlockPlan (full props + layout, max model freedom) into a SAFE BlockDocument:
// clamp layout to the grid, bound copy length, assign stable ids, run validateDocument (drops
// unknown types / bad doc-kinds / fabricated ids — logging each), and guarantee the PDP buy-path
// blocks are present. The contract is unbreakable regardless of what the model emitted.
import type { BlockDocument, BlockType, DocKind, GridCell, PageKey } from "~/lib/storebuilder/types";
import { getBlockMeta } from "~/lib/storebuilder/registry";
import { validateDocument, requiredFunctionalBlocks, type ValidIds, type DroppedRef } from "~/lib/storebuilder/validate";
import type { BlockPlan, PlanBlock } from "./block-plan";

const COPY_BOUNDS: Record<string, number> = { headline: 120, subhead: 200, heading: 80, label: 40, html: 2000, title: 120 };

function clampLayout(raw: Partial<GridCell> | undefined, fallback: GridCell): GridCell {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  let x = Math.max(0, Math.round(num(raw?.x, fallback.x)));
  let w = Math.min(12, Math.max(1, Math.round(num(raw?.w, fallback.w))));
  const h = Math.max(1, Math.round(num(raw?.h, fallback.h)));
  const y = Math.max(0, Math.round(num(raw?.y, fallback.y)));
  if (x > 11) x = 11;
  if (x + w > 12) w = 12 - x;
  return { x, y, w, h };
}

function boundCopy(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  // richText's `html` prop is rendered as plain text (blocks.tsx never injects HTML), so any
  // markup the model emits there would show as literal angle brackets to shoppers — strip tags
  // before bounding length. Keyed on the BLOCK TYPE, never on the prop name: a rawHtml block's
  // `html` prop is genuinely HTML and must pass through untouched.
  if (type === "richText" && typeof out.html === "string") {
    out.html = (out.html as string).replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  for (const [k, max] of Object.entries(COPY_BOUNDS)) {
    if (typeof out[k] === "string" && (out[k] as string).length > max) out[k] = (out[k] as string).slice(0, max);
  }
  return out;
}

/** Inject any missing required functional block from registry defaults, mutating
 *  doc.blocks in place, stacked below the existing blocks in display order (price →
 *  variantPicker → addToCart, matching fallback.ts) — the required list is ordered by
 *  importance, so it's reversed for top-to-bottom stacking. Shared by the generator
 *  (assembleDocument, below) and the studio's publish-time guarantee
 *  (storebuilder/studio.server.ts) — a generated or published page can never lack its
 *  buy-path blocks. */
export function injectMissingFunctionalBlocks(doc: BlockDocument, pageKey: PageKey): void {
  const present = new Set(doc.blocks.map((b) => b.type));
  let y = doc.blocks.reduce((m, b) => Math.max(m, b.layout.y + b.layout.h), 0);
  for (const type of [...requiredFunctionalBlocks(pageKey)].reverse()) {
    if (present.has(type)) continue;
    const meta = getBlockMeta(type);
    if (!meta) continue;
    doc.blocks.push({ id: `${pageKey}-${type}-injected`, type, props: { ...meta.defaultProps }, layout: { ...meta.defaultLayout, y } });
    y += meta.defaultLayout.h;
  }
}

export function assembleDocument(
  pageKey: PageKey, kind: DocKind, plan: BlockPlan, valid: ValidIds,
): { doc: BlockDocument; dropped: DroppedRef[] } {
  // 1) plan blocks → Block[] with clamped layout, bounded copy, stable ids.
  const blocks = plan.blocks.map((b: PlanBlock, i: number) => {
    const meta = getBlockMeta(b.type as BlockType);
    const fallbackLayout = meta?.defaultLayout ?? { x: 0, y: i, w: 12, h: 2 };
    return {
      id: `${pageKey}-${b.type}-${i}`,
      type: b.type as BlockType,
      props: boundCopy(b.type, b.props),
      layout: clampLayout(b.layout, fallbackLayout),
    };
  });

  // 2) validateDocument drops unknown types / bad doc-kinds / fabricated ids and coerces props.
  const result = validateDocument({ kind, pageKey, blocks }, valid);

  // 3) PDP buy-path guarantee: inject any missing required functional block from its defaults.
  injectMissingFunctionalBlocks(result.doc, pageKey);
  return { doc: result.doc, dropped: result.dropped };
}
