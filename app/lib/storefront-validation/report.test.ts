import { describe, expect, it } from "vitest";
import { createBrowserProofReport, mergeBrowserProofReports } from "./report";

describe("browser proof reports", () => {
  it("sorts and de-duplicates deterministic diagnostics and screenshot references", () => {
    const report = createBrowserProofReport({
      diagnostics: [
        { routeId: "product", code: "asset.failed", message: "hero failed", viewport: "mobile" },
        { routeId: "home", code: "console.error", message: "boom", viewport: "desktop" },
        { routeId: "home", code: "console.error", message: "boom", viewport: "desktop" },
      ],
      screenshots: ["sha256:b", "sha256:a", "sha256:a"],
      browserMs: 12.8,
    });

    expect(report.ok).toBe(false);
    expect(report.diagnostics).toHaveLength(2);
    expect(report.diagnostics[0]).toMatchObject({ routeId: "home", code: "console.error" });
    expect(report.screenshots).toEqual(["sha256:a", "sha256:b"]);
    expect(report.browserMs).toBe(13);
  });

  it("merges independent proof batches without losing elapsed browser time", () => {
    const merged = mergeBrowserProofReports([
      createBrowserProofReport({ diagnostics: [], screenshots: ["one"], browserMs: 5 }),
      createBrowserProofReport({
        diagnostics: [{ routeId: "cart", code: "checkout.boundary", message: "missing" }],
        screenshots: ["two"],
        browserMs: 8,
      }),
    ]);

    expect(merged.ok).toBe(false);
    expect(merged.browserMs).toBe(13);
    expect(merged.screenshots).toEqual(["one", "two"]);
  });
});
