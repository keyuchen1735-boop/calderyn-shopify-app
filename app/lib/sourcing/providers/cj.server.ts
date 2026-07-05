// app/lib/sourcing/providers/cj.server.ts
// CJ Dropshipping adapter — the first real provider behind the provider-blind
// interface. CJ exposes an open product API (list/detail) plus supplier data.
// Only the two methods the ingest + pick need are implemented; auth is a single
// access token from env (CJ_ACCESS_TOKEN). Set SOURCING_PROVIDER=cj in prod once
// the token is configured; tests run on the fixture provider.
import type { SupplierAdapter } from "../supplier-adapter";
import type { NormalizedSourceProduct } from "../types";

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";

function token(): string {
  const value = process.env.CJ_ACCESS_TOKEN;
  if (!value) throw new Error("CJ_ACCESS_TOKEN not set");
  return value;
}

interface CjProduct {
  pid: string;
  productNameEn: string;
  categoryName?: string;
  productImage?: string;
  sellPrice?: string;
  supplierId?: string;
  supplierName?: string;
  listingCount?: number;
}

function normalize(p: CjProduct): NormalizedSourceProduct {
  const unitCostCents = Math.round(Number(p.sellPrice ?? "0") * 100);
  return {
    provider: "cj",
    externalId: p.pid,
    title: p.productNameEn,
    category: p.categoryName ?? null,
    imageUrls: p.productImage ? [p.productImage] : [],
    unitCostCents,
    moq: 1,
    leadTimeDays: 12,
    supplier: {
      provider: "cj",
      externalSupplierId: p.supplierId ?? "cj",
      name: p.supplierName ?? "CJ Dropshipping",
      reliabilityScore: null,
    },
    // CJ's listingCount (how many stores already sell it) is our order-volume proxy.
    signals: [{ kind: "order_volume_30d", value: Number(p.listingCount ?? 0) }],
  };
}

export const cjAdapter: SupplierAdapter = {
  provider: "cj",
  async getTrending(limit: number): Promise<NormalizedSourceProduct[]> {
    const res = await fetch(`${BASE}/product/list?pageSize=${limit}&pageNum=1`, {
      headers: { "CJ-Access-Token": token() },
    });
    if (!res.ok) throw new Error(`CJ getTrending ${res.status}`);
    const body = (await res.json()) as { data?: { list?: CjProduct[] } };
    return (body.data?.list ?? []).map(normalize);
  },
  async getProduct(externalId: string): Promise<NormalizedSourceProduct | null> {
    const res = await fetch(`${BASE}/product/query?pid=${encodeURIComponent(externalId)}`, {
      headers: { "CJ-Access-Token": token() },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: CjProduct };
    return body.data ? normalize(body.data) : null;
  },
};
