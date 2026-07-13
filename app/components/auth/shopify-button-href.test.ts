import { describe, expect, it } from "vitest";
import { shopifyButtonHref } from "./AuthCard";

describe("shopifyButtonHref", () => {
  it("login mode keeps the direct OAuth start", () => {
    expect(shopifyButtonHref("https://calderyncompany.com", null, "login")).toBe(
      "https://calderyncompany.com/dashboard/login",
    );
  });
  it("login mode threads return_to", () => {
    expect(shopifyButtonHref("", "/dashboard?x=1", "login")).toBe(
      "/dashboard/login?return_to=%2Fdashboard%3Fx%3D1",
    );
  });
  it("signup mode routes to signup with the shopify marker", () => {
    expect(shopifyButtonHref("https://calderyncompany.com", null, "signup")).toBe(
      "https://calderyncompany.com/signup?from=shopify",
    );
  });
  it("signup mode threads return_to after the marker", () => {
    expect(shopifyButtonHref("", "/dashboard", "signup")).toBe(
      "/signup?from=shopify&return_to=%2Fdashboard",
    );
  });
});
