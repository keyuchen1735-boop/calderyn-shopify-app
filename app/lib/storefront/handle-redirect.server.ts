// PDP miss-path lookup: a handle that no longer resolves may have been renamed
// in the editor, which leaves a product_handle_redirect row behind. Returns the
// target product's CURRENT handle when that product is still active, else null
// (the caller 404s as before). Runs only on the miss path — the happy path pays
// nothing. Service-role client, so every query is manually shop-scoped
// (mirrors catalog.owned.server).
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

export async function resolveHandleRedirect(shopId: string, handle: string): Promise<string | null> {
  // Demo shells / fixture shops have no uuid rows — nothing to look up.
  if (!isUuid(shopId) || !handle) return null;
  const sb = getSupabase();
  const { data: row, error } = await sb
    .from("product_handle_redirect")
    .select("product_id")
    .eq("shop_id", shopId)
    .eq("old_handle", handle)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const { data: product, error: pErr } = await sb
    .from("product_dim")
    .select("handle")
    .eq("shop_id", shopId)
    .eq("id", String(row.product_id))
    .eq("status", "active")
    .maybeSingle();
  if (pErr) throw pErr;
  const current = product ? String(product.handle) : null;
  // Self-target guard: a stale row whose target still carries this very handle
  // would 301 the URL to itself in a loop. Serve the 404 instead.
  return current && current !== handle ? current : null;
}
