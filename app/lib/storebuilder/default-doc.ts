// app/lib/storebuilder/default-doc.ts
// The never-blank guarantee (rule 12): when a shop has no published home doc yet, the
// storefront renders this. Uses only the `all` grid source so it needs no specific catalog ids.
import type { BlockDocument } from "./types";

export function defaultHomeDocument(): BlockDocument {
  return {
    kind: "singleton",
    pageKey: "home",
    blocks: [
      { id: "default-hero", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 },
        props: { headline: "Welcome", subhead: "Shop our latest" } },
      { id: "default-grid", type: "productGrid", layout: { x: 0, y: 2, w: 12, h: 6 },
        props: { source: { kind: "all" }, heading: "Shop all" } },
    ],
  };
}
