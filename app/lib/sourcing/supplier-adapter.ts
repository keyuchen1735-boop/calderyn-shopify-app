// app/lib/sourcing/supplier-adapter.ts
import type { NormalizedSourceProduct } from "./types";
import { fixtureAdapter } from "./providers/fixture.server";
import { cjAdapter } from "./providers/cj.server";

export interface SupplierAdapter {
  provider: string;
  /** Trending/"hot" products, the low-API primary signal. */
  getTrending(limit: number): Promise<NormalizedSourceProduct[]>;
  /** One product by the provider's external id (used by pick to refresh). */
  getProduct(externalId: string): Promise<NormalizedSourceProduct | null>;
}

const ADAPTERS: Record<string, SupplierAdapter> = {
  fixture: fixtureAdapter,
  cj: cjAdapter,
};

/** Resolve an adapter by name; defaults to SOURCING_PROVIDER (fixture in dev). */
export function getSupplierAdapter(
  provider: string = process.env.SOURCING_PROVIDER || "fixture",
): SupplierAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unknown sourcing provider: ${provider}`);
  return adapter;
}
