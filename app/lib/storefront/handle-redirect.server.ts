// PDP miss-path lookup: a handle that no longer resolves may have been renamed
// in the editor, which leaves a product_handle_redirect row behind. Returns the
// target product's CURRENT handle when that product is still active, else null
// (the caller 404s as before). Runs only on the miss path — the happy path pays
// nothing. Service-role client, so the query is manually shop-scoped (mirrors
// catalog.owned.server). The embedded target is scoped independently too: a
// malformed cross-shop redirect row must never cross a tenant boundary.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

export async function resolveHandleRedirect(
  shopId: string,
  handle: string,
): Promise<string | null> {
  // Demo shells / fixture shops have no uuid rows — nothing to look up.
  if (!isUuid(shopId) || !handle) return null;
  const sb = getSupabase();
  // One round-trip: embed the target product over the product_id FK; !inner +
  // the embedded status filter drop the row when the target is not active.
  const { data, error } = await sb
    .from("product_handle_redirect")
    .select("old_handle, product_dim!inner(handle)")
    .eq("shop_id", shopId)
    .eq("old_handle", handle)
    .eq("product_dim.shop_id", shopId)
    .eq("product_dim.status", "active")
    .maybeSingle();
  if (error) throw error;
  const embedded = (data as { product_dim?: unknown } | null)?.product_dim;
  const target = Array.isArray(embedded) ? embedded[0] : embedded;
  const current =
    target && typeof (target as { handle?: unknown }).handle === "string"
      ? (target as { handle: string }).handle
      : null;
  // Self-target guard: a stale row whose target still carries this very handle
  // would 301 the URL to itself in a loop. Serve the 404 instead.
  return current && current !== handle ? current : null;
}

/** Every old_handle recorded for this shop's renamed products. Storegen link
 *  sets include these next to the CURRENT handles so a still-working renamed
 *  URL inside an existing page doc is not rewritten to the shop home on
 *  regeneration. Best-effort paged read: a missed handle only downgrades that
 *  one link to /storefront. */
export async function listRedirectOldHandles(
  shopId: string,
): Promise<string[]> {
  if (!isUuid(shopId)) return [];
  const handles: string[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabase()
      .from("product_handle_redirect")
      .select("old_handle")
      .eq("shop_id", shopId)
      .order("old_handle")
      .range(from, from + pageSize - 1);
    if (error) {
      // Store generation is allowed to forget a renamed-away link; aborting the
      // whole run would be a much larger failure than rewriting that link home.
      console.error("[storegen] product handle redirect listing failed", error);
      return [];
    }
    const page = (data ?? []) as Array<{ old_handle: unknown }>;
    handles.push(...page.map((row) => String(row.old_handle)));
    if (page.length < pageSize) break;
  }
  return handles;
}
