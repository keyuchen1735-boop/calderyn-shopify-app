import { describe, expect, it } from "vitest";
import {
  CURATED_FONT_IDS,
  PUBLIC_BINDING_PATHS,
  isCuratedFontId,
  isPublicBindingPath,
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
});
