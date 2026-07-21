import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STORE_TEMPLATE_REGISTRY,
  createStoreTemplateRegistry,
  getStoreTemplate,
} from "./registry";
import provenance from "../storefront-validation/design-provenance.json";

const EXPECTED_TEXT_SLOTS = {
  "custom-bench": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "commons-index": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "soft-chemistry": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "companion-field-guide": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading"],
  "daily-protocol": ["heroEyebrow", "heroTitle"],
  "room-modes": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "rep-rest": ["heroTitle", "ctaLabel"],
  "diagnostic-deck": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "ritual-almanac": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
  "broadcast-patch-bay": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
  "atelier-nine": ["announcement", "heroTitle", "heroBody", "ctaLabel"],
  larder: ["heroTitle", "heroBody", "ctaLabel"],
  volt: ["heroTitle", "heroBody", "ctaLabel"],
  atelier: ["heroTitle", "ctaLabel"],
  gilt: ["heroTitle", "ctaLabel"],
  ember: ["heroTitle", "heroBody", "ctaLabel"],
  roast: ["heroTitle", "heroBody", "ctaLabel"],
  fizz: ["heroTitle", "heroBody", "ctaLabel"],
  forge: ["heroTitle", "heroBody", "ctaLabel"],
  haven: ["heroTitle", "heroBody", "ctaLabel"],
  glow: ["heroTitle", "heroBody", "ctaLabel"],
} as const;

describe("versioned storefront recipe registry", () => {
  it("registers all twenty-one approved recipes with complete route and override metadata", () => {
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
      "larder",
      "volt",
      "atelier",
      "gilt",
      "ember",
      "roast",
      "fizz",
      "forge",
      "haven",
      "glow",
    ]);
    expect(STORE_TEMPLATE_REGISTRY.registryVersion).toBe(2);
    expect(STORE_TEMPLATE_REGISTRY.routingVersion).toBe(1);
    const activeVersions = {
      "custom-bench": 12,
      "commons-index": 11,
      "soft-chemistry": 14,
      "companion-field-guide": 10,
      "daily-protocol": 9,
      "room-modes": 10,
      "rep-rest": 9,
      "diagnostic-deck": 10,
      "ritual-almanac": 9,
      "broadcast-patch-bay": 11,
      "atelier-nine": 6,
      larder: 1,
      volt: 3,
      atelier: 3,
      gilt: 3,
      ember: 3,
      roast: 3,
      fizz: 3,
      forge: 4,
      haven: 3,
      glow: 3,
    } as const;
    for (const recipe of STORE_TEMPLATE_REGISTRY.templates) {
      expect(recipe.activeVersion).toBe(activeVersions[recipe.id as keyof typeof activeVersions]);
      expect(recipe.routeCapabilities).toEqual(["home", "collection", "product", "search", "cart", "checkout"]);
      expect(recipe.overrideSurface.designTokens.length).toBeGreaterThan(0);
      expect(recipe.overrideSurface.textSlots.length).toBeGreaterThan(0);
      expect(recipe.aliases.length).toBeGreaterThan(0);
      expect(recipe.strongPhrases.length).toBeGreaterThan(0);
      expect(recipe.promptTerms.length).toBeGreaterThan(1);
      expect(recipe.catalogTerms.length).toBeGreaterThan(1);
      expect(recipe.versions.length).toBeGreaterThan(0);
      for (const version of recipe.versions) {
        expect(provenance.artifacts).toHaveProperty(version.baselineArtifact);
        for (const [viewport, screenshot] of Object.entries(version.screenshots)) {
          const bytes = readFileSync(screenshot);
          expect(bytes.subarray(0, 4).toString("ascii"), `${recipe.id}@${version.templateVersion} ${viewport} baseline`).toBe("RIFF");
          expect(bytes.subarray(8, 12).toString("ascii"), `${recipe.id}@${version.templateVersion} ${viewport} baseline`).toBe("WEBP");
        }
      }
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

      const blueprintEntries = Object.entries(activeVersion!.routeBlueprints);
      expect(new Set(blueprintEntries.map(([, blueprint]) => blueprint.compositionFamily)).size).toBe(7);
      expect(new Set(blueprintEntries.map(([, blueprint]) => blueprint.heroTreatment)).size).toBe(7);
      expect(new Set(blueprintEntries.map(([, blueprint]) => blueprint.scrollModel)).size).toBe(7);
      expect(new Set(blueprintEntries.map(([, blueprint]) => blueprint.cardTopology)).size).toBe(7);
      expect(new Set(blueprintEntries.map(([, blueprint]) => blueprint.signatureInteractions.join("|"))).size).toBe(7);
      for (const [routeId, blueprint] of blueprintEntries) {
        expect(blueprint.compositionFamily).toMatch(new RegExp(`\\.${routeId}$`));
        expect(blueprint.heroTreatment).toMatch(new RegExp(`\\.${routeId}$`));
        expect(blueprint.scrollModel).toMatch(new RegExp(`\\.${routeId}$`));
        expect(blueprint.cardTopology).toMatch(new RegExp(`\\.${routeId}$`));
      }
    }
    const semanticSignatures = STORE_TEMPLATE_REGISTRY.templates.map((recipe) => {
      const shell = recipe.versions.find((version) => version.templateVersion === recipe.activeVersion)!.routeBlueprints.shell;
      return [shell.compositionFamily, shell.heroTreatment, shell.scrollModel, shell.cardTopology].join("|");
    });
    expect(new Set(semanticSignatures).size).toBe(STORE_TEMPLATE_REGISTRY.templates.length);
    expect(getStoreTemplate("atelier-nine").name).toBe("Atelier Grid");
    expect(getStoreTemplate("larder").previewSrc).toBe("/template-previews/larder.webp");
    expect(getStoreTemplate("larder").versions[0]?.visualLayer.fallbackAssetKey).toBe("hero-poster");
    expect(getStoreTemplate("volt").versions[0]?.routeBlueprints.home.protectedSlotPlacement).toContainEqual({
      slot: "bundleBuilder",
      region: "home.ecosystem-builder",
    });
  });

  it("requires descriptions, placeholders, heroes, and one visual surface", () => {
    for (const template of STORE_TEMPLATE_REGISTRY.templates) {
      const version = template.versions.find((candidate) => candidate.templateVersion === template.activeVersion);
      expect(version?.visualLayer.slotId).toMatch(/^visual:/);
      expect(version?.visualLayer.fallbackAssetKey).toBeTruthy();
      expect(version?.productPlaceholderAssetKey).toBeTruthy();
      expect(version?.routeBlueprints.product.protectedSlotPlacement).toContainEqual(
        expect.objectContaining({ slot: "productDescription" }),
      );
    }
  });

  it("advertises only the text slots present in each active bundle", () => {
    expect(Object.fromEntries(STORE_TEMPLATE_REGISTRY.templates.map((template) => [
      template.id,
      template.overrideSurface.textSlots,
    ]))).toEqual(EXPECTED_TEXT_SLOTS);
  });

  it("rejects duplicate or unresolved visual and product assets", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    const second = STORE_TEMPLATE_REGISTRY.templates[1];
    expect(() =>
      createStoreTemplateRegistry([
        base,
        {
          ...second,
          versions: second.versions.map((version) => ({
            ...version,
            visualLayer: { ...version.visualLayer, slotId: base.versions[0].visualLayer.slotId },
          })),
        },
      ]),
    ).toThrow(/duplicate visual slot/i);
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: base.versions.map((version) => ({
            ...version,
            visualLayer: { ...version.visualLayer, fallbackAssetKey: "missing" },
          })),
        },
      ]),
    ).toThrow(/owned visual fallback/i);
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: base.versions.map((version) => ({ ...version, productPlaceholderAssetKey: "missing" })),
        },
      ]),
    ).toThrow(/owned product placeholder/i);
  });

  it("rejects a registry fallback removed from its recipe manifest", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    expect(() => createStoreTemplateRegistry([{
      ...base,
      versions: base.versions.map((version, index) => index === 0
        ? { ...version, assets: { entries: [] } }
        : version),
    }])).toThrow(/owned visual fallback/i);
  });

  it("rejects collection or product blueprints without protected descriptions", () => {
    const base = STORE_TEMPLATE_REGISTRY.templates[0];
    for (const routeId of ["collection", "product"] as const) {
      expect(() =>
        createStoreTemplateRegistry([
          {
            ...base,
            versions: base.versions.map((version) => ({
              ...version,
              routeBlueprints: {
                ...version.routeBlueprints,
                [routeId]: {
                  ...version.routeBlueprints[routeId],
                  protectedSlotPlacement: version.routeBlueprints[routeId].protectedSlotPlacement.filter(
                    (placement) => placement.slot !== "productDescription",
                  ),
                },
              },
            })),
          },
        ]),
      ).toThrow(/product description placement/i);
    }
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
    expect(() =>
      createStoreTemplateRegistry([
        {
          ...base,
          versions: [
            {
              ...active,
              routeBlueprints: {
                ...active.routeBlueprints,
                home: active.routeBlueprints.shell,
              },
            },
          ],
        },
      ]),
    ).toThrow(/composition family|route semantic signature/i);
  });
});
