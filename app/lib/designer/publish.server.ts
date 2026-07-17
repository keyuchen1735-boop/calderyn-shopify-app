// Publishing for the designer engine (hidden Labs): snapshots the display
// pages into designer_publications, which the public storefront serves in
// place of the runtime renderer. Cart and checkout are deliberately excluded —
// those stay on the functional storefront routes so commerce always works.
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { requirePublishableTenantDomain } from "~/lib/storebuilder/studio.server";

const PUBLISHED_ROUTES = ["base", "home", "collection", "product", "search"] as const;

/** Copies the current designer documents to the served snapshot and makes
 *  sure the tenant domain exists. Returns the public storefront URL. */
export async function publishDesignerSite(shopId: string): Promise<string> {
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
