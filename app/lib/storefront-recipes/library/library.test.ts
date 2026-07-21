import { describe, expect, it } from "vitest";
import { compileHtml } from "../../storefront-compiler/html";
import { mergeRecipeFragments } from "./fragment";
import { storefrontRecipeMediaPath, videoFragment } from "./media";
import { cartProgressFragment, productRailFragment, proofBandFragment, stickyPurchaseFragment } from "./commerce";
import { motionAttributes } from "./motion";

describe("recipe fragment library", () => {
  it("merges behavior fragments without adding visual composition", () => {
    expect(mergeRecipeFragments({ html: "a", css: "b" }, { html: "c", css: "d" })).toEqual({ html: "ac", css: "bd" });
  });

  it("emits compiler-safe poster-first video with caller-owned classes", () => {
    const fragment = videoFragment({ className: "volt-film", posterAssetKey: "hero-poster", webmAssetKey: "hero-webm", mp4AssetKey: "hero-mp4" });
    expect(fragment.css).toBe("");
    expect(fragment.html).toContain('class="volt-film"');
    expect(compileHtml(fragment.html, { namespace: "home" }).html).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(storefrontRecipeMediaPath("larder", "a".repeat(64), "video/mp4")).toBe(`storefront-recipe-assets/larder/${"a".repeat(64)}.mp4`);
  });

  it("keeps commerce fragment layout and copy caller-owned", () => {
    expect(proofBandFragment({ className: "proof", copy: "Verified owners" }).html).toContain("Verified owners");
    expect(productRailFragment({ className: "rail", itemClassName: "card" }).css).toBe("");
    expect(stickyPurchaseFragment({ desktopClassName: "desk", mobileClassName: "mobile" }).html).toContain("data-cd-slot=\"addToCart\"");
    const cart = cartProgressFragment({ className: "progress", copy: "Free shipping progress", orderBumpCopy: "Add a travel case" }).html;
    expect(cart).toContain("Free shipping progress");
    expect(cart).toContain("Add a travel case");
  });

  it("emits only bounded declarative motion attributes", () => {
    expect(motionAttributes("reveal")).toBe('data-cd-motion="reveal"');
    expect(() => compileHtml(`<div ${motionAttributes("reveal")}></div>`, { namespace: "home" })).not.toThrow();
    expect(() => motionAttributes("spin" as "reveal")).toThrow(/motion/i);
  });
});
