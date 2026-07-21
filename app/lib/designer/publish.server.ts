// Publishing for the designer engine (hidden Labs): snapshots the display
// pages into designer_publications, which the public storefront serves in
// place of the runtime renderer. Cart and checkout are deliberately excluded —
// those stay on the functional storefront routes so commerce always works.
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { requirePublishableTenantDomain } from "~/lib/storebuilder/studio.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { expireOverdueExperiment, hasRunningExperiment } from "~/lib/experiments/store-experiment.server";

const PUBLISHED_ROUTES = ["base", "home", "collection", "product", "search"] as const;

/** Copies the current designer documents to the served snapshot and makes
 *  sure the tenant domain exists. Returns the public storefront URL. */
export async function publishDesignerSite(shopId: string): Promise<string> {
  // Draft edits are always safe mid-experiment, but PUBLISHING would shadow
  // both experiment arms with the designer snapshot and invalidate the test.
  await expireOverdueExperiment(shopId);
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is running on your store. Decide it before publishing a new design.",
    });
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from("designer_documents")
    .select("route, html, css")
    .eq("shop_id", shopId)
    .in("route", [...PUBLISHED_ROUTES]);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.some((row) => row.route === "home")) {
    throw new CalderynError({
      code: "designer_not_built",
      status: 422,
      message: "Build your store in the designer before publishing.",
    });
  }

  const storefrontUrl = await requirePublishableTenantDomain(shopId);
  const snapshot = rows.map((row) => ({
    shop_id: shopId,
    route: String(row.route),
    html: String(row.html ?? ""),
    css: String(row.css ?? ""),
    published_at: new Date().toISOString(),
  }));
  const { error: upsertError } = await sb
    .from("designer_publications")
    .upsert(snapshot, { onConflict: "shop_id,route" });
  if (upsertError) throw upsertError;
  return storefrontUrl;
}

/** Read-only publication status, cheap enough to poll: when the home snapshot
 *  landed, plus the storefront URL for a publication that exists (no domain
 *  registration here — publishing already ensured it). The studio polls this
 *  because a publish POST's response can arrive minutes after the server
 *  finished the actual publish; the row is the truth. */
export async function designerPublicationStatus(
  shopId: string,
): Promise<{ publishedAt: string | null; storefrontUrl: string | null }> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("designer_publications")
    .select("published_at")
    .eq("shop_id", shopId)
    .eq("route", "home")
    .maybeSingle();
  if (error) throw error;
  const publishedAt = data?.published_at ? String(data.published_at) : null;
  if (!publishedAt) return { publishedAt: null, storefrontUrl: null };
  if (process.env.NODE_ENV === "development") return { publishedAt, storefrontUrl: "/storefront" };
  const { data: shop, error: shopError } = await sb.from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (shopError) throw shopError;
  const orgSlug = typeof shop?.org_slug === "string" ? shop.org_slug.trim() : "";
  return { publishedAt, storefrontUrl: orgSlug ? `https://${tenantDomain(orgSlug)}/storefront` : null };
}
