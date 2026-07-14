import type { CatalogRoutingEvidence, StoreDesignMode, StoreTemplateId } from "../types";

export interface RoutingCorpusFixture {
  name: string;
  prompt: string;
  expectedKind: "recipe" | "custom";
  templateId?: StoreTemplateId;
  reason?: "explicit_custom" | "low_confidence" | "ambiguous_recipe_names";
  evidence?: Partial<Omit<CatalogRoutingEvidence, "fingerprint">>;
}

export const REQUIRED_ROUTING_CORPUS: readonly RoutingCorpusFixture[] = [
  { name: "sustainable refill", prompt: "Build a sustainable refill shop", expectedKind: "recipe", templateId: "commons-index" },
  { name: "clean skincare", prompt: "A clean skincare store for sensitive skin", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "personalized gifts", prompt: "Personalized and custom engraved gifts", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "explicit Atelier", prompt: "Use Atelier Grid for my jewelry label", expectedKind: "recipe", templateId: "atelier-nine" },
  { name: "explicit custom beats niche", prompt: "Build a completely new skincare store from scratch", expectedKind: "custom", reason: "explicit_custom" },
  { name: "negative Atelier and product uniqueness", prompt: "Do not use Atelier; create something one of a kind", expectedKind: "custom", reason: "low_confidence" },
  { name: "one of a kind is product language", prompt: "One-of-a-kind engraved gifts", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "unique does not force custom", prompt: "Use Atelier and make it unique", expectedKind: "recipe", templateId: "atelier-nine" },
  { name: "negated scratch clause", prompt: "Don't build from scratch; use a clean skincare layout", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "positive name after negative name", prompt: "Don't use Atelier; use Soft Chemistry", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "ambiguous names", prompt: "Try Atelier Grid or Soft Chemistry", expectedKind: "custom", reason: "ambiguous_recipe_names" },
  { name: "ambiguous generic", prompt: "Make me a store", expectedKind: "custom", reason: "low_confidence" },
  {
    name: "empty pet catalog inference",
    prompt: "",
    expectedKind: "recipe",
    templateId: "companion-field-guide",
    evidence: {
      productTitles: ["Canine Joint Support"],
      productTypes: ["Pet supplement"],
      productTags: ["dog health"],
      collectionTitles: ["Pet Wellness"],
    },
  },
  { name: "standalone original request", prompt: "Make something completely new", expectedKind: "custom", reason: "explicit_custom" },
] as const;

export const INVALID_REQUESTS: ReadonlyArray<{
  name: string;
  value: unknown;
}> = [
  { name: "non object", value: null },
  { name: "unknown mode", value: { prompt: "x", mode: "surprise" } },
  { name: "missing prompt", value: { mode: "auto" } },
  { name: "recipe without id", value: { prompt: "", mode: "recipe" } },
  { name: "recipe with unknown id", value: { prompt: "", mode: "recipe", templateId: "missing" } },
  { name: "auto with id", value: { prompt: "x", mode: "auto", templateId: "atelier-nine" } },
  { name: "custom with id", value: { prompt: "x", mode: "custom", templateId: "atelier-nine" } },
  { name: "empty custom", value: { prompt: "  ", mode: "custom" } },
  { name: "overlong prompt", value: { prompt: "x".repeat(4_001), mode: "auto" } },
];

export const EMPTY_EVIDENCE_INPUT: Omit<CatalogRoutingEvidence, "fingerprint"> = {
  productTitles: [],
  productTypes: [],
  productTags: [],
  optionNames: [],
  collectionTitles: [],
};

export function request(prompt: string, mode: StoreDesignMode = "auto") {
  return { prompt, mode } as const;
}
