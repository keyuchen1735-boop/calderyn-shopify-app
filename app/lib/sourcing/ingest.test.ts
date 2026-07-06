// app/lib/sourcing/ingest.test.ts
import { describe, it, expect } from "vitest";
import { toUpsertRows, suggestedRetailCents } from "./ingest.server";
import type { NormalizedSourceProduct } from "./types";

const prod: NormalizedSourceProduct = {
  provider: "fixture",
  externalId: "fx-1",
  title: "Mini Blender",
  category: "Kitchen",
  imageUrls: ["https://x/1.jpg"],
  unitCostCents: 850,
  moq: 1,
  leadTimeDays: 9,
  supplier: {
    provider: "fixture",
    externalSupplierId: "sup-a",
    name: "HomeGoods",
    reliabilityScore: 0.9,
  },
  signals: [
    { kind: "order_volume_30d", value: 8200 },
    { kind: "order_volume_7d", value: 3100 },
    { kind: "trend_index", value: 88 },
  ],
};

describe("suggestedRetailCents", () => {
  it("applies the deterministic markup", () => {
    expect(suggestedRetailCents(850)).toBe(2125); // 2.5x default
  });
});

describe("toUpsertRows", () => {
  it("builds a scored row from signals (phase external)", () => {
    const rows = toUpsertRows([prod], "external", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].score.score).toBeGreaterThan(60);
    expect(rows[0].score.phase).toBe("external");
    expect(rows[0].firstSeenDaysAgo).toBe(0);
  });
});
