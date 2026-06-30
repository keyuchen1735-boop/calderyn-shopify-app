// app/lib/commerce/catalog.server.ts
// Product-feed projection for agentic surfaces. Reads v_agentic_catalog (already excludes
// out-of-stock 'deny' SKUs at the view level) and shapes a protocol-neutral feed item the
// ACP/MCP adapters translate. Money in cents.
import { getSupabase } from "~/lib/supabase.server";

export interface CatalogFeedItem {
  variantId: string;
  title: string;
  priceCents: number;
  currency: string;
  availableQty: number;
  vendor: string | null;
  category: string | null;
  tags: string[];
}

export async function getAgenticCatalog(shopId: string): Promise<CatalogFeedItem[]> {
  if (!shopId) throw new Error("shopId is required");
  const res = await getSupabase().from("v_agentic_catalog").select("*").eq("shop_id", shopId);
  if (res.error) throw res.error;
  return ((res.data ?? []) as Record<string, unknown>[]).map((r) => {
    return {
      variantId: String(r.variant_id),
      title: String(r.sku_title), // v_agentic_catalog exposes one sku_title (no product/variant split)
      priceCents: Number(r.retail_price_cents),
      currency: String(r.currency ?? "usd").toLowerCase(),
      availableQty: Number(r.on_hand ?? 0),
      vendor: r.vendor ? String(r.vendor) : null,
      category: r.category ? String(r.category) : null,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    };
  });
}
