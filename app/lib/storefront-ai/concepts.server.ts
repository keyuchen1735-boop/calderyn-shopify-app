import { createHash } from "node:crypto";
import { cloneElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { launchChromium } from "../browser/chromium.server";
import { isCuratedFontId, type CompiledNode } from "../storefront-bundle/types";
import { isCompilerIdentifier } from "../storefront-compiler/assets";
import { assertSafeDesignTokenValue, compileCss } from "../storefront-compiler/css";
import { compileHtml } from "../storefront-compiler/html";
import type { RouteSource } from "../storefront-compiler/compile";
import { storefrontDesignSystemCss } from "../storefront-runtime/curated-fonts";
import { renderStorefrontRoute, splitShellTree } from "../storefront-runtime/render";
import type { PublicPresentationData, PublicProduct } from "../storefront-runtime/public-data.server";
import type {
  CompiledConcept,
  ConceptRenderEvidence,
  ConceptCandidateSource,
  ConceptStrategy,
  ExploredConcept,
  MerchantStorefrontContext,
  StorefrontAiProvider,
  StructuredModelResponse,
} from "./contracts";
import { CONCEPT_SCHEMA, COMPILER_SYSTEM_PROMPT, conceptPrompt, conceptRepairPrompt } from "./prompts";
import { structuralSignatureFromConcept } from "./structure";

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

const STRATEGIES: readonly ConceptStrategy[] = ["asymmetric-commerce"];

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
    const normalized = typeof child === "string" && /^\d+(?:\.\d+)?(?:px)?$/i.test(child.trim())
      ? Number.parseFloat(child)
      : child;
    if (typeof normalized !== "number" || !Number.isFinite(normalized)) throw new Error(`${field}.${key} must be a number`);
    return [key, normalized];
  }));
}

function normalizeHtml(value: string, field: string): string {
  const html = value.replace(/<!--[\s\S]*?-->/g, "");
  if (!html.trim()) throw new Error(`${field} must contain non-empty HTML`);
  return html;
}

function routeSource(value: unknown, field: string): RouteSource {
  const source = record(value, field);
  if (!Array.isArray(source.requiredData) || !Array.isArray(source.requiredCapabilities)) {
    throw new Error(`${field} must declare bounded data and capability arrays`);
  }
  return {
    html: normalizeHtml(string(source.html, `${field}.html`, 250_000), `${field}.html`),
    css: typeof source.css === "string" && source.css.length <= 250_000 ? source.css : (() => { throw new Error(`${field}.css must be bounded`); })(),
    requiredData: source.requiredData as RouteSource["requiredData"],
    requiredCapabilities: source.requiredCapabilities as RouteSource["requiredCapabilities"],
  };
}

export function parseConceptCandidate(value: unknown): ConceptCandidateSource {
  const source = record(value, "concept");
  const concept = record(source.concept, "concept.concept");
  const novelty = record(concept.noveltySignature, "concept.noveltySignature");
  const design = record(source.designSystem, "concept.designSystem");
  if (design.globalCss !== "") throw new Error("Concept globalCss must be empty");
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

const ROUTE_HOST_CLASS = /(?:^|[\s_-])(?:content|outlet|route-host|page-slot|main-content|content-host)(?:$|[\s_-])/i;

function assertShellIsNavigationChrome(nodes: readonly CompiledNode[], insideChrome = false, depth = 0): void {
  if (depth === 0 && nodes.filter((node) => node.kind === "element" && node.tag === "footer").length !== 1) {
    throw new Error("Concept shell must contain only navigation chrome and one top-level footer; route content belongs in route HTML");
  }
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === "main" || (node.tag === "footer" && depth > 0)) {
      throw new Error("Concept shell must contain only navigation chrome and one top-level footer; route content belongs in route HTML");
    }
    if (node.tag === "footer") continue;
    const chrome = insideChrome || node.tag === "header" || node.tag === "nav";
    const className = node.attributes.class ?? "";
    if (!chrome && ["div", "section", "article", "aside"].includes(node.tag) &&
      (node.children.length === 0 || ROUTE_HOST_CLASS.test(className))) {
      throw new Error("Concept shell must contain only navigation chrome and one top-level footer; route content hosts belong in route HTML");
    }
    assertShellIsNavigationChrome(node.children, chrome, depth + 1);
  }
}

export function compileConceptCandidate(candidate: ConceptCandidateSource): CompiledConcept {
  for (const [key, value] of Object.entries(candidate.designSystem.tokens)) {
    if (!isCompilerIdentifier(key)) throw new Error(`Invalid design token ${key}`);
    if (key === "font-body" || key === "font-display") throw new Error(`Reserved design token ${key}`);
    assertSafeDesignTokenValue(key, value);
  }
  storefrontDesignSystemCss(candidate.designSystem);
  for (const [key, value] of Object.entries(candidate.designSystem.breakpoints)) {
    if (!isCompilerIdentifier(key) || !Number.isFinite(value) || value < 240 || value > 3_840) throw new Error(`Invalid breakpoint ${key}`);
  }
  const shellHtml = compileHtml(candidate.shell.html, { namespace: "shell", rootScopeKind: "store" });
  const homeHtml = compileHtml(candidate.home.html, { namespace: "home", rootScopeKind: "store" });
  assertShellIsNavigationChrome(shellHtml.tree);
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
  return {
    candidate,
    compiledFingerprint,
    structuralSignature: structuralSignatureFromConcept({
      displayFontId: candidate.designSystem.displayFontId,
      bodyFontId: candidate.designSystem.bodyFontId,
      tokens: candidate.designSystem.tokens,
      globalCss: globalCss.css,
      shell: {
        tree: shellHtml.tree,
        css: shellCss.css,
        interactions: shellHtml.interactions,
        trustedSlots: shellHtml.trustedSlots,
      },
      home: {
        tree: homeHtml.tree,
        css: homeCss.css,
        interactions: homeHtml.interactions,
        trustedSlots: homeHtml.trustedSlots,
      },
    }),
  };
}

/** Produces the same closed design-system CSS used by the public runtime plus
 * compiler-scoped global CSS for the two concept surfaces shown to the judge. */
export function compileConceptJudgeDesignCss(candidate: ConceptCandidateSource): string {
  const shell = compileHtml(candidate.shell.html, { namespace: "shell", rootScopeKind: "store" });
  const home = compileHtml(candidate.home.html, { namespace: "home", rootScopeKind: "store" });
  const globalCss = compileCss(candidate.designSystem.globalCss, {
    namespace: "global",
    protectedNodes: [...shell.protectedCssNodes, ...home.protectedCssNodes],
    protectedSourceIds: [...shell.protectedSourceIds, ...home.protectedSourceIds],
  }).css;
  return `${storefrontDesignSystemCss(candidate.designSystem)}${globalCss}`;
}

function presentationProduct(product: MerchantStorefrontContext["products"][number]): PublicProduct {
  const price = product.priceMin > 0 ? { cents: product.priceMin, currency: product.currency } : null;
  const available = product.availability !== "sold_out";
  const imageSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#d8d3c7"/><circle cx="820" cy="330" r="220" fill="#786f63"/><path d="M100 780L430 220l320 560z" fill="#31353a"/></svg>`);
  const images = product.images.map(() => ({ url: `data:image/svg+xml,${imageSvg}`, alt: product.title }));
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

function judgeAssetPlaceholder(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d8d3c7"/><stop offset="1" stop-color="#786f63"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="1160" cy="300" r="240" fill="#31353a" fill-opacity=".72"/><path d="M80 920 500 180l420 740Z" fill="#f2eee6" fill-opacity=".72"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Compiler-tree render used by the visual judge. Merchant strings remain data
 * bindings and pass through React escaping; no source string interpolation. */
export async function renderConceptWithMerchantData(input: {
  candidate: ExploredConcept;
  context: MerchantStorefrontContext;
  signal?: AbortSignal;
}): Promise<ConceptRenderEvidence> {
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
  const artifact = (compiled: ReturnType<typeof compileHtml>, css: string, tree: CompiledNode[] = compiled.tree) => ({
    html: compiled.html,
    tree,
    bindings: compiled.bindings,
    css,
    requiredData: [],
    requiredCapabilities: [],
    interactions: compiled.interactions,
    trustedSlots: compiled.trustedSlots,
  });
  const assetUrls = new Map(candidate.candidate.assetRequests.map((request) => [request.key, judgeAssetPlaceholder()]));
  const shellTree = splitShellTree(shell.tree);
  const shellElement = renderStorefrontRoute({ routeId: "home", artifact: artifact(shell, compileCss(candidate.candidate.shell.css, { namespace: "shell", protectedNodes: shell.protectedCssNodes, protectedSourceIds: shell.protectedSourceIds }).css, shellTree.beforeRoute), data, nonce: "judge", assetUrls }).element;
  const homeElement = renderStorefrontRoute({ routeId: "home", artifact: artifact(home, compileCss(candidate.candidate.home.css, { namespace: "home", protectedNodes: home.protectedCssNodes, protectedSourceIds: home.protectedSourceIds }).css), data, nonce: "judge", assetUrls }).element;
  const footerElement = shellTree.afterRoute.length > 0
    ? renderStorefrontRoute({ routeId: "home", artifact: artifact(shell, "", shellTree.afterRoute), data, nonce: "judge", assetUrls }).element
    : null;
  const children = (element: typeof shellElement): ReactNode => (element.props as { children?: ReactNode }).children;
  const shellMarkup = renderToStaticMarkup(cloneElement(shellElement, {
    "data-cd-bundle": "shell", "data-cd-bundle-route": undefined, "data-cd-bundle-shell": "home",
  }, children(shellElement), homeElement, footerElement ? children(footerElement) : null));
  const designCss = compileConceptJudgeDesignCss(candidate.candidate);
  const htmlDocument = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="judge">html,body{margin:0;min-height:100%;overflow-x:hidden}${designCss}</style></head><body><div data-cd-bundle="global" data-cd-bundle-runtime="1" data-cd-bundle-source="custom">${shellMarkup}</div></body></html>`;
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Generation cancelled", "AbortError");
  const browserStartedAt = Date.now();
  const browser = await launchChromium({ width: 1440, height: 1000 });
  if (input.signal?.aborted) {
    await browser.close().catch(() => undefined);
    throw input.signal.reason ?? new DOMException("Generation cancelled", "AbortError");
  }
  const abort = () => { void browser.close().catch(() => undefined); };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlDocument, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const screenshots = async (width: number, height: number) => {
      const measured = await page.evaluate(() => {
        const firstProduct = document.querySelector('[data-cd-repeat-owner="true"]');
        return {
          contentHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          catalogTop: firstProduct ? firstProduct.getBoundingClientRect().top + window.scrollY : 0,
        };
      });
      const contentHeight = Math.max(1, Math.ceil(measured.contentHeight));
      const clipHeight = Math.min(height, contentHeight);
      const catalogY = Math.min(
        Math.max(0, Math.floor(measured.catalogTop) - Math.round(height / 4)),
        Math.max(0, contentHeight - clipHeight),
      );
      const capture = async (y: number) => new Uint8Array(await page.screenshot({
        type: "webp",
        clip: { x: 0, y, width, height: clipHeight },
        captureBeyondViewport: true,
      }));
      return { overview: await capture(0), catalog: await capture(catalogY) };
    };
    await page.setViewport({ width: 1440, height: 1000 });
    const desktop = await screenshots(1440, 800);
    await page.setViewport({ width: 390, height: 844 });
    const mobile = await screenshots(390, 844);
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Generation cancelled", "AbortError");
    return {
      desktop: { key: "judge-desktop-overview", mediaType: "image/webp", bytes: desktop.overview },
      desktopCatalog: { key: "judge-desktop-catalog", mediaType: "image/webp", bytes: desktop.catalog },
      mobile: { key: "judge-mobile-overview", mediaType: "image/webp", bytes: mobile.overview },
      mobileCatalog: { key: "judge-mobile-catalog", mediaType: "image/webp", bytes: mobile.catalog },
      browserMs: Math.max(0, Date.now() - browserStartedAt),
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
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
      prompt: conceptRepairPrompt(input.context, strategy, candidateId, diagnostic, raw),
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
    const signature = JSON.stringify(result.candidate.structuralSignature);
    if (signatures.has(signature)) {
      duplicateRejections.push({
        strategy: result.candidate.strategy,
        candidateId: result.candidate.candidate.candidateId,
        reason: "Concept duplicated another candidate's compiled structure",
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
