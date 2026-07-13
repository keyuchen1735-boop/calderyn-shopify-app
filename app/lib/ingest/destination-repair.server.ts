import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderDestinationsByIds } from "./shopify-admin.server";

export const DESTINATION_REPAIR_LOOKBACK_DAYS = 30;
export const DESTINATION_REPAIR_ORDERS_PER_SHOP = 10;
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9]\d*$/;

export type DestinationRepairIntegration = {
  shopId: string;
  shopDomain: string;
  claimedAt: string;
};

export type DestinationRepairResult = {
  scanned: number;
  updated: number;
  checked: number;
  completed: boolean;
};

type ExistingDestination = {
  external_id: string;
  customer_city: string | null;
  customer_region: string | null;
  customer_country: string | null;
};

function normalized(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

async function updateIntegrationProgress(
  sb: SupabaseClient,
  integration: DestinationRepairIntegration,
  completedAt: string,
): Promise<void> {
  const { data, error } = await sb
    .from("shop_integrations")
    .update({ destination_repair_completed_at: completedAt })
    .eq("shop_id", integration.shopId)
    .eq("kind", "shopify")
    .in("sync_status", ["ready", "live"])
    .is("destination_repair_completed_at", null)
    .eq("destination_repair_attempted_at", integration.claimedAt)
    .select("shop_id");
  if (error) throw error;
  if (!data?.length) {
    throw new Error(
      `destination repair claim lost for shop ${integration.shopId}`,
    );
  }
}

/**
 * Repair one bounded batch of unchecked recent rows. A destination patch and
 * the checked marker are separate writes: the patch is fenced to null columns,
 * and the marker is written only after the API response and patch succeed.
 */
export async function repairOrderDestinationsForIntegration(
  integration: DestinationRepairIntegration,
  sb: SupabaseClient,
): Promise<DestinationRepairResult> {
  const attemptedAt = new Date().toISOString();
  const since = new Date(
    Date.now() - DESTINATION_REPAIR_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();

  const { data, error } = await sb
    .from("order_fact")
    .select("external_id, customer_city, customer_region, customer_country")
    .eq("shop_id", integration.shopId)
    .gte("created_at_source", since)
    .is("destination_repair_checked_at", null)
    .or(
      "customer_city.is.null,customer_region.is.null,customer_country.is.null",
    )
    .like("external_id", "gid://shopify/Order/%")
    .order("created_at_source", { ascending: true })
    .limit(DESTINATION_REPAIR_ORDERS_PER_SHOP + 1);
  if (error) throw error;

  const queued = (data ?? []) as ExistingDestination[];
  const candidates = queued.slice(0, DESTINATION_REPAIR_ORDERS_PER_SHOP);
  const completed = queued.length <= DESTINATION_REPAIR_ORDERS_PER_SHOP;
  if (!candidates.length) {
    await updateIntegrationProgress(sb, integration, attemptedAt);
    return { scanned: 0, updated: 0, checked: 0, completed: true };
  }

  const validIds = candidates
    .map((row) => row.external_id)
    .filter((externalId) => SHOPIFY_ORDER_GID.test(externalId));
  const fetched = validIds.length
    ? await fetchOrderDestinationsByIds(integration.shopDomain, validIds)
    : [];
  const fetchedById = new Map(fetched.map((order) => [order.id, order]));
  let updated = 0;
  let checked = 0;

  for (const row of candidates) {
    const destination = fetchedById.get(row.external_id);
    const patch: Record<string, string> = {};
    if (destination && row.customer_city == null) {
      const city = normalized(destination.city);
      if (city) patch.customer_city = city;
    }
    if (destination && row.customer_region == null) {
      const region = normalized(destination.region);
      if (region) patch.customer_region = region;
    }
    if (destination && row.customer_country == null) {
      const country = normalized(destination.country);
      if (country) patch.customer_country = country;
    }

    const columns = Object.keys(patch);
    if (columns.length) {
      let destinationUpdate = sb
        .from("order_fact")
        .update(patch)
        .eq("shop_id", integration.shopId)
        .eq("external_id", row.external_id)
        .is("destination_repair_checked_at", null);
      for (const column of columns)
        destinationUpdate = destinationUpdate.is(column, null);
      const { data: destinationRows, error: destinationError } =
        await destinationUpdate.select("id");
      if (destinationError) throw destinationError;
      updated += destinationRows?.length ?? 0;
    }

    const { data: checkedRows, error: checkedError } = await sb
      .from("order_fact")
      .update({ destination_repair_checked_at: attemptedAt })
      .eq("shop_id", integration.shopId)
      .eq("external_id", row.external_id)
      .is("destination_repair_checked_at", null)
      .select("id");
    if (checkedError) throw checkedError;
    checked += checkedRows?.length ?? 0;
  }

  if (completed) await updateIntegrationProgress(sb, integration, attemptedAt);
  return { scanned: candidates.length, updated, checked, completed };
}
