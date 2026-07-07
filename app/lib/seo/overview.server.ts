// app/lib/seo/overview.server.ts
// Read-models for the merchant Search screen. Composes the Plan A engine
// (writer -> score) over the owned catalog with the merchant's stored overrides +
// settings (seo-store) and the AI-crawler counters (seo_ai_crawl_daily). Every
// read is scoped by shop_id; service-role client.
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { CalderynError } from "~/lib/calderyn.server";
import { buildProductDraft } from "./writer.server";
import { scoreDraft } from "./score.server";
import { applyOverride } from "./override";
import { getSeoOverride, listSeoOverrides, getSeoSettings, type SeoSettings } from "./seo-store.server";
import type { HealthReport } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRAWL_WINDOW_DAYS = 28;
const NEEDS_ATTENTION_CAP = 12;

export interface NeedsAttentionRow {
  id: string;
  handle: string;
  title: string;
  score: number;
  topIssue: string | null;
  hasOverride: boolean;
}
export interface AiCrawlRow { botName: string; hits: number; }
export interface SeoOverviewVM {
  storeHealth: number;
  productCount: number;
  needsAttention: NeedsAttentionRow[];
  aiCrawls: AiCrawlRow[];
  aiCrawlTotal: number;
  settings: SeoSettings;
}
export interface GooglePreview { title: string; url: string; description: string; }
export interface ProductSeoDetailVM {
  id: string;
  handle: string;
  title: string;
  googlePreview: GooglePreview;
  health: HealthReport;
  override: { metaTitle: string | null; metaDescription: string | null } | null;
  aiSummary: string;
}

/** Absolute storefront origin for a shop, resolved from shops.org_slug. Falls back
 *  to a relative base ("") when the slug is unknown (e.g. an import-only Shopify
 *  shop): canonical/preview URLs then render relative, never with a wrong host. */
export async function getShopStorefrontOrigin(shopId: string): Promise<string> {
  if (!UUID_RE.test(shopId)) return "";
  const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  return slug ? `https://${tenantDomain(slug)}` : "";
}

async function summariseAiCrawls(shopId: string): Promise<{ rows: AiCrawlRow[]; total: number }> {
  if (!UUID_RE.test(shopId)) return { rows: [], total: 0 };
  const since = new Date(Date.now() - CRAWL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await getSupabase()
    .from("seo_ai_crawl_daily")
    .select("bot_name, hits")
    .eq("shop_id", shopId)
    .gte("day", since);
  if (error) throw error;
  const byBot = new Map<string, number>();
  let total = 0;
  for (const r of (data ?? []) as { bot_name: string; hits: number }[]) {
    const hits = Number(r.hits) || 0;
    total += hits;
    byBot.set(String(r.bot_name), (byBot.get(String(r.bot_name)) ?? 0) + hits);
  }
  const rows = [...byBot.entries()].map(([botName, hits]) => ({ botName, hits })).sort((a, b) => b.hits - a.hits);
  return { rows, total };
}

/** First failing check's plain-language label, or null when everything passes. */
function topIssue(report: HealthReport): string | null {
  const bad = report.checks.find((c) => c.status !== "pass");
  return bad ? bad.label : null;
}

export async function buildSeoOverview(shopId: string, storefrontOrigin: string): Promise<SeoOverviewVM> {
  const [products, overrides, settings, crawls, store] = await Promise.all([
    getCatalog().listProducts(shopId),
    listSeoOverrides(shopId),
    getSeoSettings(shopId),
    summariseAiCrawls(shopId),
    getStoreSettings(shopId),
  ]);

  let scoreSum = 0;
  const rows: NeedsAttentionRow[] = [];
  for (const p of products) {
    const override = overrides.get(`product:${p.id}`) ?? null;
    const draft = applyOverride(buildProductDraft(p, store, storefrontOrigin), override);
    const report = scoreDraft(draft);
    scoreSum += report.score;
    if (report.score < 100) {
      rows.push({ id: p.id, handle: p.handle, title: p.title, score: report.score, topIssue: topIssue(report), hasOverride: override != null });
    }
  }
  rows.sort((a, b) => a.score - b.score);

  return {
    storeHealth: products.length ? Math.round(scoreSum / products.length) : 0,
    productCount: products.length,
    needsAttention: rows.slice(0, NEEDS_ATTENTION_CAP),
    aiCrawls: crawls.rows,
    aiCrawlTotal: crawls.total,
    settings,
  };
}

export async function getProductSeoDetail(shopId: string, handle: string, storefrontOrigin: string): Promise<ProductSeoDetailVM> {
  const product = await getCatalog().getProduct(shopId, handle);
  if (!product) throw new CalderynError({ code: "not_found", status: 404, message: "Product not found" });
  const [store, override] = await Promise.all([
    getStoreSettings(shopId),
    getSeoOverride(shopId, "product", product.id),
  ]);
  const draft = applyOverride(buildProductDraft(product, store, storefrontOrigin), override);
  const health = scoreDraft(draft);

  const sellable = product.variants.filter((v) => v.priceCents > 0);
  const priceCents = sellable.length ? Math.min(...sellable.map((v) => v.priceCents)) : 0;
  const currency = sellable[0]?.currency ?? "";
  const inStock = product.variants.some((v) => v.available);
  const aiSummary = priceCents
    ? `${product.title} from ${store.storeName}. Priced at ${(priceCents / 100).toFixed(2)} ${currency}, ${inStock ? "in stock" : "out of stock"}.`
    : `${product.title} from ${store.storeName}. Not currently for sale.`;

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    googlePreview: { title: draft.title, url: draft.canonical, description: draft.description },
    health,
    override: override ? { metaTitle: override.metaTitle, metaDescription: override.metaDescription } : null,
    aiSummary,
  };
}
