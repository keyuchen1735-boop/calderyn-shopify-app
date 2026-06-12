import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// `<Page fullWidth>` is a deliberate choice, not a default. Dense data surfaces
// (tables, multi-column tools) earn the full width; text- and form-heavy pages
// read better in Polaris's centered column — full width stretches their copy
// into thin, hard-to-scan lines. This test pins that policy so pages don't drift
// back to a blanket full-width.
//
// Convention: `fullWidth` is the first prop after `<Page`, so a file with an
// extra bare `<Page>` (e.g. an error/not-found state) still matches on its
// primary content page.
const FULL_WIDTH = /<Page\s+fullWidth\b/;

// Dense data / multi-column surfaces — full width is justified.
const FULL_WIDTH_PAGES = [
  "app.audit.tsx",
  "app.skus.tsx",
  "app.analytics._index.tsx",
  "app.campaigns._index.tsx",
  "app.alerts._index.tsx",
  "app.screener.tsx",
  "app.generator.tsx",
  "app.settings.tsx",
  "app.mcp.tsx",
];

// Text- / detail-heavy surfaces — stay in the centered column so narrative,
// titles, and side-by-side detail don't stretch edge to edge.
const CONSTRAINED_PAGES = [
  "app._index.tsx",
  "app.alerts.$id.tsx",
  "app.campaigns.$campaignId.tsx",
];

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("Page width is a deliberate per-surface choice", () => {
  it.each(FULL_WIDTH_PAGES)("%s renders <Page fullWidth>", (file) => {
    expect(read(file)).toMatch(FULL_WIDTH);
  });

  it.each(CONSTRAINED_PAGES)("%s stays centered (no fullWidth)", (file) => {
    expect(read(file)).not.toMatch(FULL_WIDTH);
  });
});
