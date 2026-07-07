// app/lib/seo/seo-store.server.ts
// Persistence for merchant SEO overrides (seo_page) + per-shop SEO/AIO settings
// (seo_settings). Service-role client; every query is scoped by shop_id. seo_page
// is OVERRIDE-ONLY: a row exists only when a merchant hand-edited a page's meta;
// absence means the storefront serves the live engine draft. Non-uuid (demo)
// shops never touch the DB (mirrors settings.server.ts / crawlers.server.ts).
import { getSupabase } from "~/lib/supabase.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SeoEntityType = "product" | "home" | "collection";

export interface SeoSettings {
  allowAiCrawlers: boolean;
  allowAiTraining: boolean;
  orgName: string | null;
  orgDescription: string | null;
}

export interface SeoOverride {
  entityType: string;
  entityId: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

const DEFAULT_SETTINGS: SeoSettings = {
  allowAiCrawlers: true,
  allowAiTraining: false,
  orgName: null,
  orgDescription: null,
};

export async function getSeoSettings(shopId: string): Promise<SeoSettings> {
  if (!UUID_RE.test(shopId)) return { ...DEFAULT_SETTINGS };
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("allow_ai_crawlers, allow_ai_training, org_name, org_description")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    // Present-but-false must survive; only a truly missing column falls to default.
    allowAiCrawlers: data.allow_ai_crawlers !== false,
    allowAiTraining: data.allow_ai_training === true,
    orgName: (data.org_name as string | null) ?? null,
    orgDescription: (data.org_description as string | null) ?? null,
  };
}

export async function upsertSeoSettings(shopId: string, patch: Partial<SeoSettings>): Promise<SeoSettings> {
  if (!UUID_RE.test(shopId)) throw new Error(`upsertSeoSettings requires a real (uuid) shop_id, got ${shopId}`);
  const row: Record<string, unknown> = { shop_id: shopId, updated_at: new Date().toISOString() };
  if (patch.allowAiCrawlers !== undefined) row.allow_ai_crawlers = patch.allowAiCrawlers;
  if (patch.allowAiTraining !== undefined) row.allow_ai_training = patch.allowAiTraining;
  if (patch.orgName !== undefined) row.org_name = patch.orgName;
  if (patch.orgDescription !== undefined) row.org_description = patch.orgDescription;
  const { error } = await getSupabase().from("seo_settings").upsert(row, { onConflict: "shop_id" });
  if (error) throw error;
  return getSeoSettings(shopId);
}

function mapOverride(row: Record<string, unknown>): SeoOverride {
  return {
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    metaTitle: (row.meta_title as string | null) ?? null,
    metaDescription: (row.meta_description as string | null) ?? null,
  };
}

export async function getSeoOverride(shopId: string, entityType: string, entityId: string): Promise<SeoOverride | null> {
  if (!UUID_RE.test(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("seo_page")
    .select("entity_type, entity_id, meta_title, meta_description")
    .eq("shop_id", shopId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapOverride(data) : null;
}

export async function listSeoOverrides(shopId: string): Promise<Map<string, SeoOverride>> {
  const out = new Map<string, SeoOverride>();
  if (!UUID_RE.test(shopId)) return out;
  const { data, error } = await getSupabase()
    .from("seo_page")
    .select("entity_type, entity_id, meta_title, meta_description")
    .eq("shop_id", shopId);
  if (error) throw error;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const o = mapOverride(row);
    out.set(`${o.entityType}:${o.entityId}`, o);
  }
  return out;
}

export async function upsertSeoOverride(
  shopId: string,
  input: { entityType: string; entityId: string; metaTitle: string | null; metaDescription: string | null; updatedBy?: string | null },
): Promise<void> {
  if (!UUID_RE.test(shopId)) throw new Error(`upsertSeoOverride requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("seo_page").upsert(
    {
      shop_id: shopId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      meta_title: input.metaTitle,
      meta_description: input.metaDescription,
      updated_by: input.updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id,entity_type,entity_id" },
  );
  if (error) throw error;
}

export async function deleteSeoOverride(shopId: string, entityType: string, entityId: string): Promise<void> {
  if (!UUID_RE.test(shopId)) return;
  const { error } = await getSupabase()
    .from("seo_page")
    .delete()
    .eq("shop_id", shopId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) throw error;
}
