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
      expect(recipe.versions.length).toBeGreaterThan(0);
      const activeVersion = recipe.versions.find((version) => version.templateVersion === recipe.activeVersion);
      expect(activeVersion).toBeDefined();
      expect(activeVersion?.baselineArtifact).toMatch(/^(app|docs|public)\//);
      expect(activeVersion?.screenshots.desktop).toMatch(/^public\//);
      expect(activeVersion?.screenshots.mobile).toMatch(/^public\//);
      expect(Object.keys(activeVersion?.routeBlueprints ?? {}).sort()).toEqual([
        "cart",
        "checkout",
        "collection",
        "home",
        "product",
        "search",
        "shell",
      ]);
      for (const blueprint of Object.values(activeVersion?.routeBlueprints ?? {})) {
        expect(blueprint.sourceRef).toMatch(/^app\//);
        expect(blueprint.compositionFamily.length).toBeGreaterThan(0);
        expect(blueprint.heroTreatment.length).toBeGreaterThan(0);
        expect(blueprint.scrollModel.length).toBeGreaterThan(0);
        expect(blueprint.displayFontId.length).toBeGreaterThan(0);
        expect(blueprint.bodyFontId.length).toBeGreaterThan(0);
        expect(blueprint.iconRules.length).toBeGreaterThan(0);
        expect(blueprint.cardTopology.length).toBeGreaterThan(0);
        expect(blueprint.protectedSlotPlacement.length).toBeGreaterThan(0);
        expect(blueprint.signatureInteractions.length).toBeGreaterThan(0);
        expect(blueprint.forbiddenGenericStructures.length).toBeGreaterThan(0);
        expect(Object.isFrozen(blueprint)).toBe(true);
        expect(Object.isFrozen(blueprint.iconRules)).toBe(true);
        expect(Object.isFrozen(blueprint.protectedSlotPlacement)).toBe(true);
        expect(Object.isFrozen(blueprint.signatureInteractions)).toBe(true);
        expect(Object.isFrozen(blueprint.forbiddenGenericStructures)).toBe(true);
      }
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.versions)).toBe(true);
      expect(Object.isFrozen(activeVersion)).toBe(true);
      expect(Object.isFrozen(activeVersion?.routeBlueprints)).toBe(true);
    }
    const semanticSignatures = STORE_TEMPLATE_REGISTRY.templates.map((recipe) => {
      const shell = recipe.versions.find((version) => version.templateVersion === recipe.activeVersion)!.routeBlueprints.shell;
      return [shell.compositionFamily, shell.heroTreatment, shell.scrollModel, shell.cardTopology].join("|");
    });
    expect(new Set(semanticSignatures).size).toBe(STORE_TEMPLATE_REGISTRY.templates.length);
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

  it("rejects missing active versions, incomplete blueprints, and unsafe artifact references", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    expect(() => createStoreTemplateRegistry([{ ...base, activeVersion: 99 }])).toThrow(/active version/i);
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: [
            {
              ...base.versions[0],
              routeBlueprints: {
                ...base.versions[0].routeBlueprints,
                shell: { ...base.versions[0].routeBlueprints.shell, sourceRef: "" },
              },
            },
          ],
        },
      ]),
    ).toThrow(/route blueprint/i);
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: [{ ...base.versions[0], baselineArtifact: "https://example.com/template.html" }],
        },
      ]),
    ).toThrow(/artifact reference/i);
  });

  it("rejects empty, duplicate, or non-distinct semantic blueprint metadata", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    const second = STORE_TEMPLATE_REGISTRY.templates[1];
    const active = base.versions[0];
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: [
            {
              ...active,
              routeBlueprints: {
                ...active.routeBlueprints,
                home: { ...active.routeBlueprints.home, signatureInteractions: [] },
              },
            },
          ],
        },
      ]),
    ).toThrow(/signature interactions/i);
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: [
            {
              ...active,
              routeBlueprints: {
                ...active.routeBlueprints,
                home: { ...active.routeBlueprints.home, iconRules: ["line icons", "line icons"] },
              },
            },
          ],
        },
      ]),
    ).toThrow(/duplicate icon rules/i);
    expect(() => createStoreTemplateRegistry([base, { ...second, versions: base.versions }])).toThrow(
      /duplicate semantic signature/i,
    );
  });
});
