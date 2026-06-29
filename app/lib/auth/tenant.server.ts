// app/lib/auth/tenant.server.ts
import { randomBytes } from "node:crypto";
import { getSupabase, seedShippedAutopilotFeatures } from "../supabase.server";

export function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "store";
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${base}-${suffix}`;
}

export async function provisionOwnedShop(
  displayName: string,
): Promise<{ shopId: string; orgSlug: string }> {
  const sb = getSupabase();
  const orgSlug = slugify(displayName);
  const { data, error } = await sb
    .from("shops")
    .insert({ org_slug: orgSlug, display_name: displayName })
    .select("id, org_slug")
    .single();
  if (error) throw error;
  const shopId = String(data.id);
  await seedShippedAutopilotFeatures(shopId, sb);
  return { shopId, orgSlug: String(data.org_slug) };
}

export async function linkMembership(
  userId: string,
  shopId: string,
  role: string = "owner",
): Promise<void> {
  const { error } = await getSupabase()
    .from("membership")
    .insert({ user_id: userId, shop_id: shopId, role });
  if (error) throw error;
}

export async function resolveShopForUser(userId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("membership")
    .select("shop_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? String(data.shop_id) : null;
}
