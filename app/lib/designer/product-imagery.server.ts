import { getSupabase } from "~/lib/supabase.server";

const PAGE_SIZE = 1_000;
const ID_CHUNK_SIZE = 100;

type Row = Record<string, unknown>;
type PageResult = { data: unknown[] | null; error: unknown };

async function readPages(run: (from: number, to: number) => PromiseLike<PageResult>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await run(from, from + PAGE_SIZE - 1);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function chunks(values: string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < values.length; index += ID_CHUNK_SIZE) {
    result.push(values.slice(index, index + ID_CHUNK_SIZE));
  }
  return result;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export interface DesignerProductImageryDependencies {
  listActiveProductIds(shopId: string): Promise<string[]>;
  listProductMediaIds(shopId: string, productIds: string[]): Promise<string[]>;
  listReadyAssetIds(shopId: string, productIds: string[]): Promise<string[]>;
}

const defaultDependencies: DesignerProductImageryDependencies = {
  async listActiveProductIds(shopId) {
    const rows = await readPages((from, to) => getSupabase()
      .from("product_dim")
      .select("id")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .order("id")
      .range(from, to));
    return rows.map((row) => nonemptyString(row.id)).filter((id): id is string => id !== null);
  },

  async listProductMediaIds(_shopId, productIds) {
    const pages = await Promise.all(chunks(productIds).map((chunk) => readPages((from, to) => getSupabase()
      .from("product_media")
      .select("product_id, storage_path, external_url")
      .in("product_id", chunk)
      .order("product_id")
      .range(from, to))));
    return pages.flatMap((page) => page
      .filter((row) => nonemptyString(row.storage_path) !== null || nonemptyString(row.external_url) !== null)
      .map((row) => nonemptyString(row.product_id))
      .filter((id): id is string => id !== null));
  },

  async listReadyAssetIds(shopId, productIds) {
    const pages = await Promise.all(chunks(productIds).map((chunk) => readPages((from, to) => getSupabase()
      .from("store_asset")
      .select("product_id, url")
      .eq("shop_id", shopId)
      .eq("status", "ready")
      .in("product_id", chunk)
      .order("product_id")
      .range(from, to))));
    return pages.flatMap((page) => page
      .filter((row) => nonemptyString(row.url) !== null)
      .map((row) => nonemptyString(row.product_id))
      .filter((id): id is string => id !== null));
  },
};

/** Exact all-active-catalog image readiness used by designer audits. Merchant
 * media wins, and a nonempty ready store_asset supplies the same fallback the
 * live catalog uses. Unlike the model context, this read is never capped at
 * the first 12 or 250 products. */
export async function designerProductImagesAvailable(
  shopId: string,
  dependencies: DesignerProductImageryDependencies = defaultDependencies,
): Promise<boolean> {
  const productIds = [...new Set(await dependencies.listActiveProductIds(shopId))];
  if (productIds.length === 0) return false;
  const [mediaIds, readyAssetIds] = await Promise.all([
    dependencies.listProductMediaIds(shopId, productIds),
    dependencies.listReadyAssetIds(shopId, productIds),
  ]);
  const covered = new Set([...mediaIds, ...readyAssetIds]);
  return productIds.every((id) => covered.has(id));
}
