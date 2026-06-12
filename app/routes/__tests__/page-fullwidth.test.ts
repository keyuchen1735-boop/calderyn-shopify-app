import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Every embedded-admin feature surface uses the full page width (Polaris
// <Page fullWidth>), so the working pages share one layout instead of a
// narrow centered column — matching the audit log and using the horizontal
// space the data-dense screens need.
//
// Focused flows are intentionally EXCLUDED and stay centered: the onboarding
// wizard and the auth/oauth screens read better as a narrow single column.
//
// Convention: `fullWidth` is the first prop after `<Page`, so a file with an
// extra bare `<Page>` (e.g. an error/not-found state) still matches on its
// primary content page.
const FEATURE_PAGES = [
  "app._index.tsx",
  "app.alerts._index.tsx",
  "app.alerts.$id.tsx",
  "app.analytics._index.tsx",
  "app.audit.tsx",
  "app.campaigns._index.tsx",
  "app.campaigns.$campaignId.tsx",
  "app.skus.tsx",
  "app.settings.tsx",
  "app.screener.tsx",
  "app.generator.tsx",
  "app.mcp.tsx",
];

describe("feature pages use the full page width", () => {
  it.each(FEATURE_PAGES)("%s renders <Page fullWidth>", (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(src).toMatch(/<Page\s+fullWidth\b/);
  });
});
