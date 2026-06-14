import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CalderynHexMark } from "../CalderynHexMark";

describe("CalderynHexMark", () => {
  it("renders an accessible hexagon svg at the given size", () => {
    const html = renderToString(createElement(CalderynHexMark, { size: 32 }));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Calderyn"');
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
  });
});
