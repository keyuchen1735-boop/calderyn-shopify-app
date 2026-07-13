export interface DestinationOrderRow {
  customer_city: string | null;
  customer_region: string | null;
  customer_country: string | null;
}

export interface DestinationBucket {
  id: string;
  city: string;
  region: string;
  country: string;
  orderCount: number;
}

export interface DestinationPartition {
  buckets: DestinationBucket[];
  incompleteOrderCount: number;
}

export function normalizeDestinationPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function stableDestinationId(city: string, region: string, country: string): string {
  const key = [city, region, country].map(normalizeDestinationPart).join("\u001f");
  let hash = 0xcbf29ce484222325n;

  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return `destination-${hash.toString(16).padStart(16, "0")}`;
}

export function aggregateDestinationRows(
  rows: readonly DestinationOrderRow[],
): DestinationBucket[] {
  return partitionDestinationRows(rows).buckets;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function partitionDestinationRows(
  rows: readonly DestinationOrderRow[],
): DestinationPartition {
  const bucketsByDestination = new Map<string, DestinationBucket>();
  let incompleteOrderCount = 0;

  for (const row of rows) {
    const city = normalizeDestinationPart(row.customer_city ?? "");
    const region = normalizeDestinationPart(row.customer_region ?? "");
    const country = normalizeDestinationPart(row.customer_country ?? "");

    if (!city || !country) {
      incompleteOrderCount += 1;
      continue;
    }

    const id = stableDestinationId(city, region, country);
    const destinationKey = [city, region, country].join("\u001f");
    const existingBucket = bucketsByDestination.get(destinationKey);

    if (existingBucket) {
      existingBucket.orderCount += 1;
      continue;
    }

    bucketsByDestination.set(destinationKey, { id, city, region, country, orderCount: 1 });
  }

  const buckets = [...bucketsByDestination.values()].sort(
    (left, right) =>
      right.orderCount - left.orderCount ||
      compareCodeUnits(left.city, right.city) ||
      compareCodeUnits(left.region, right.region) ||
      compareCodeUnits(left.country, right.country),
  );

  return { buckets, incompleteOrderCount };
}
