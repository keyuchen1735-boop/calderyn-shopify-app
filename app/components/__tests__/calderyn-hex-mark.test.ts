import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CalderynHexMark, CALDERYN_MARK_PATH } from "../CalderynHexMark";

describe("CalderynHexMark", () => {
  it("renders an accessible hexagon svg at the given size", () => {
    const html = renderToString(createElement(CalderynHexMark, { size: 32 }));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Calderyn"');
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
  });

  it("renders the hexagon-C as a single monochrome even-odd path", () => {
    const html = renderToString(createElement(CalderynHexMark, {}));
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain(CALDERYN_MARK_PATH);
  });

  it("accepts an explicit color", () => {
    const html = renderToString(createElement(CalderynHexMark, { color: "#fff" }));
    expect(html).toContain('fill="#fff"');
  });

  // The mark has four subpaths: outer hexagon, ring hole, core, and the
  // right-side bridge that closes the C. Losing one silently changes the logo.
  it("keeps all four mark subpaths", () => {
    expect(CALDERYN_MARK_PATH.match(/M/g)).toHaveLength(4);
  });
});
