import { getSupabase } from "~/lib/supabase.server";

export interface SellingPlanSnapshot {
  groups: Array<{ externalId: string; name: string }>;
  plans: Array<{ externalId: string; groupExternalId: string; name: string; cadence: string }>;
  eligibility: Array<{ variantExternalId: string; planExternalId: string; priceCents?: number; currency?: string }>;
}

function bounded(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) throw new Error(`${label} must be a non-empty bounded string`);
  return normalized;
}

function canonical(snapshot: SellingPlanSnapshot) {
  const groups = snapshot.groups.map((group) => ({
    external_id: bounded(group.externalId, "group external ID"), name: bounded(group.name, "group name"),
  })).sort((a, b) => a.external_id.localeCompare(b.external_id));
  const groupIds = new Set(groups.map((group) => group.external_id));
  if (groupIds.size !== groups.length) throw new Error("selling-plan group external IDs must be unique");
  const plans = snapshot.plans.map((plan) => ({
    external_id: bounded(plan.externalId, "plan external ID"),
    group_external_id: bounded(plan.groupExternalId, "group external ID"),
    name: bounded(plan.name, "plan name"), cadence: bounded(plan.cadence, "plan cadence"),
  })).sort((a, b) => a.external_id.localeCompare(b.external_id));
  const planIds = new Set(plans.map((plan) => plan.external_id));
  if (planIds.size !== plans.length) throw new Error("selling-plan external IDs must be unique");
  if (plans.some((plan) => !groupIds.has(plan.group_external_id))) throw new Error("selling plan references an unknown group");
  const eligibility = snapshot.eligibility.map((entry) => {
    const priceCents = entry.priceCents;
    if (!planIds.has(entry.planExternalId)) throw new Error("eligibility references an unknown plan");
    if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 0 || !entry.currency)) {
      throw new Error("selling-plan eligibility price is invalid");
    }
    return {
      variant_external_id: bounded(entry.variantExternalId, "variant external ID"),
      plan_external_id: bounded(entry.planExternalId, "plan external ID"),
      ...(priceCents === undefined ? {} : { price_cents: priceCents, currency: bounded(entry.currency!, "currency").toUpperCase() }),
    };
  }).sort((a, b) => `${a.variant_external_id}\0${a.plan_external_id}`.localeCompare(`${b.variant_external_id}\0${b.plan_external_id}`));
  if (new Set(eligibility.map((entry) => `${entry.variant_external_id}\0${entry.plan_external_id}`)).size !== eligibility.length) {
    throw new Error("selling-plan eligibility entries must be unique");
  }
  return { groups, plans, eligibility };
}

export async function replaceSellingPlanSnapshot(
  shopId: string,
  provider: string,
  snapshot: SellingPlanSnapshot,
): Promise<{ groups: number; plans: number; eligibility: number }> {
  const normalizedShopId = bounded(shopId, "shop ID");
  const normalizedProvider = bounded(provider, "provider");
  const payload = canonical(snapshot);
  const { data, error } = await getSupabase().rpc("replace_selling_plan_snapshot", {
    p_shop_id: normalizedShopId,
    p_provider: normalizedProvider,
    p_groups: payload.groups,
    p_plans: payload.plans,
    p_eligibility: payload.eligibility,
  });
  if (error) throw new Error(`replace_selling_plan_snapshot failed: ${error.message ?? String(error)}`);
  return data as { groups: number; plans: number; eligibility: number };
}
