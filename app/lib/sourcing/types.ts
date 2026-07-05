// app/lib/sourcing/types.ts
// Provider-blind sourcing DTOs. A SupplierAdapter normalizes any dropship
// provider (CJ / Zendrop / AliExpress / fixture) into these shapes so the
// ingest, scorer, and pick flow never branch on the provider.

export interface NormalizedSupplier {
  provider: string; // "cj" | "zendrop" | "aliexpress" | "fixture"
  externalSupplierId: string;
  name: string;
  reliabilityScore: number | null; // 0..1 if exposed, else null
}

export interface SourceSignal {
  kind: string; // "order_volume_30d" | "order_volume_7d" | "trend_index"
  value: number;
}

export interface NormalizedSourceProduct {
  provider: string;
  externalId: string;
  title: string;
  category: string | null;
  imageUrls: string[]; // hotlinkable supplier images
  unitCostCents: number;
  moq: number;
  leadTimeDays: number;
  supplier: NormalizedSupplier;
  signals: SourceSignal[];
}

// Read-model row for the Discover feed (global reference join + derived fields).
export interface DiscoverFeedItem {
  sourceProductId: string;
  title: string;
  category: string | null;
  imageUrl: string | null;
  unitCostCents: number;
  suggestedRetailCents: number;
  marginPct: number; // 0..1
  leadTimeDays: number;
  supplierName: string;
  supplierReliability: number | null;
  score: number; // 0..100
}

export interface PickResult {
  productId: string;
  storeRunId: string;
}
