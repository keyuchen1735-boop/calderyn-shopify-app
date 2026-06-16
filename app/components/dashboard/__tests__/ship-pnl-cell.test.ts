import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { ShipPnlCell } from "../ship-pnl-cell";

describe("dashboard ShipPnlCell", () => {
  it("renders a profit in green with a + sign", () => {
    const html = renderToString(h(ShipPnlCell, { cents: 1800 }));
    expect(html).toContain("+$18");
    expect(html).toContain("var(--green)");
  });

  it("renders free-ship leakage in red", () => {
    const html = renderToString(h(ShipPnlCell, { cents: -21400 }));
    expect(html).toContain("-$214");
    expect(html).toContain("var(--red)");
  });

  it("renders a muted $0 when there is no shipping P&L (null)", () => {
    const html = renderToString(h(ShipPnlCell, { cents: null }));
    expect(html).toContain("$0");
    expect(html).toContain("var(--text-2)");
  });
});
