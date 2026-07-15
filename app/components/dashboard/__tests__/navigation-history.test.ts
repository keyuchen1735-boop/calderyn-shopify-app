import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard navigation history", () => {
  it("lets Remix own page history so Back receives valid router entries", () => {
    const source = readFileSync(
      new URL("../DashboardApp.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("window.history.pushState");
    expect(source).toContain('navigationType === "POP"');
  });

  it("keeps tour previews in place so route loaders cannot remount the tour", () => {
    const source = readFileSync(
      new URL("../DashboardApp.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const previewTourDestination = useCallback");
    expect(source).toContain("onDemoNavigate={previewTourDestination}");
    expect(source).not.toContain("onDemoNavigate={navigate}");
    expect(source).toMatch(
      /const handleTourOutcome[\s\S]*?navigate\("dashboard"\);[\s\S]*?setTourOpen\(false\)/,
    );
  });
});
