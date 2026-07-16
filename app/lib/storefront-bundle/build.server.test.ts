import { describe, expect, it } from "vitest";
import { isStorefrontBundlePublishEnabled, isStorefrontRecipeBuildEnabled } from "./build.server";

describe("storefront bundle switches", () => {
  it("requires an explicit truthy value for recipe writes", () => {
    expect(isStorefrontRecipeBuildEnabled(undefined)).toBe(false);
    expect(isStorefrontRecipeBuildEnabled("0")).toBe(false);
    expect(isStorefrontRecipeBuildEnabled("true")).toBe(true);
  });

  it("requires an explicit truthy value for publishing", () => {
    expect(isStorefrontBundlePublishEnabled(undefined)).toBe(false);
    expect(isStorefrontBundlePublishEnabled("0")).toBe(false);
    expect(isStorefrontBundlePublishEnabled("1")).toBe(true);
  });
});
