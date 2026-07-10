// Additive order-tag helper (Phase 2 Task 3, bulk tags): sibling to tags.ts's full-replace
// normalizeOrderTags, but UNIONS the normalized request with the order's existing tags instead
// of replacing them, and only inserts the missing rows — never a delete. Kept in its own
// .server file (tags.ts stays pure/client-safe, no Supabase import) since this helper does I/O.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "../calderyn.server";
import { MAX_ORDER_TAGS, normalizeTagEntries } from "./tags";

/**
 * Add tags to a native order without touching any tag already on it. `addTags` is normalized the
 * same way the full-replace path normalizes its list (trim, lowercase, 1-60 chars, dedupe); an
 * invalid entry 422s the whole call rather than silently dropping it. The normalized list is then
 * unioned with the order's current tags — existing tags always win a spot: if the union would
 * exceed MAX_ORDER_TAGS, the call throws (422 too_many_tags) instead of silently dropping whichever
 * new tags don't fit (rule 12). Only the tags that are actually new get inserted; nothing is ever
 * deleted. Returns the full resulting tag list, sorted.
 */
export async function addOrderTags(
  shopId: string,
  orderId: string,
  addTags: string[],
  sb: SupabaseClient = getSupabase(),
): Promise<string[]> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new Error("orderId is required");

  const normalizedAdd = normalizeTagEntries(addTags);
  if (normalizedAdd === null) {
    throw new CalderynError({
      code: "invalid_tags",
      status: 422,
      message: "tags must be an array of 1-60 char strings.",
    });
  }

  const existingRes = await sb.from("order_tag").select("tag").eq("shop_id", shopId).eq("order_id", orderId);
  if (existingRes.error) throw existingRes.error;
  const existing = ((existingRes.data ?? []) as Array<{ tag: string }>).map((r) => String(r.tag));

  const union = new Set<string>(existing);
  const missing: string[] = [];
  for (const tag of normalizedAdd) {
    if (!union.has(tag)) {
      union.add(tag);
      missing.push(tag);
    }
  }

  if (union.size > MAX_ORDER_TAGS) {
    throw new CalderynError({
      code: "too_many_tags",
      status: 422,
      message: `Adding these tags would exceed the ${MAX_ORDER_TAGS}-tag limit (order already has ${existing.length}).`,
    });
  }

  if (missing.length > 0) {
    // Concurrent adds of the same tag must both succeed (the tag is present either way).
    const insRes = await sb
      .from("order_tag")
      .upsert(missing.map((tag) => ({ shop_id: shopId, order_id: orderId, tag })), {
        onConflict: "shop_id,order_id,tag",
        ignoreDuplicates: true,
      });
    if (insRes.error) throw insRes.error;
  }

  return [...union].sort();
}
