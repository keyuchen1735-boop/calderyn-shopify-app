// Pure builders for the text the designer model reads on an edit turn, plus the
// merchant-facing summary of what a turn changed. Kept out of engine.server.ts
// (which pulls in Anthropic/Supabase) so both stay unit-testable on their own.
import type { DesignerChange, DesignerRoute, DesignerStoreData } from "./types";

/** The current file bodies the model may edit: base.css plus the html+css for
 *  the single page under discussion. Other routes are withheld — an edit to a
 *  page the model never read would rewrite it blind. */
export function fileContext(files: Record<string, string>, route: DesignerRoute): string {
  const sections = [
    ["base.css", files["base.css"] ?? ""],
    [`${route}.html`, files[`${route}.html`] ?? ""],
    [`${route}.css`, files[`${route}.css`] ?? ""],
  ] as const;
  return sections.map(([name, body]) => `===== ${name} =====\n${body}`).join("\n\n");
}

/** The full edit-turn context: who the store is, what it sells, the page in
 *  focus, and the current files — with an explicit frame that these files are
 *  the store's OWN work. Earlier builds sometimes baked a fabricated brand name
 *  into the markup (e.g. an alt attribute); on later turns the model read it
 *  back, decided the merchant had pasted another store's code, and refused the
 *  edit while offering to rebuild. This framing pre-empts that failure. */
export function editContext(
  data: DesignerStoreData,
  route: DesignerRoute,
  files: Record<string, string>,
): string {
  const name = data.storeName;
  return [
    `STORE: ${name}${data.tagline ? ` — ${data.tagline}` : ""}`,
    `PRODUCTS: ${data.products.map((product) => product.title).join("; ").slice(0, 800)}`,
    `PAGE BEING EDITED: ${route}`,
    "",
    `These are ${name}'s OWN current storefront files — your own prior work on this store, never code the merchant pasted from somewhere else. If any other brand or store name appears anywhere in the markup, it is a stray leftover to correct to "${name}", not evidence the files belong to another store: never claim the code is another brand's, never ask the merchant to paste or rebuild their files, just make the change they asked for.`,
    "",
    fileContext(files, route),
  ].join("\n");
}

/** The one merchant-facing name per designer route — the page picker and the
 *  edit-result card must agree, so both read from here. */
export const DESIGNER_PAGE_LABELS: Record<DesignerRoute, string> = {
  home: "Home page",
  collection: "Collection page",
  product: "Product page",
  search: "Search page",
  cart: "Cart page",
  checkout: "Checkout page",
};

/** Merchant-facing label for a document filename. A page's html+css collapse to
 *  one page label; base.css is the shared "Site styles". */
function surfaceLabel(filename: string): string {
  if (filename === "base.css") return "Site styles";
  const route = filename.replace(/\.(html|css)$/i, "");
  return (
    DESIGNER_PAGE_LABELS[route as DesignerRoute] ??
    `${route.charAt(0).toUpperCase()}${route.slice(1)} page`
  );
}

/** Lines added/removed between two versions of a file, order-insensitive: a
 *  multiset compare so reordered lines don't inflate the count. Honest enough
 *  for a "what changed" chip without shipping a full LCS diff. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  // "" is an empty document (0 lines), not a document with one empty line —
  // without this, filling an empty file reports a phantom -1.
  const lines = (text: string): string[] => (text === "" ? [] : text.split("\n"));
  const counts = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines(text)) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = counts(before);
  const b = counts(after);
  let common = 0;
  for (const [line, n] of a) common += Math.min(n, b.get(line) ?? 0);
  return {
    added: Math.max(0, lines(after).length - common),
    removed: Math.max(0, lines(before).length - common),
  };
}

/** Group the files a turn changed into merchant-facing surfaces with real line
 *  deltas, for the edit-result card. Unchanged files are skipped; a page's html
 *  and css fold into one row. */
export function summarizeChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): DesignerChange[] {
  const byLabel = new Map<string, { added: number; removed: number }>();
  for (const name of Object.keys(after)) {
    const prev = before[name] ?? "";
    const next = after[name];
    if (prev === next) continue;
    // A changed file always gets a row, even at 0/0 — a reorder-only edit
    // (moved sections) still deserves its "Updated your store" confirmation.
    const { added, removed } = lineDelta(prev, next);
    const label = surfaceLabel(name);
    const acc = byLabel.get(label) ?? { added: 0, removed: 0 };
    acc.added += added;
    acc.removed += removed;
    byLabel.set(label, acc);
  }
  // Pages first, "Site styles" last — the merchant reads the page they see, then
  // the shared styles.
  return [...byLabel.entries()]
    .map(([label, delta]) => ({ label, ...delta }))
    .sort((x, y) => (x.label === "Site styles" ? 1 : 0) - (y.label === "Site styles" ? 1 : 0));
}
