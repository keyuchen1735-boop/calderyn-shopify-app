import { describe, expect, it, vi } from "vitest";
import { COMMONS_INDEX_RECIPE } from "../storefront-recipes/commons-index/bundle";
import type { CompiledNode, StorefrontBundleV1 } from "./types";
import { personalizeStorefrontRecipe } from "./personalize.server";

vi.mock("../storefront-ai/provider.server", () => ({
  createAnthropicStructuredProvider: vi.fn(() => { throw new Error("provider should not be constructed"); }),
}));

function structure(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [`${node.tag}:${node.id}`, ...structure(node.children)]);
}

function bundleStructure(bundle: StorefrontBundleV1) {
  return {
    shell: structure(bundle.shell.tree),
    home: structure(bundle.routes.home.tree),
    collection: structure(bundle.routes.collection.tree),
    product: structure(bundle.routes.product.tree),
    search: structure(bundle.routes.search.tree),
    cart: structure(bundle.routes.cart.tree),
    checkout: structure(bundle.routes.checkout.decorativeTree),
  };
}

describe("recipe personalization", () => {
  it("installs an unchanged recipe without constructing a provider when the prompt is empty", async () => {
    const recipe = structuredClone(COMMONS_INDEX_RECIPE);

    await expect(personalizeStorefrontRecipe({
      recipe,
      prompt: "   ",
      evidence: {
        productTitles: [],
        productTypes: [],
        productTags: [],
        optionNames: [],
        collectionTitles: [],
        fingerprint: "sha256:test",
      },
      signal: new AbortController().signal,
    })).resolves.toBe(recipe);
  });

  it("changes only bounded copy and colors while preserving template structure and CSS", async () => {
    const recipe = structuredClone(COMMONS_INDEX_RECIPE);
    const before = structuredClone(recipe.bundle);
    const provider = {
      complete: vi.fn(async () => ({
        value: {
          accentColor: "#14532d",
          backgroundColor: "#fffdf5",
          heroTitle: "Refill rituals for everyday life",
          heroBody: "Low-waste essentials selected for repeat use.",
        },
        usage: { inputTokens: 10, outputTokens: 10 },
        provider: "fixture",
        model: "fixture",
      })),
    };

    const result = await personalizeStorefrontRecipe({
      recipe,
      prompt: "A calm refill store for low-waste households",
      evidence: {
        productTitles: ["Refill soap"],
        productTypes: ["refill"],
        productTags: ["low waste"],
        optionNames: [],
        collectionTitles: ["Daily refills"],
        fingerprint: "sha256:test",
      },
      signal: new AbortController().signal,
    }, provider);

    expect(result.bundle.source).toEqual(before.source);
    expect(bundleStructure(result.bundle)).toEqual(bundleStructure(before));
    expect(result.bundle.shell.css).toBe(before.shell.css);
    for (const route of ["home", "collection", "product", "search", "cart"] as const) {
      expect(result.bundle.routes[route].css).toBe(before.routes[route].css);
    }
    expect(result.bundle.routes.checkout.decorativeCss).toBe(before.routes.checkout.decorativeCss);
    expect(result.bundle.designSystem.tokens).toMatchObject({ signal: "#14532d", paper: "#fffdf5" });
    expect(result.bundle.routes.home.html).toContain("Refill rituals for everyday life");
    expect(result.bundle.routes.home.html).toContain("Low-waste essentials selected for repeat use.");
    expect(result.report.ok).toBe(true);
    expect(provider.complete).toHaveBeenCalledOnce();
  });
});
