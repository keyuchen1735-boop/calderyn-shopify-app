import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { ShipPnlText } from "../ship-pnl-text";

describe("embedded ShipPnlText", () => {
  it("renders a profit value with the success tone", () => {
    const html = renderToString(h(ShipPnlText, { cents: 1800 }));
    expect(html).toContain("+$18");
    expect(html).toMatch(/success/i);
  });

  it("renders free-ship leakage with the critical tone", () => {
    const html = renderToString(h(ShipPnlText, { cents: -21400 }));
    expect(html).toContain("-$214");
    expect(html).toMatch(/critical/i);
  });

  it("renders a subdued dash (no data) when ship P&L is null", () => {
    const html = renderToString(h(ShipPnlText, { cents: null }));
    expect(html).toContain("—");
    expect(html).toMatch(/subdued/i);
  });
});
