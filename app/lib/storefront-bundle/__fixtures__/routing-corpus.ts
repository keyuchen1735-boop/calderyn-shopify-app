import type { CatalogRoutingEvidence, StoreTemplateId } from "../types";

export interface RoutingCorpusFixture {
  name: string;
  prompt: string;
  expectedKind: "recipe";
  templateId?: StoreTemplateId;
  evidence?: Partial<Omit<CatalogRoutingEvidence, "fingerprint">>;
}

export const REQUIRED_ROUTING_CORPUS: readonly RoutingCorpusFixture[] = [
  { name: "sustainable refill", prompt: "Build a sustainable refill shop", expectedKind: "recipe", templateId: "commons-index" },
  { name: "clean skincare", prompt: "A clean skincare store for sensitive skin", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "personalized gifts", prompt: "Personalized and custom engraved gifts", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "daily wellness", prompt: "A daily wellness shop for health and wellness routines", expectedKind: "recipe", templateId: "daily-protocol" },
  { name: "connected home", prompt: "A smart home shop for connected home automation", expectedKind: "recipe", templateId: "room-modes" },
  { name: "training recovery", prompt: "A home fitness shop for workout gear and training recovery", expectedKind: "recipe", templateId: "rep-rest" },
  { name: "refurbished devices", prompt: "Certified refurbished electronics with device grading and warranty-tested inventory", expectedKind: "recipe", templateId: "diagnostic-deck" },
  { name: "functional drinks", prompt: "A functional beverage shop for adaptogenic drinks and daily rituals", expectedKind: "recipe", templateId: "ritual-almanac" },
  { name: "creator streaming", prompt: "A creator economy shop for streaming gear and broadcast equipment", expectedKind: "recipe", templateId: "broadcast-patch-bay" },
  { name: "explicit Atelier", prompt: "Use Atelier Grid for my jewelry label", expectedKind: "recipe", templateId: "atelier-nine" },
  { name: "from-scratch skincare remains approved", prompt: "Build a completely new skincare store from scratch", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "negative Atelier and product uniqueness", prompt: "Do not use Atelier; create something one of a kind", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "one of a kind is product language", prompt: "One-of-a-kind engraved gifts", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "unique does not force custom", prompt: "Use Atelier and make it unique", expectedKind: "recipe", templateId: "atelier-nine" },
  { name: "negated scratch clause", prompt: "Don't build from scratch; use a clean skincare layout", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "positive name after negative name", prompt: "Don't use Atelier; use Soft Chemistry", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "negated same-niche design", prompt: "Do not use Soft Chemistry; build a clean skincare store", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "coordinated negated designs", prompt: "Do not use Atelier or Soft Chemistry; build a clean skincare store", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "either-or negated designs", prompt: "Do not use either Atelier Grid or Soft Chemistry; build a clean skincare store", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "comma-list negated designs", prompt: "Do not use Atelier Grid, Soft Chemistry, or Daily Protocol; build a clean skincare store", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "neither-nor negated designs", prompt: "Use neither Atelier Grid nor Soft Chemistry; build a clean skincare store", expectedKind: "recipe", templateId: "custom-bench" },
  { name: "multiple names choose one recipe", prompt: "Try Atelier Grid or Soft Chemistry", expectedKind: "recipe", templateId: "soft-chemistry" },
  { name: "ambiguous generic", prompt: "Make me a store", expectedKind: "recipe", templateId: "custom-bench" },
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
  { name: "standalone original request", prompt: "Make something completely new", expectedKind: "recipe", templateId: "custom-bench" },
] as const;

export const EMPTY_EVIDENCE_INPUT: Omit<CatalogRoutingEvidence, "fingerprint"> = {
  productTitles: [],
  productTypes: [],
  productTags: [],
  optionNames: [],
  collectionTitles: [],
};

export function request(prompt: string) {
  return { prompt } as const;
}
