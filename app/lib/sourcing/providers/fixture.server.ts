// app/lib/sourcing/providers/fixture.server.ts
import type { SupplierAdapter } from "../supplier-adapter";
import type { NormalizedSourceProduct } from "../types";
import seed from "../fixtures/trending.json";

const DATA = seed as NormalizedSourceProduct[];

export const fixtureAdapter: SupplierAdapter = {
  provider: "fixture",
  async getTrending(limit: number): Promise<NormalizedSourceProduct[]> {
    return DATA.slice(0, Math.max(0, limit));
  },
  async getProduct(externalId: string): Promise<NormalizedSourceProduct | null> {
    return DATA.find((p) => p.externalId === externalId) ?? null;
  },
};
