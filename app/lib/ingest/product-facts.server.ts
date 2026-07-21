import { getSupabase } from "../supabase.server";
import { normalizeProductFacts, type ProductFactInput, type ProductFactKind } from "../storefront/product-facts";
import { fetchProductFactPages } from "./shopify-admin.server";

type ShopifyMetafield = { id: string; type: string; jsonValue: unknown };
export type ShopifyFactProduct = {
  id: string;
  title: string;
  calderynWidth?: ShopifyMetafield | null;
  calderynDepth?: ShopifyMetafield | null;
  calderynHeight?: ShopifyMetafield | null;
  calderynMaterials?: ShopifyMetafield | null;
  calderynCompatibility?: ShopifyMetafield | null;
  calderynIngredients?: ShopifyMetafield | null;
  calderynConcerns?: ShopifyMetafield | null;
  calderynHeatLevel?: ShopifyMetafield | null;
  calderynDocumentUrl?: ShopifyMetafield | null;
  calderynArModelUrl?: ShopifyMetafield | null;
};

export type ProductFactSnapshotItem = ProductFactInput & {
  productExternalId: string;
  externalId: string;
};

const DIMENSION_UNITS: Record<string, string> = {
  MILLIMETERS: "mm", CENTIMETERS: "cm", METERS: "m", INCHES: "in",
};

function scalar(product: ShopifyFactProduct, field: ShopifyMetafield | null | undefined, type: string, kind: ProductFactKind): ProductFactSnapshotItem[] {
  if (!field) return [];
  if (field.type !== type) throw new Error(`${kind} metafield must use Shopify type ${type}`);
  return [{ productExternalId: product.id, externalId: field.id, kind, value: field.jsonValue }];
}

function list(product: ShopifyFactProduct, field: ShopifyMetafield | null | undefined, kind: ProductFactKind): ProductFactSnapshotItem[] {
  if (!field) return [];
  if (field.type !== "list.single_line_text_field" || !Array.isArray(field.jsonValue)) {
    throw new Error(`${kind} metafield must use Shopify type list.single_line_text_field`);
  }
  return field.jsonValue.map((value) => ({
    productExternalId: product.id,
    externalId: `${field.id}#${encodeURIComponent(typeof value === "string" ? value.normalize("NFKC").trim() : String(value))}`,
    kind,
    value,
  }));
}

function dimension(product: ShopifyFactProduct, field: ShopifyMetafield | null | undefined, kind: ProductFactKind): ProductFactSnapshotItem[] {
  if (!field) return [];
  if (field.type !== "dimension" || !field.jsonValue || typeof field.jsonValue !== "object") {
    throw new Error(`${kind} metafield must use Shopify type dimension`);
  }
  const value = field.jsonValue as { value?: unknown; unit?: unknown };
  const unit = typeof value.unit === "string" ? DIMENSION_UNITS[value.unit] : undefined;
  if (!unit) throw new Error(`${kind} dimension unit is invalid`);
  return [{ productExternalId: product.id, externalId: field.id, kind, value: value.value, unit }];
}

export function mapShopifyProductFacts(product: ShopifyFactProduct): ProductFactSnapshotItem[] {
  const facts = [
    ...dimension(product, product.calderynWidth, "dimension.width"),
    ...dimension(product, product.calderynDepth, "dimension.depth"),
    ...dimension(product, product.calderynHeight, "dimension.height"),
    ...list(product, product.calderynMaterials, "material"),
    ...list(product, product.calderynCompatibility, "compatibility"),
    ...list(product, product.calderynIngredients, "ingredient"),
    ...list(product, product.calderynConcerns, "concern"),
    ...scalar(product, product.calderynHeatLevel, "number_integer", "heat_level"),
    ...scalar(product, product.calderynDocumentUrl, "url", "document_url"),
    ...scalar(product, product.calderynArModelUrl, "url", "ar_model_url"),
  ];
  normalizeProductFacts(facts);
  return facts;
}

type Snapshot = { shopId: string; provider: string; facts: ProductFactSnapshotItem[] };
type Dependencies = {
  fetch: (shopDomain: string) => AsyncGenerator<ShopifyFactProduct[]>;
  replace: (snapshot: Snapshot) => Promise<void>;
};

export async function replaceProductFactSnapshot(snapshot: Snapshot): Promise<void> {
  if (!snapshot.shopId) throw new Error("product fact snapshot requires a shop ID");
  const byProduct = new Map<string, ProductFactSnapshotItem[]>();
  const externalIds = new Set<string>();
  for (const fact of snapshot.facts) {
    if (!fact.productExternalId || !fact.externalId) throw new Error("product fact snapshot requires stable external IDs");
    if (externalIds.has(fact.externalId)) throw new Error(`duplicate product fact external ID ${fact.externalId}`);
    externalIds.add(fact.externalId);
    const productFacts = byProduct.get(fact.productExternalId) ?? [];
    productFacts.push(fact);
    byProduct.set(fact.productExternalId, productFacts);
  }
  for (const [productExternalId, productFacts] of byProduct) {
    try { normalizeProductFacts(productFacts); }
    catch (error) { throw new Error(`${productExternalId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const positions = new Map<string, number>();
  const rows = snapshot.facts.map((fact) => {
    const normalized = normalizeProductFacts([fact])[0];
    const position = positions.get(fact.productExternalId) ?? 0;
    positions.set(fact.productExternalId, position + 1);
    return {
      product_external_id: fact.productExternalId,
      external_id: fact.externalId,
      kind: fact.kind,
      text_value: normalized.textValue,
      number_value: normalized.numberValue,
      unit: normalized.unit,
      url_value: normalized.url,
      position,
    };
  });
  const { error } = await getSupabase().rpc("replace_product_fact_snapshot", {
    p_shop_id: snapshot.shopId, p_provider: snapshot.provider, p_facts: rows,
  });
  if (error) throw error;
}

export async function syncShopifyProductFacts(
  input: { shopId: string; shopDomain: string },
  dependencies: Dependencies = { fetch: fetchProductFactPages, replace: replaceProductFactSnapshot },
): Promise<{ products: number; facts: number }> {
  const facts: ProductFactSnapshotItem[] = [];
  const errors: string[] = [];
  let products = 0;
  for await (const page of dependencies.fetch(input.shopDomain)) {
    for (const product of page) {
      products += 1;
      try { facts.push(...mapShopifyProductFacts(product)); }
      catch (error) { errors.push(`${product.title} (${product.id}): ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (errors.length) throw new Error(`Invalid Shopify product facts:\n${errors.join("\n")}`);
  await dependencies.replace({ shopId: input.shopId, provider: "shopify", facts });
  return { products, facts: facts.length };
}
