import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import { dangerouslyDeleteByTag } from "@vercel/functions";
import { storefrontTenantCacheTag } from "~/lib/storefront-runtime/cache.server";

export const STOREFRONT_POLICY_IDS = ["privacy", "terms", "refund", "shipping"] as const;
export type StorefrontPolicyId = (typeof STOREFRONT_POLICY_IDS)[number];

export interface StorefrontPolicy {
  id: StorefrontPolicyId;
  title: string;
  body: string;
  updatedAt: string;
}

export interface StorefrontPolicyLink {
  id: StorefrontPolicyId;
  title: string;
  href: string;
}

const POLICY_ID_SET = new Set<string>(STOREFRONT_POLICY_IDS);
export const STOREFRONT_POLICY_TITLE_MAX = 120;
export const STOREFRONT_POLICY_BODY_MAX = 50_000;

export function isStorefrontPolicyId(value: string): value is StorefrontPolicyId {
  return POLICY_ID_SET.has(value);
}

export function storefrontPolicyPath(policyId: StorefrontPolicyId): string {
  return `/storefront/policies/${policyId}`;
}

export function resolveStorefrontPolicyPath(pathname: string): StorefrontPolicyId | null {
  const match = /^\/storefront\/policies\/(privacy|terms|refund|shipping)\/?$/.exec(pathname);
  return match && isStorefrontPolicyId(match[1]) ? match[1] : null;
}

function title(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 120 ? normalized : null;
}

function policyFromRow(row: unknown): StorefrontPolicy | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const id = typeof record.policy_id === "string" && isStorefrontPolicyId(record.policy_id)
    ? record.policy_id
    : null;
  const safeTitle = title(record.title);
  if (!id || !safeTitle || typeof record.body !== "string" || typeof record.updated_at !== "string") return null;
  return { id, title: safeTitle, body: record.body, updatedAt: record.updated_at };
}

function normalizedPolicyInput(input: { id: string; title: string; body: string }): {
  id: StorefrontPolicyId;
  title: string;
  body: string;
} {
  if (!isStorefrontPolicyId(input.id)) {
    throw new CalderynError({ code: "invalid_storefront_policy_id", status: 422, message: "Choose a supported store policy." });
  }
  const normalizedTitle = input.title.trim();
  if (normalizedTitle.length === 0 || normalizedTitle.length > STOREFRONT_POLICY_TITLE_MAX) {
    throw new CalderynError({ code: "invalid_storefront_policy_title", status: 422, message: "Policy titles must be between 1 and 120 characters." });
  }
  const normalizedBody = input.body.trim();
  if (normalizedBody.length === 0 || normalizedBody.length > STOREFRONT_POLICY_BODY_MAX) {
    throw new CalderynError({ code: "invalid_storefront_policy_body", status: 422, message: "Policy text must be between 1 and 50,000 characters." });
  }
  return { id: input.id, title: normalizedTitle, body: normalizedBody };
}

async function purgeStorefrontPolicyHtml(shopId: string): Promise<void> {
  // Local development has no Vercel purge context and no shared CDN. Production
  // writes hard-delete every tenant-tagged storefront response so deleted legal
  // text can never remain available through stale-while-revalidate.
  if (process.env.VERCEL !== "1") return;
  try {
    await dangerouslyDeleteByTag(storefrontTenantCacheTag(shopId));
  } catch (cause) {
    console.error(`[storefront-policy] cache purge failed for shop ${shopId}`, cause);
    throw new CalderynError({
      code: "storefront_policy_cache_refresh_failed",
      status: 503,
      message: "The policy was saved, but the public store could not refresh. Save it again before publishing.",
    });
  }
}

export function storefrontPolicyLinks(policies: ReadonlyArray<Pick<StorefrontPolicy, "id" | "title">>): StorefrontPolicyLink[] {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  return STOREFRONT_POLICY_IDS.flatMap((id) => {
    const policy = byId.get(id);
    const safeTitle = title(policy?.title);
    return safeTitle ? [{ id, title: safeTitle, href: storefrontPolicyPath(id) }] : [];
  });
}

export async function loadStorefrontPolicyLinks(shopId: string): Promise<StorefrontPolicyLink[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("store_policy")
    .select("policy_id, title")
    .eq("shop_id", shopId)
    .order("policy_id");
  if (error) throw error;
  const policies = (data ?? []).flatMap((row): Array<Pick<StorefrontPolicy, "id" | "title">> => {
    const id = typeof row.policy_id === "string" && isStorefrontPolicyId(row.policy_id) ? row.policy_id : null;
    const safeTitle = title(row.title);
    return id && safeTitle ? [{ id, title: safeTitle }] : [];
  });
  return storefrontPolicyLinks(policies);
}

export async function loadStorefrontPolicy(shopId: string, policyId: string): Promise<StorefrontPolicy | null> {
  if (!isUuid(shopId) || !isStorefrontPolicyId(policyId)) return null;
  const { data, error } = await getSupabase()
    .from("store_policy")
    .select("policy_id, title, body, updated_at")
    .eq("shop_id", shopId)
    .eq("policy_id", policyId)
    .maybeSingle();
  if (error) throw error;
  const policy = policyFromRow(data);
  return policy?.id === policyId ? policy : null;
}

export async function loadStorefrontPolicies(shopId: string): Promise<StorefrontPolicy[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("store_policy")
    .select("policy_id, title, body, updated_at")
    .eq("shop_id", shopId)
    .order("policy_id");
  if (error) throw error;
  const byId = new Map((data ?? []).flatMap((row) => {
    const policy = policyFromRow(row);
    return policy ? [[policy.id, policy] as const] : [];
  }));
  return STOREFRONT_POLICY_IDS.flatMap((id) => {
    const policy = byId.get(id);
    return policy ? [policy] : [];
  });
}

export async function saveStorefrontPolicy(
  shopId: string,
  input: { id: string; title: string; body: string },
): Promise<StorefrontPolicy> {
  if (!isUuid(shopId)) {
    throw new CalderynError({ code: "invalid_storefront_policy_shop", status: 422, message: "This store cannot save policies." });
  }
  const policy = normalizedPolicyInput(input);
  const updatedAt = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from("store_policy")
    .upsert({
      shop_id: shopId,
      policy_id: policy.id,
      title: policy.title,
      body: policy.body,
      updated_at: updatedAt,
    }, { onConflict: "shop_id,policy_id" })
    .select("policy_id, title, body, updated_at")
    .single();
  if (error) throw error;
  const saved = policyFromRow(data);
  if (!saved) throw new Error("Store policy save returned an invalid record");
  await purgeStorefrontPolicyHtml(shopId);
  return saved;
}

export async function deleteStorefrontPolicy(shopId: string, policyId: string): Promise<void> {
  if (!isUuid(shopId) || !isStorefrontPolicyId(policyId)) {
    throw new CalderynError({ code: "invalid_storefront_policy_id", status: 422, message: "Choose a supported store policy." });
  }
  const { error } = await getSupabase()
    .from("store_policy")
    .delete()
    .eq("shop_id", shopId)
    .eq("policy_id", policyId);
  if (error) throw error;
  await purgeStorefrontPolicyHtml(shopId);
}
