import { createHash } from "node:crypto";
import {
  STOREFRONT_RUNTIME_VERSION,
  STOREFRONT_SCHEMA_VERSION,
  STOREFRONT_VALIDATION_PROFILE_VERSION,
  isCuratedFontId,
  type AssetManifest,
  type CheckoutLayoutManifest,
  type CuratedFontId,
  type DataRequirement,
  type RuntimeCapability,
  type StorefrontBundleV1,
  type StoreTemplateId,
} from "../storefront-bundle/types";
import { CompilerError, type BindingScopeKind } from "./bindings";
import { compileCheckout } from "./checkout";
import { compileCss } from "./css";
import { compileHtml } from "./html";
import { validateCompiledBundle, type BundleValidationReport } from "./validate";

export interface RouteSource {
  html: string;
  css: string;
  requiredData: DataRequirement[];
  requiredCapabilities: RuntimeCapability[];
  rootScopeKind?: BindingScopeKind;
}

export interface CheckoutRouteSource {
  html: string;
  css: string;
  layout: CheckoutLayoutManifest;
}

export interface StorefrontBundleSourceV1 {
  source: StorefrontBundleV1["source"];
  concept: StorefrontBundleV1["concept"];
  designSystem: {
    displayFontId: CuratedFontId;
    bodyFontId: CuratedFontId;
    tokens: Record<string, string>;
    breakpoints: Record<string, number>;
    iconStyle: string;
    motionStyle: string;
    globalCss: string;
  };
  shell: RouteSource;
  routes: {
    home: RouteSource;
    collection: RouteSource;
    product: RouteSource;
    search: RouteSource;
    cart: RouteSource;
    checkout: CheckoutRouteSource;
  };
  assets: AssetManifest;
}

function isIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "-" || character === "_")) return false;
  }
  return true;
}

function compileRoute(source: RouteSource, namespace: string, defaultScope: BindingScopeKind) {
  const html = compileHtml(source.html, {
    namespace,
    rootScopeKind: source.rootScopeKind ?? defaultScope,
  });
  const css = compileCss(source.css, { namespace });
  return {
    html: html.html,
    tree: html.tree,
    bindings: html.bindings,
    css: css.css,
    requiredData: source.requiredData.map((requirement) => ({ ...requirement })),
    requiredCapabilities: [...new Set(source.requiredCapabilities)].sort() as RuntimeCapability[],
    interactions: html.interactions,
    trustedSlots: html.trustedSlots,
  };
}

function compileAssets(assets: AssetManifest): AssetManifest {
  const keys = new Set<string>();
  const entries = assets.entries.map((entry) => {
    if (!isIdentifier(entry.key)) throw new CompilerError("asset.key", `Invalid asset key ${JSON.stringify(entry.key)}`);
    if (keys.has(entry.key)) throw new CompilerError("asset.duplicate", `Duplicate asset key ${entry.key}`);
    keys.add(entry.key);
    if (!isIdentifier(entry.contentHash) || entry.contentHash.length < 16) {
      throw new CompilerError("asset.hash", `Invalid content hash for ${entry.key}`);
    }
    if (!new Set(["image/avif", "image/webp", "image/png", "image/jpeg", "image/svg+xml", "font/woff2"]).has(entry.mediaType)) {
      throw new CompilerError("asset.media_type", `Unsupported media type ${entry.mediaType}`);
    }
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) {
      throw new CompilerError("asset.byte_size", `Invalid byte size for ${entry.key}`);
    }
    return { ...entry };
  });
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { entries };
}

function compileDesignSystem(source: StorefrontBundleSourceV1["designSystem"]): StorefrontBundleV1["designSystem"] {
  if (!isCuratedFontId(source.displayFontId) || !isCuratedFontId(source.bodyFontId)) {
    throw new CompilerError("design.font", "Design system fonts must come from the curated self-hosted set");
  }
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.tokens).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isIdentifier(key)) throw new CompilerError("design.token", `Invalid token ID ${JSON.stringify(key)}`);
    compileCss(`.token { --${key}: ${value}; }`, { namespace: "token-check" });
    tokens[key] = value;
  }
  const breakpoints: Record<string, number> = {};
  for (const [key, value] of Object.entries(source.breakpoints).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isIdentifier(key) || !Number.isFinite(value) || value < 240 || value > 3840) {
      throw new CompilerError("design.breakpoint", `Invalid breakpoint ${JSON.stringify(key)}`);
    }
    breakpoints[key] = value;
  }
  if (source.iconStyle.length > 120 || source.motionStyle.length > 120) {
    throw new CompilerError("design.description", "Design system descriptions exceed their bounded length");
  }
  return {
    displayFontId: source.displayFontId,
    bodyFontId: source.bodyFontId,
    tokens,
    breakpoints,
    iconStyle: source.iconStyle,
    motionStyle: source.motionStyle,
    globalCss: compileCss(source.globalCss, { namespace: "global" }).css,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalizeCompiledBundle(bundle: StorefrontBundleV1): string {
  return JSON.stringify(stableValue(bundle));
}

export function hashCompiledBundle(bundle: StorefrontBundleV1): string {
  return createHash("sha256").update(canonicalizeCompiledBundle(bundle)).digest("hex");
}

export interface CompiledBundleResult {
  bundle: StorefrontBundleV1;
  hash: string;
  report: BundleValidationReport;
}

export function compileBundle(source: StorefrontBundleSourceV1): CompiledBundleResult {
  const bundle: StorefrontBundleV1 = {
    schemaVersion: STOREFRONT_SCHEMA_VERSION,
    runtimeVersion: STOREFRONT_RUNTIME_VERSION,
    validationProfileVersion: STOREFRONT_VALIDATION_PROFILE_VERSION,
    source: { ...source.source } as StorefrontBundleV1["source"],
    concept: {
      name: source.concept.name,
      rationale: source.concept.rationale,
      noveltySignature: [...source.concept.noveltySignature],
    },
    designSystem: compileDesignSystem(source.designSystem),
    shell: compileRoute(source.shell, "shell", "store"),
    routes: {
      home: compileRoute(source.routes.home, "home", "store"),
      collection: compileRoute(source.routes.collection, "collection", "collection"),
      product: compileRoute(source.routes.product, "product", "product"),
      search: compileRoute(source.routes.search, "search", "search"),
      cart: compileRoute(source.routes.cart, "cart", "cart"),
      checkout: compileCheckout(source.routes.checkout),
    },
    assets: compileAssets(source.assets),
  };
  const report = validateCompiledBundle(bundle);
  return { bundle, hash: hashCompiledBundle(bundle), report };
}

// Type-only sentinel: recipe source callers retain the versioned registry ID contract.
export type RecipeCompilerSource = Extract<StorefrontBundleSourceV1["source"], { kind: "recipe" }> & {
  templateId: StoreTemplateId;
};
