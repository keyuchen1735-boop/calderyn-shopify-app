import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../dashboard.css", import.meta.url)), "utf8");

describe("Store Builder compact sidebar CSS", () => {
  it("keeps navigation icons at their original 18px size", () => {
    expect(css).toMatch(
      /\.cd-sidebar\[data-compact="1"\] \.cd-ask-btn > svg,[\s\S]*?\{[\s\S]*?width: 18px;[\s\S]*?height: 18px;[\s\S]*?flex: 0 0 18px;[\s\S]*?\}/,
    );
  });

  it("uses compact button geometry without enlarging the original rows", () => {
    const block = css.match(
      /\.cd-sidebar\[data-compact="1"\] \.cd-ask-btn,[\s\S]*?\.cd-sidebar\[data-compact="1"\] \.cd-nav-item \{([\s\S]*?)\}/,
    )?.[1];

    expect(block).toContain("width: 36px !important;");
    expect(block).toContain("min-width: 36px;");
    expect(block).not.toContain("min-height");
  });

  it("hides the Autopilot switch so the compact rail contains icons only", () => {
    expect(css).toMatch(
      /\.cd-sidebar\[data-compact="1"\] \.cd-apswitch \{[^}]*display: none;/,
    );
  });

  it("hides navigation labels in the compact rail before animation runs", () => {
    expect(css).toMatch(
      /\.cd-sidebar\[data-compact="1"\] \.cd-sidebar-copy \{[^}]*display: none;/,
    );
  });
});
