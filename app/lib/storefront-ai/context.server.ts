import { createHash } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import type { StoreTemplateId } from "../storefront-bundle/types";
import type { ContextAssemblyInput, MerchantStorefrontContext, NoveltySignature } from "./contracts";
import { structuralSignatureFromBundle } from "./structure";

const DEFAULT_LIMITS: ContextLimits = {
  maxPromptChars: 4_000,
  maxCollections: 40,
  maxProducts: 48,
  maxTagsPerProduct: 12,
  maxOptionsPerProduct: 8,
  maxImagesPerProduct: 6,
  maxReusableAssets: 24,
};

export interface ContextLimits {
  maxPromptChars: number;
  maxCollections: number;
  maxProducts: number;
  maxTagsPerProduct: number;
  maxOptionsPerProduct: number;
  maxImagesPerProduct: number;
  maxReusableAssets: number;
}

type PublicProduct = MerchantStorefrontContext["products"][number];
type PublicCollection = MerchantStorefrontContext["collections"][number];

export interface StorefrontContextSource {
  getStore(shopId: string): Promise<MerchantStorefrontContext["store"]>;
  listCollections(shopId: string, limit: number): Promise<PublicCollection[]>;
  listProducts(shopId: string, limit: number): Promise<PublicProduct[]>;
  listReusableAssets(shopId: string, limit: number): Promise<MerchantStorefrontContext["reusableAssets"]>;
}

export interface StorefrontContextReferences {
  products: Record<string, { id: string; handle: string }>;
  collections: Record<string, { id: string; handle: string }>;
  assets: Record<string, string>;
}

export interface StorefrontContextAssembly {
  context: MerchantStorefrontContext;
  references: StorefrontContextReferences;
}

function cleanText(value: unknown, max = 240): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stableUnique(values: readonly string[], max: number): string[] {
  return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

function opaqueRef(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function safeOwnedKey(value: unknown): string | null {
  const key = cleanText(value, 500);
  if (!key || /^(?:https?:)?\/\//i.test(key) || key.includes("..")) return null;
  return key;
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function recipeSignatures(): Array<{ templateId: StoreTemplateId; signature: NoveltySignature }> {
  return STOREFRONT_RECIPES.map((recipe) => ({
    templateId: recipe.config.templateId,
    signature: structuralSignatureFromBundle(recipe.bundle),
  }));
}

function selectProductsWithCollectionCoverage(
  products: PublicProduct[],
  collections: PublicCollection[],
  limit: number,
): PublicProduct[] {
  const sorted = products.slice().sort((a, b) => a.id.localeCompare(b.id));
  const chosen = new Map<string, PublicProduct>();
  for (const collection of collections) {
    const representative = sorted.find((product) => product.collectionIds?.includes(collection.id));
    if (representative) chosen.set(representative.id, representative);
    if (chosen.size === limit) return [...chosen.values()];
  }
  for (const product of sorted) {
    chosen.set(product.id, product);
    if (chosen.size === limit) break;
  }
  return [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

const databaseContextSource: StorefrontContextSource = {
  async getStore(shopId) {
    const sb = getSupabase();
    const [{ data: settings, error: settingsError }, { data: shop, error: shopError }] = await Promise.all([
      sb.from("store_settings").select("store_name, logo_url").eq("shop_id", shopId).maybeSingle(),
      sb.from("shops").select("display_name").eq("id", shopId).maybeSingle(),
    ]);
    if (settingsError) throw settingsError;
    if (shopError) throw shopError;
    const logoAssetKey = safeOwnedKey(settings?.logo_url);
    return {
      name: cleanText(settings?.store_name ?? shop?.display_name ?? "Store", 120) || "Store",
      logoAssetKey,
      publicBrandAssetKeys: logoAssetKey ? [logoAssetKey] : [],
    };
  },

  async listCollections(shopId, limit) {
    const sb = getSupabase();
    const { data, error } = await sb.from("collection_dim")
      .select("id, handle, title")
      .eq("shop_id", shopId)
      .order("id")
      .limit(limit);
    if (error) throw error;
    const ids = (data ?? []).map((row) => String(row.id));
    let counts = new Map<string, number>();
    if (ids.length) {
      const links = await sb.from("product_collection").select("collection_id").in("collection_id", ids);
      if (links.error) throw links.error;
      counts = new Map();
      for (const row of links.data ?? []) {
        const id = String(row.collection_id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return (data ?? []).map((row) => ({
      id: String(row.id),
      handle: cleanText(row.handle, 160),
      title: cleanText(row.title, 240),
      productCount: counts.get(String(row.id)) ?? 0,
    }));
  },

  async listProducts(shopId, limit) {
    const sb = getSupabase();
    const { data, error } = await sb.from("product_dim")
      .select("id, handle, title, category, tags")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .order("id")
      .limit(limit);
    if (error) throw error;
    const ids = (data ?? []).map((row) => String(row.id));
    if (!ids.length) return [];
    const [variants, options, media, links] = await Promise.all([
      sb.from("variant_dim").select("product_id, retail_price_cents, currency, inventory_tracked, inventory_on_hand").eq("shop_id", shopId).in("product_id", ids),
      sb.from("product_option").select("product_id, name").in("product_id", ids),
      sb.from("product_media").select("product_id, storage_path").in("product_id", ids).not("storage_path", "is", null),
      sb.from("product_collection").select("product_id, collection_id").in("product_id", ids),
    ]);
    for (const result of [variants, options, media, links]) if (result.error) throw result.error;
    return (data ?? []).map((row) => {
      const id = String(row.id);
      const productVariants = (variants.data ?? []).filter((variant) => String(variant.product_id) === id);
      const prices = productVariants.map((variant) => finiteNonNegative(variant.retail_price_cents)).filter((price) => price > 0);
      const availability = productVariants.map((variant) => !variant.inventory_tracked || finiteNonNegative(variant.inventory_on_hand) > 0);
      const availableCount = availability.filter(Boolean).length;
      return {
        id,
        handle: cleanText(row.handle, 160),
        title: cleanText(row.title, 240),
        productType: row.category == null ? null : cleanText(row.category, 120),
        tags: Array.isArray(row.tags) ? row.tags.map((tag) => cleanText(tag, 120)).filter(Boolean) : [],
        optionNames: (options.data ?? []).filter((option) => String(option.product_id) === id).map((option) => cleanText(option.name, 120)),
        priceMin: prices.length ? Math.min(...prices) : 0,
        priceMax: prices.length ? Math.max(...prices) : 0,
        currency: cleanText(productVariants.find((variant) => variant.currency)?.currency ?? "USD", 8).toUpperCase(),
        availability: availableCount === 0 ? "sold_out" as const : availableCount === availability.length ? "available" as const : "mixed" as const,
        collectionIds: (links.data ?? []).filter((link) => String(link.product_id) === id).map((link) => String(link.collection_id)),
        images: (media.data ?? []).filter((item) => String(item.product_id) === id)
          .flatMap((item) => safeOwnedKey(item.storage_path) ? [{ assetKey: String(item.storage_path), aspectRatio: null }] : []),
      };
    });
  },

  async listReusableAssets() {
    return [];
  },
};

export async function assembleStorefrontContextWithReferences(
  input: ContextAssemblyInput,
  source: StorefrontContextSource = databaseContextSource,
  overrides: Partial<ContextLimits> = {},
): Promise<StorefrontContextAssembly> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const prompt = cleanText(input.prompt, limits.maxPromptChars);
  if (!prompt) throw new Error("A custom storefront prompt is required");
  const [rawStore, rawCollections, rawProducts, rawAssets] = await Promise.all([
    source.getStore(input.shopId),
    source.listCollections(input.shopId, limits.maxCollections),
    source.listProducts(input.shopId, Math.max(limits.maxProducts * 4, limits.maxProducts)),
    source.listReusableAssets(input.shopId, limits.maxReusableAssets),
  ]);
  const references: StorefrontContextReferences = { products: {}, collections: {}, assets: {} };
  const selectedCollections = rawCollections.slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limits.maxCollections);
  const collectionRefs = new Map(selectedCollections.map((item, index) => [item.id, opaqueRef("collection", index)]));
  const collections = selectedCollections.map((item, index) => ({
    id: opaqueRef("collection", index),
    handle: cleanText(item.handle, 160),
    title: cleanText(item.title, 240),
    productCount: finiteNonNegative(item.productCount),
  }));
  for (const [index, item] of selectedCollections.entries()) {
    references.collections[opaqueRef("collection", index)] = { id: item.id, handle: item.handle };
  }
  let imageIndex = 0;
  const products = selectProductsWithCollectionCoverage(rawProducts, selectedCollections, limits.maxProducts).map((item, index) => {
    const productRef = opaqueRef("product", index);
    references.products[productRef] = { id: item.id, handle: item.handle };
    return {
      id: productRef,
      handle: cleanText(item.handle, 160),
      title: cleanText(item.title, 240),
      productType: item.productType == null ? null : cleanText(item.productType, 120),
      tags: stableUnique(item.tags, limits.maxTagsPerProduct),
      optionNames: stableUnique(item.optionNames, limits.maxOptionsPerProduct),
      priceMin: finiteNonNegative(item.priceMin),
      priceMax: Math.max(finiteNonNegative(item.priceMin), finiteNonNegative(item.priceMax)),
      currency: cleanText(item.currency, 8).toUpperCase() || "USD",
      availability: item.availability,
      collectionIds: stableUnique(item.collectionIds ?? [], limits.maxCollections)
        .flatMap((id) => collectionRefs.get(id) ?? []),
      images: item.images.slice(0, limits.maxImagesPerProduct).flatMap((image) => {
        const assetKey = safeOwnedKey(image.assetKey);
        if (!assetKey) return [];
        const ref = opaqueRef("catalog-image", imageIndex);
        imageIndex += 1;
        references.assets[ref] = assetKey;
        return [{
          assetKey: ref,
          aspectRatio: image.aspectRatio != null && Number.isFinite(image.aspectRatio) ? image.aspectRatio : null,
        }];
      }),
    };
  });
  const storeLogo = safeOwnedKey(rawStore.logoAssetKey);
  const brandKeys = stableUnique([
    ...(storeLogo ? [storeLogo] : []),
    ...rawStore.publicBrandAssetKeys.flatMap((key) => safeOwnedKey(key) ?? []),
  ], 16);
  const brandRefs = new Map(brandKeys.map((key, index) => [key, opaqueRef("brand-asset", index)]));
  for (const [key, ref] of brandRefs) references.assets[ref] = key;
  const contextWithoutFingerprint: Omit<MerchantStorefrontContext, "fingerprint"> = {
    version: 1,
    prompt,
    promptHash: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
    referenceImages: (input.referenceImages ?? []).slice(0, 4).flatMap((image, index) => {
      const assetKey = safeOwnedKey(image.assetKey);
      if (!assetKey) return [];
      const ref = opaqueRef("reference-image", index);
      references.assets[ref] = assetKey;
      return [{ assetKey: ref, mediaType: image.mediaType }];
    }),
    store: {
      name: cleanText(rawStore.name, 120) || "Store",
      logoAssetKey: storeLogo ? brandRefs.get(storeLogo) ?? null : null,
      publicBrandAssetKeys: brandKeys.map((key) => brandRefs.get(key)!),
    },
    collections,
    products,
    reusableAssets: rawAssets.slice(0, limits.maxReusableAssets).flatMap((asset, index) => {
      const assetKey = safeOwnedKey(asset.assetKey);
      if (!assetKey) return [];
      const ref = opaqueRef("reusable-asset", index);
      references.assets[ref] = assetKey;
      return [{
        assetKey: ref,
        mediaType: cleanText(asset.mediaType, 80),
        width: asset.width == null ? null : finiteNonNegative(asset.width),
        height: asset.height == null ? null : finiteNonNegative(asset.height),
      }];
    }),
    recipeNoveltySignatures: recipeSignatures(),
  };
  const context = {
    ...contextWithoutFingerprint,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(stableValue(contextWithoutFingerprint))).digest("hex")}`,
  };
  return { context, references };
}

export async function assembleStorefrontContext(
  input: ContextAssemblyInput,
  source: StorefrontContextSource = databaseContextSource,
  overrides: Partial<ContextLimits> = {},
): Promise<MerchantStorefrontContext> {
  return (await assembleStorefrontContextWithReferences(input, source, overrides)).context;
}
