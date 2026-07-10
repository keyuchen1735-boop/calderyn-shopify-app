// PDP miss-path lookup: a handle that no longer resolves may have been renamed
// in the editor, which leaves a product_handle_redirect row behind. Returns the
// target product's CURRENT handle when that product is still active, else null
// (the caller 404s as before). Runs only on the miss path — the happy path pays
// nothing. Service-role client, so the query is manually shop-scoped (mirrors
// catalog.owned.server); the target product is reached through the row's own
// product_id FK, so it needs no second shop filter.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

export async function resolveHandleRedirect(shopId: string, handle: string): Promise<string | null> {
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
 *  regeneration. Best-effort bounded read (PostgREST clamps at 1000 rows): a
 *  missed handle only downgrades that one link to /storefront. */
export async function listRedirectOldHandles(shopId: string): Promise<string[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("product_handle_redirect")
    .select("old_handle")
    .eq("shop_id", shopId);
  if (error) throw error;
  return (data ?? []).map((r: { old_handle: unknown }) => String(r.old_handle));
}
