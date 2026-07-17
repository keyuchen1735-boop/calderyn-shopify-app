import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardCtx } from "../../context";
import Analytics from "../Analytics";

function app(status: "connected" | "disconnected"): DashboardCtx {
  return {
    nav: { screen: "analytics", param: null, sub: "perf" },
    integrations: [{ key: "quickbooks", name: "QuickBooks", status, detail: "", logoCls: "" }],
    navigate: () => {},
    t: {},
  } as unknown as DashboardCtx;
}

describe("Analytics QuickBooks connection", () => {
  it("offers QuickBooks connection until the Profit & loss subtab is unlocked", () => {
    expect(renderToStaticMarkup(<Analytics app={app("disconnected")} />)).toContain("Connect QuickBooks");
    expect(renderToStaticMarkup(<Analytics app={app("connected")} />)).not.toContain("Connect QuickBooks");
  });
});
