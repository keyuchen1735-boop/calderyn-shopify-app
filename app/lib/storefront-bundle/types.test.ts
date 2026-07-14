import { describe, expect, it } from "vitest";
import {
  CURATED_FONT_IDS,
  PUBLIC_BINDING_PATHS,
  isCuratedFontId,
  isPublicBindingPath,
  type RouteArtifact,
} from "./types";

describe("closed runtime-1 value vocabularies", () => {
  it("accepts curated self-hosted font IDs and rejects arbitrary identifiers", () => {
    expect(CURATED_FONT_IDS).toContain("ibm-plex-mono");
    expect(isCuratedFontId("ibm-plex-mono")).toBe(true);
    expect(isCuratedFontId("https://fonts.example/font.woff2")).toBe(false);
    expect(isCuratedFontId("merchant-font-name")).toBe(false);
  });

  it("accepts public presentation bindings and rejects internal or executable paths", () => {
    expect(PUBLIC_BINDING_PATHS).toContain("product.title");
    expect(isPublicBindingPath("product.title")).toBe(true);
    expect(isPublicBindingPath("product.shop_id")).toBe(false);
    expect(isPublicBindingPath("cart.lines[0].constructor")).toBe(false);
  });

  it("keeps release-pinned tagline copy out of live public bindings", () => {
    expect(PUBLIC_BINDING_PATHS).not.toContain("store.tagline");
    expect(isPublicBindingPath("store.tagline")).toBe(false);
  });
});

describe("compiled route representation", () => {
  it("makes the serializable tree and closed binding plan first-class", () => {
    const route = {
      html: '<h1 id="cd-home-heading"></h1>',
      tree: [{ kind: "element", id: "cd-home-heading", tag: "h1", attributes: {}, children: [] }],
      bindings: [
        {
          id: "binding-1",
          targetId: "cd-home-heading",
          kind: "text",
          ref: { kind: "data", scopeId: "root", path: "store.name" },
        },
      ],
      css: "",
      requiredData: [{ kind: "storeIdentity" }],
      requiredCapabilities: [],
      interactions: { version: 1, state: [], bindings: [], transitions: [] },
      trustedSlots: [],
    } satisfies RouteArtifact;

    expect(route.tree[0]?.kind).toBe("element");
    expect(route.bindings[0]?.ref.path).toBe("store.name");
  });
});
