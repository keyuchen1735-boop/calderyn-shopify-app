// app/lib/auth/tenant.server.ts
import { randomBytes } from "node:crypto";
import { getSupabase, seedShippedAutopilotFeatures } from "../supabase.server";
import { registerTenantDomain } from "../storefront/vercel-domain.server";

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
  const MAX_SLUG_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    const orgSlug = slugify(displayName);
    const { data, error } = await sb
      .from("shops")
      .insert({ org_slug: orgSlug, display_name: displayName })
      .select("id, org_slug")
      .single();
    if (error) {
      // Unique-violation on org_slug: regenerate the slug and retry.
      if ((error as { code?: string }).code === "23505") {
        lastError = error;
        continue;
      }
      throw error;
    }
    const shopId = String(data.id);
    await seedShippedAutopilotFeatures(shopId, sb);
    // Best-effort and off the signup critical path: attach the tenant's
    // calderyncompany.com subdomain to the Vercel project so the storefront
    // URL serves with a valid cert. waitUntil keeps the promise alive on
    // Vercel and no-ops locally; registerTenantDomain never throws, only
    // logs, and failures are replayable via scripts/backfill-tenant-domains.
    try {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(registerTenantDomain(String(data.org_slug)));
    } catch {
      void registerTenantDomain(String(data.org_slug));
    }
    return { shopId, orgSlug: String(data.org_slug) };
  }
  throw lastError;
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
