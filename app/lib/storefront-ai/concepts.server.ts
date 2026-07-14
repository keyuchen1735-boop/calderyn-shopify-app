import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { isCuratedFontId } from "../storefront-bundle/types";
import { isCompilerIdentifier } from "../storefront-compiler/assets";
import { assertSafeDesignTokenValue, compileCss } from "../storefront-compiler/css";
import { compileHtml } from "../storefront-compiler/html";
import type { RouteSource } from "../storefront-compiler/compile";
import { renderStorefrontRoute } from "../storefront-runtime/render";
import type { PublicPresentationData, PublicProduct } from "../storefront-runtime/public-data.server";
import type {
  CompiledConcept,
  ConceptCandidateSource,
  ConceptStrategy,
  ExploredConcept,
  MerchantStorefrontContext,
  StorefrontAiProvider,
  StructuredModelResponse,
} from "./contracts";
import { CONCEPT_SCHEMA, COMPILER_SYSTEM_PROMPT, conceptPrompt, conceptRepairPrompt } from "./prompts";

export interface ExploreConceptsInput {
  context: MerchantStorefrontContext;
  provider: StorefrontAiProvider;
  compileConcept?: (candidate: ConceptCandidateSource) => CompiledConcept;
  signal?: AbortSignal;
  onModelCall?: (operation: "concept" | "repairConcept", response: StructuredModelResponse) => void;
}

export interface ExploreConceptsResult {
  candidates: ExploredConcept[];
  rejected: Array<{ strategy: ConceptStrategy; candidateId: string; reason: string }>;
  repairs: number;
}

const STRATEGIES: readonly ConceptStrategy[] = ["asymmetric-commerce", "narrative-utility", "spatial-catalog"];

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max = 40_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a bounded non-empty string`);
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  const source = record(value, field);
  const entries = Object.entries(source);
  if (entries.length > 80) throw new Error(`${field} has too many entries`);
  return Object.fromEntries(entries.map(([key, child]) => [key, string(child, `${field}.${key}`, 500)]));
}

function numberMap(value: unknown, field: string): Record<string, number> {
  const source = record(value, field);
  const entries = Object.entries(source);
  if (entries.length > 16) throw new Error(`${field} has too many entries`);
  return Object.fromEntries(entries.map(([key, child]) => {
    if (typeof child !== "number" || !Number.isFinite(child)) throw new Error(`${field}.${key} must be a number`);
    return [key, child];
  }));
}

function routeSource(value: unknown, field: string): RouteSource {
  const source = record(value, field);
  if (!Array.isArray(source.requiredData) || !Array.isArray(source.requiredCapabilities)) {
    throw new Error(`${field} must declare bounded data and capability arrays`);
  }
  return {
    html: string(source.html, `${field}.html`, 250_000),
    css: typeof source.css === "string" && source.css.length <= 250_000 ? source.css : (() => { throw new Error(`${field}.css must be bounded`); })(),
    requiredData: source.requiredData as RouteSource["requiredData"],
    requiredCapabilities: source.requiredCapabilities as RouteSource["requiredCapabilities"],
    ...(typeof source.rootScopeKind === "string" ? { rootScopeKind: source.rootScopeKind as RouteSource["rootScopeKind"] } : {}),
  };
}

export function parseConceptCandidate(value: unknown): ConceptCandidateSource {
  const source = record(value, "concept");
  const concept = record(source.concept, "concept.concept");
  const novelty = record(concept.noveltySignature, "concept.noveltySignature");
  const design = record(source.designSystem, "concept.designSystem");
  if (!isCuratedFontId(design.displayFontId) || !isCuratedFontId(design.bodyFontId)) {
    throw new Error("Concept fonts must use curated self-hosted IDs");
  }
  if (!Array.isArray(source.assetRequests) || source.assetRequests.length > 8) throw new Error("assetRequests must be a bounded array");
  const assetRequests = source.assetRequests.map((item, index) => {
    const asset = record(item, `assetRequests.${index}`);
    const key = string(asset.key, `assetRequests.${index}.key`, 80);
    if (!isCompilerIdentifier(key)) throw new Error(`Invalid asset request key ${key}`);
    if (typeof asset.required !== "boolean") throw new Error("Asset request required must be boolean");
    if (asset.aspectRatio !== undefined && (typeof asset.aspectRatio !== "number" || asset.aspectRatio <= 0 || asset.aspectRatio > 8)) {
      throw new Error("Asset request aspect ratio is invalid");
    }
    return {
      key,
      purpose: string(asset.purpose, `assetRequests.${index}.purpose`, 500),
      required: asset.required,
      ...(typeof asset.aspectRatio === "number" ? { aspectRatio: asset.aspectRatio } : {}),
    };
  });
  return {
    candidateId: string(source.candidateId, "candidateId", 100),
    concept: {
      name: string(concept.name, "concept.name", 120),
      rationale: string(concept.rationale, "concept.rationale", 2_000),
      noveltySignature: {
        layoutTopology: string(novelty.layoutTopology, "novelty.layoutTopology", 300),
        typeTreatment: string(novelty.typeTreatment, "novelty.typeTreatment", 300),
        sectionSequence: string(novelty.sectionSequence, "novelty.sectionSequence", 300),
        navigationModel: string(novelty.navigationModel, "novelty.navigationModel", 300),
        interactionStyle: string(novelty.interactionStyle, "novelty.interactionStyle", 300),
      },
    },
    designSystem: {
      displayFontId: design.displayFontId,
      bodyFontId: design.bodyFontId,
      tokens: stringMap(design.tokens, "designSystem.tokens"),
      breakpoints: numberMap(design.breakpoints, "designSystem.breakpoints"),
      iconStyle: string(design.iconStyle, "designSystem.iconStyle", 120),
      motionStyle: string(design.motionStyle, "designSystem.motionStyle", 120),
      globalCss: typeof design.globalCss === "string" && design.globalCss.length <= 250_000 ? design.globalCss : (() => { throw new Error("globalCss must be bounded"); })(),
    },
    shell: routeSource(source.shell, "shell"),
    home: routeSource(source.home, "home"),
    assetRequests,
  };
}

export function compileConceptCandidate(candidate: ConceptCandidateSource): CompiledConcept {
  for (const [key, value] of Object.entries(candidate.designSystem.tokens)) {
    if (!isCompilerIdentifier(key)) throw new Error(`Invalid design token ${key}`);
    assertSafeDesignTokenValue(key, value);
  }
  for (const [key, value] of Object.entries(candidate.designSystem.breakpoints)) {
    if (!isCompilerIdentifier(key) || !Number.isFinite(value) || value < 240 || value > 3_840) throw new Error(`Invalid breakpoint ${key}`);
  }
  const shellHtml = compileHtml(candidate.shell.html, { namespace: "shell", rootScopeKind: "store" });
  const homeHtml = compileHtml(candidate.home.html, { namespace: "home", rootScopeKind: "store" });
  const protectedNodes = [...shellHtml.protectedCssNodes, ...homeHtml.protectedCssNodes];
  const protectedSourceIds = [...shellHtml.protectedSourceIds, ...homeHtml.protectedSourceIds];
  const shellCss = compileCss(candidate.shell.css, { namespace: "shell", protectedNodes: shellHtml.protectedCssNodes, protectedSourceIds: shellHtml.protectedSourceIds });
  const homeCss = compileCss(candidate.home.css, { namespace: "home", protectedNodes: homeHtml.protectedCssNodes, protectedSourceIds: homeHtml.protectedSourceIds });
  const globalCss = compileCss(candidate.designSystem.globalCss, { namespace: "global", protectedNodes, protectedSourceIds });
  const compiledFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    candidateId: candidate.candidateId,
    shell: shellHtml.tree,
    home: homeHtml.tree,
    css: [shellCss.css, homeCss.css, globalCss.css],
    designSystem: candidate.designSystem,
  })).digest("hex")}`;
  return { candidate, compiledFingerprint };
}

function presentationProduct(product: MerchantStorefrontContext["products"][number]): PublicProduct {
  const price = product.priceMin > 0 ? { cents: product.priceMin, currency: product.currency } : null;
  const available = product.availability !== "sold_out";
  const images = product.images.map((image) => ({ url: `/__owned_asset__/${encodeURIComponent(image.assetKey)}`, alt: product.title }));
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: "",
    primaryImage: images[0] ?? null,
    images,
    options: product.optionNames.map((name) => ({ name, values: [] })),
    variants: [{
      id: `${product.id}:representative`,
      title: "Representative variant",
      price: price ?? { cents: 0, currency: product.currency },
      compareAtPrice: null,
      availability: available ? "In stock" : "Sold out",
      available,
    }],
    price,
    compareAtPrice: null,
    availability: available ? "In stock" : "Sold out",
  };
}

/** Compiler-tree render used by the visual judge. Merchant strings remain data
 * bindings and pass through React escaping; no source string interpolation. */
export async function renderConceptWithMerchantData(input: {
  candidate: ExploredConcept;
  context: MerchantStorefrontContext;
}): Promise<{ desktop: string; mobile: string }> {
  const { candidate, context } = input;
  const shell = compileHtml(candidate.candidate.shell.html, { namespace: "shell", rootScopeKind: "store" });
  const home = compileHtml(candidate.candidate.home.html, { namespace: "home", rootScopeKind: "store" });
  const products = context.products.map(presentationProduct);
  const firstCollection = context.collections[0] ?? null;
  const data: PublicPresentationData = {
    store: { name: context.store.name, logo: context.store.logoAssetKey ? `/__owned_asset__/${encodeURIComponent(context.store.logoAssetKey)}` : null },
    policyLinks: [],
    product: products[0] ?? null,
    collection: firstCollection ? {
      id: firstCollection.id,
      handle: firstCollection.handle,
      title: firstCollection.title,
      description: "",
      image: products[0]?.primaryImage ?? null,
      productCount: firstCollection.productCount,
      products,
    } : null,
    featuredProducts: products,
    relatedProducts: products.slice(1),
    search: { query: "", results: products, facets: { categories: [], tags: [], collections: [] }, total: products.length, nextCursor: null },
    cart: null,
    notFound: null,
  };
  const artifact = (compiled: ReturnType<typeof compileHtml>, css: string) => ({
    html: compiled.html,
    tree: compiled.tree,
    bindings: compiled.bindings,
    css,
    requiredData: [],
    requiredCapabilities: [],
    interactions: compiled.interactions,
    trustedSlots: compiled.trustedSlots,
  });
  const shellMarkup = renderToStaticMarkup(renderStorefrontRoute({ routeId: "home", artifact: artifact(shell, candidate.candidate.shell.css), data, nonce: "judge" }).element);
  const homeMarkup = renderToStaticMarkup(renderStorefrontRoute({ routeId: "home", artifact: artifact(home, candidate.candidate.home.css), data, nonce: "judge" }).element);
  const document = `${shellMarkup}${homeMarkup}`;
  return {
    desktop: `<viewport width="1440" height="1000">${document}</viewport>`,
    mobile: `<viewport width="390" height="844">${document}</viewport>`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatal(error: unknown): boolean {
  return error instanceof Error && (error.name === "GenerationBudgetError" || error.name === "AbortError");
}

async function exploreOne(
  strategy: ConceptStrategy,
  index: number,
  input: ExploreConceptsInput,
): Promise<{ candidate?: ExploredConcept; rejected?: ExploreConceptsResult["rejected"][number]; repairs: number }> {
  const candidateId = `concept-${index + 1}`;
  const compile = input.compileConcept ?? compileConceptCandidate;
  let raw: unknown;
  let diagnostic = "";
  try {
    const response = await input.provider.complete({
      operation: "concept",
      system: COMPILER_SYSTEM_PROMPT,
      prompt: conceptPrompt(input.context, strategy, candidateId),
      schema: CONCEPT_SCHEMA,
      signal: input.signal,
    });
    input.onModelCall?.("concept", response);
    raw = response.value;
    const parsed = parseConceptCandidate(raw);
    if (parsed.candidateId !== candidateId) throw new Error(`Candidate ID must remain ${candidateId}`);
    const compiled = compile(parsed);
    return { candidate: { ...compiled, strategy }, repairs: 0 };
  } catch (error) {
    if (input.signal?.aborted || fatal(error)) throw error;
    diagnostic = errorMessage(error);
  }

  try {
    const response = await input.provider.complete({
      operation: "repairConcept",
      system: COMPILER_SYSTEM_PROMPT,
      prompt: conceptRepairPrompt(input.context, strategy, diagnostic, raw),
      schema: CONCEPT_SCHEMA,
      signal: input.signal,
    });
    input.onModelCall?.("repairConcept", response);
    const parsed = parseConceptCandidate(response.value);
    if (parsed.candidateId !== candidateId) throw new Error(`Candidate ID must remain ${candidateId}`);
    const compiled = compile(parsed);
    return { candidate: { ...compiled, strategy }, repairs: 1 };
  } catch (error) {
    if (input.signal?.aborted || fatal(error)) throw error;
    return {
      rejected: { strategy, candidateId, reason: errorMessage(error) },
      repairs: 1,
    };
  }
}

export async function exploreConcepts(input: ExploreConceptsInput): Promise<ExploreConceptsResult> {
  const results = await Promise.all(STRATEGIES.map((strategy, index) => exploreOne(strategy, index, input)));
  const candidates: ExploredConcept[] = [];
  const duplicateRejections: ExploreConceptsResult["rejected"] = [];
  const signatures = new Set<string>();
  for (const result of results) {
    if (!result.candidate) continue;
    const signature = JSON.stringify(result.candidate.candidate.concept.noveltySignature);
    if (signatures.has(signature)) {
      duplicateRejections.push({
        strategy: result.candidate.strategy,
        candidateId: result.candidate.candidate.candidateId,
        reason: "Concept duplicated another candidate's structural signature",
      });
    } else {
      signatures.add(signature);
      candidates.push(result.candidate);
    }
  }
  return {
    candidates,
    rejected: [...results.flatMap((result) => result.rejected ? [result.rejected] : []), ...duplicateRejections],
    repairs: results.reduce((sum, result) => sum + result.repairs, 0),
  };
}
