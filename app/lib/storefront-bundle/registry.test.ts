import { describe, expect, it } from "vitest";
import {
  STORE_TEMPLATE_REGISTRY,
  createStoreTemplateRegistry,
  getStoreTemplate,
} from "./registry";

describe("versioned storefront recipe registry", () => {
  it("registers all eleven stable recipe IDs with complete route and override metadata", () => {
    expect(STORE_TEMPLATE_REGISTRY.templates.map((recipe) => recipe.id)).toEqual([
      "custom-bench",
      "commons-index",
      "soft-chemistry",
      "companion-field-guide",
      "daily-protocol",
      "room-modes",
      "rep-rest",
      "diagnostic-deck",
      "ritual-almanac",
      "broadcast-patch-bay",
      "atelier-nine",
    ]);
    expect(STORE_TEMPLATE_REGISTRY.registryVersion).toBe(1);
    expect(STORE_TEMPLATE_REGISTRY.routingVersion).toBe(1);
    for (const recipe of STORE_TEMPLATE_REGISTRY.templates) {
      expect(recipe.activeVersion).toBe(1);
      expect(recipe.routeCapabilities).toEqual(["home", "collection", "product", "search", "cart", "checkout"]);
      expect(recipe.overrideSurface.designTokens.length).toBeGreaterThan(0);
      expect(recipe.overrideSurface.textSlots.length).toBeGreaterThan(0);
      expect(recipe.aliases.length).toBeGreaterThan(0);
      expect(recipe.strongPhrases.length).toBeGreaterThan(0);
      expect(recipe.promptTerms.length).toBeGreaterThan(1);
      expect(recipe.catalogTerms.length).toBeGreaterThan(1);
    }
    expect(getStoreTemplate("atelier-nine").name).toBe("Atelier Grid");
  });

  it("rejects duplicate IDs, globally ambiguous aliases, and duplicate dictionaries", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    expect(() => createStoreTemplateRegistry([base, { ...base }])).toThrow(/duplicate template id/i);
    expect(() =>
      createStoreTemplateRegistry([
        base,
        { ...STORE_TEMPLATE_REGISTRY.templates[1], aliases: [base.aliases[0]] },
      ]),
    ).toThrow(/duplicate template name or alias/i);
    expect(() => createStoreTemplateRegistry([{ ...base, promptTerms: ["engraved", "ENGRAVED"] }])).toThrow(
      /duplicate prompt term/i,
    );
  });

  it("rejects generic commerce dictionaries and incomplete route matrices", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    expect(() => createStoreTemplateRegistry([{ ...base, promptTerms: [...base.promptTerms, "product"] }])).toThrow(
      /generic commerce term/i,
    );
    expect(() => createStoreTemplateRegistry([{ ...base, routeCapabilities: ["home", "product"] }])).toThrow(
      /route capabilities/i,
    );
  });
});
