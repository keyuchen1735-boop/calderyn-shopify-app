import { getSupabase } from "~/lib/supabase.server";
import {
  resolveCityCentroid,
  type WorldCityRow,
} from "./city-centroids.server";
import {
  partitionDestinationRows,
  type DestinationOrderRow,
} from "./destination-aggregation";
import type {
  ShippingRouteDestination,
  ShippingRoutes30d,
} from "./summary-types";

const DAY_MS = 86_400_000;
const MAX_DESTINATIONS = 60;
const ORDER_PAGE_SIZE = 1000;
const NORTH_AMERICA_COUNTRIES = new Set(["CA", "US", "MX"]);

interface ShippingRouteOriginRow {
  city: string;
  state: string;
  country: string;
}

export function buildShippingRoutes(
  origin: ShippingRouteOriginRow | null,
  rows: readonly DestinationOrderRow[],
  cityRows?: readonly WorldCityRow[],
): ShippingRoutes30d {
  const resolvedOrigin = origin
    ? resolveCityCentroid(
        { city: origin.city, region: origin.state, country: origin.country },
        cityRows,
      )
    : null;
  const { buckets, incompleteOrderCount } = partitionDestinationRows(rows);
  const resolvedDestinations: ShippingRouteDestination[] = [];
  let mappedOrderCount = 0;
  let unmappedOrderCount = incompleteOrderCount;

  for (const bucket of buckets) {
    const resolved = resolveCityCentroid(bucket, cityRows);
    if (!resolved) {
      unmappedOrderCount += bucket.orderCount;
      continue;
    }

    mappedOrderCount += bucket.orderCount;
    resolvedDestinations.push({
      id: bucket.id,
      ...resolved,
      orderCount: bucket.orderCount,
    });
  }

  const destinations = resolvedOrigin
    ? resolvedDestinations.slice(0, MAX_DESTINATIONS)
    : [];
  const hasInternationalDestinations = resolvedDestinations.some(
    (destination) => !NORTH_AMERICA_COUNTRIES.has(destination.country),
  );

  return {
    origin: resolvedOrigin,
    destinations,
    mappedOrderCount,
    unmappedOrderCount,
    hasInternationalDestinations,
  };
}

export async function loadShippingRoutes30d(
  shopId: string,
  now = new Date(),
): Promise<ShippingRoutes30d> {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const sb = getSupabase();
  const loadOrderRows = async (): Promise<DestinationOrderRow[]> => {
    const rows: DestinationOrderRow[] = [];
    for (let from = 0; ; from += ORDER_PAGE_SIZE) {
      const { data, error } = await sb
        .from("order_fact")
        .select("customer_city, customer_region, customer_country")
        .eq("shop_id", shopId)
        .gte("created_at_source", since)
        .order("created_at_source", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + ORDER_PAGE_SIZE - 1);
      if (error) throw new Error(`order_fact route read failed: ${error.message}`);

      const page = data ?? [];
      rows.push(
        ...page.map((row) => ({
          customer_city: row.customer_city == null ? null : String(row.customer_city),
          customer_region: row.customer_region == null ? null : String(row.customer_region),
          customer_country:
            row.customer_country == null ? null : String(row.customer_country),
        })),
      );
      if (page.length < ORDER_PAGE_SIZE) return rows;
    }
  };
  const [originResult, rows] = await Promise.all([
    sb
      .from("shop_origin")
      .select("city, state, country")
      .eq("shop_id", shopId)
      .maybeSingle(),
    loadOrderRows(),
  ]);

  if (originResult.error) {
    throw new Error(`shop_origin route read failed: ${originResult.error.message}`);
  }

  const origin = originResult.data
      ? {
          city: String(originResult.data.city ?? ""),
          state: String(originResult.data.state ?? ""),
          country: String(originResult.data.country ?? ""),
        }
      : null;

  return buildShippingRoutes(origin, rows);
}
