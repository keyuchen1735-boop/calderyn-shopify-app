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
});
