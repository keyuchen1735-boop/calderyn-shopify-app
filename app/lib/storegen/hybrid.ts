// app/lib/storegen/hybrid.ts
// Splices the AI-authored home fragment with REAL catalog blocks. The model drops
// empty marker divs (data-cd-products / data-cd-collections) where live commerce
// belongs; this splits the sanitized fragment at those markers and inserts genuine
// productGrid / collectionList blocks the storefront renderer already knows how to
// render — real images, prices and add-to-cart, not static lookalikes. Runs AFTER
// sanitizeStoreHtml (data-* attributes survive it), so it only ever sees clean HTML.
import type { Block } from "~/lib/storebuilder/types";
import type { ValidIds } from "~/lib/storebuilder/validate";

const WRAP_OPEN = '<div class="ai-store">';
// The value group is optional: sanitize-html re-serializes an empty attribute value
// (data-cd-collections="") as a bare valueless attribute (data-cd-collections).
const MARKER_RE = /<div\b[^>]*data-cd-(products|collections)(?:="([^"]*)")?[^>]*>\s*<\/div>/g;
const HEADING_RE = /data-cd-heading="([^"]*)"/;
// Enough for hero-grid-story-collections-closer; more reads as a template, not a design.
const MAX_CATALOG_BLOCKS = 3;
const HEADING_MAX = 80;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function headingOf(markerTag: string): string {
  const m = HEADING_RE.exec(markerTag);
  return m ? decodeEntities(m[1]).slice(0, HEADING_MAX) : "";
}

/** Split a sanitized ai-store home fragment on catalog markers into renderable blocks.
 *  Unrecognized structure degrades to the whole fragment as one rawHtml block — a
 *  splice must never be able to break an otherwise valid page. */
export function spliceCatalogBlocks(html: string, valid: ValidIds): Block[] {
  const single = (h: string): Block[] => [
    { id: "home-html", type: "rawHtml", props: { html: h }, layout: { x: 0, y: 0, w: 12, h: 12 } },
  ];
  if (!html.startsWith(WRAP_OPEN) || !html.endsWith("</div>")) return single(html);
  MARKER_RE.lastIndex = 0;
  if (!MARKER_RE.test(html)) return single(html);
  MARKER_RE.lastIndex = 0;

  // Peel the wrapper and its scoped <style> so every re-wrapped segment can carry
  // both — a segment without them would fall outside the .ai-store CSS scope.
  let inner = html.slice(WRAP_OPEN.length, -"</div>".length);
  let style = "";
  if (inner.startsWith("<style")) {
    const end = inner.indexOf("</style>");
    if (end !== -1) {
      style = inner.slice(0, end + "</style>".length);
      inner = inner.slice(end + "</style>".length);
    }
  }

  const blocks: Block[] = [];
  let y = 0;
  const pushRaw = (segment: string) => {
    if (!segment.trim()) return;
    blocks.push({
      id: `home-html-${y}`,
      type: "rawHtml",
      props: { html: `${WRAP_OPEN}${style}${segment}</div>` },
      layout: { x: 0, y: y++, w: 12, h: 8 },
    });
  };

  let catalogCount = 0;
  let pending = "";
  let last = 0;
  for (const m of inner.matchAll(MARKER_RE)) {
    pending += inner.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    if (catalogCount >= MAX_CATALOG_BLOCKS) continue; // marker stripped; segments merge
    pushRaw(pending);
    pending = "";
    const heading = headingOf(m[0]);
    if (m[1] === "products") {
      const handle = m[2] ?? "";
      const source = handle !== "all" && valid.collectionHandles.has(handle) ? { kind: "collection", handle } : { kind: "all" };
      blocks.push({
        id: `home-grid-${y}`,
        type: "productGrid",
        props: { heading, source },
        layout: { x: 0, y: y++, w: 12, h: 6 },
      });
    } else {
      blocks.push({
        id: `home-collections-${y}`,
        type: "collectionList",
        props: { heading },
        layout: { x: 0, y: y++, w: 12, h: 2 },
      });
    }
    catalogCount += 1;
  }
  pending += inner.slice(last);
  pushRaw(pending);
  return blocks;
}
