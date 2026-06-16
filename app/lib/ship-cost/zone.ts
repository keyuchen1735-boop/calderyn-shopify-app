export type Zone = "domestic" | "continental" | "international";

// North-America bloc for the coarse continental bucket. Default v1 buckets;
// merchant-tunable later (Plan 2).
const CONTINENTAL = new Set(["US", "CA", "MX"]);

export function classifyZone(
  shopCountry: string | null,
  orderCountry: string | null,
): Zone {
  if (!shopCountry || !orderCountry) return "domestic";
  if (shopCountry === orderCountry) return "domestic";
  if (CONTINENTAL.has(shopCountry) && CONTINENTAL.has(orderCountry)) {
    return "continental";
  }
  return "international";
}

export function zoneMultiplier(zone: Zone): number {
  switch (zone) {
    case "domestic":
      return 1;
    case "continental":
      return 1.6;
    case "international":
      return 3;
  }
}
