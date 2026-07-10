// Resolve a shop's live storefront origin (https://<org_slug>.calderyncompany.com)
// from shops.org_slug. Null when the shop has no slug yet — callers fall back to
// a request-derived origin. Errors propagate; callers decide whether the lookup
// is decorative (fail-soft) or load-bearing.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { tenantDomain } from "./vercel-domain.server";

export async function tenantStorefrontOrigin(shopId: string): Promise<string | null> {
  if (!isUuid(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("shops")
    .select("org_slug")
    .eq("id", shopId)
    .maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" && data.org_slug ? data.org_slug : null;
  return slug ? `https://${tenantDomain(slug)}` : null;
}
