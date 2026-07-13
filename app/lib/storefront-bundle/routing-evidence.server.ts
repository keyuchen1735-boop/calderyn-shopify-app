import { createHash } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import { normalizeRoutingText } from "./routing";
import type { CatalogRoutingEvidence, VersionedStoreTemplateRegistry } from "./types";

const LIMITS = {
  productTitles: 200,
  productTypes: 100,
  productTags: 200,
  optionNames: 100,
  collectionTitles: 100,
} as const;

interface ActiveProductRoutingRow {
  id: string;
  title: string;
  productType: string | null;
  tags: string[];
}

interface CollectionRoutingRow {
  id: string;
  title: string;
}

export interface CatalogRoutingSource {
  listActiveProducts(shopId: string, limit: number): Promise<ActiveProductRoutingRow[]>;
  listOptionNames(shopId: string, productIds: string[], limit: number): Promise<string[]>;
  listCollections(shopId: string, limit: number): Promise<CollectionRoutingRow[]>;
}

const databaseCatalogRoutingSource: CatalogRoutingSource = {
  async listActiveProducts(shopId, limit) {
    const { data, error } = await getSupabase()
      .from("product_dim")
      .select("id, title, category, tags")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .order("id", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      productType: row.category == null ? null : String(row.category),
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    }));
  },

  async listOptionNames(_shopId, productIds, limit) {
    if (!productIds.length) return [];
    const { data, error } = await getSupabase()
      .from("product_option")
      .select("product_id, name, position, id")
      .in("product_id", productIds)
      .order("product_id", { ascending: true })
      .order("position", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => String(row.name ?? ""));
  },

  async listCollections(shopId, limit) {
    const { data, error } = await getSupabase()
      .from("collection_dim")
      .select("id, title")
      .eq("shop_id", shopId)
      .order("id", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
    }));
  },
};

function normalizedUnique(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeRoutingText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === limit) break;
  }
  return result;
}

export async function buildCatalogRoutingEvidence(
  shopId: string,
  registry: VersionedStoreTemplateRegistry = STORE_TEMPLATE_REGISTRY,
  source: CatalogRoutingSource = databaseCatalogRoutingSource,
): Promise<CatalogRoutingEvidence> {
  const products = (await source.listActiveProducts(shopId, LIMITS.productTitles))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const productIds = products.map((product) => product.id);
  const [optionNames, collections] = await Promise.all([
    source.listOptionNames(shopId, productIds, LIMITS.optionNames),
    source.listCollections(shopId, LIMITS.collectionTitles),
  ]);
  const sortedCollections = collections.slice().sort((a, b) => a.id.localeCompare(b.id));
  const fields = {
    productTitles: normalizedUnique(products.map((product) => product.title), LIMITS.productTitles),
    productTypes: normalizedUnique(products.flatMap((product) => product.productType ?? []), LIMITS.productTypes),
    productTags: normalizedUnique(products.flatMap((product) => product.tags), LIMITS.productTags),
    optionNames: normalizedUnique(optionNames, LIMITS.optionNames),
    collectionTitles: normalizedUnique(sortedCollections.map((collection) => collection.title), LIMITS.collectionTitles),
  };
  const fingerprintPayload = JSON.stringify({
    routingVersion: registry.routingVersion,
    registryVersion: registry.registryVersion,
    fields,
  });
  return {
    ...fields,
    fingerprint: `sha256:${createHash("sha256").update(fingerprintPayload).digest("hex")}`,
  };
}
