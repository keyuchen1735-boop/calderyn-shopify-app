import { describe, it, expect } from "vitest";

import { sortSkusByOnHandDesc } from "../client";
import type { SkuVM } from "~/components/dashboard/view-models";

function sku(id: string, on_hand: number): SkuVM {
  return { id, on_hand } as SkuVM;
}

describe("sortSkusByOnHandDesc", () => {
  it("orders SKUs by on-hand quantity, highest first", () => {
    const out = sortSkusByOnHandDesc([sku("a", 5), sku("b", 90), sku("c", 40)]);
    expect(out.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the original order for SKUs with equal on-hand (stable)", () => {
    const out = sortSkusByOnHandDesc([sku("a", 10), sku("b", 10), sku("c", 10)]);
    expect(out.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [sku("a", 1), sku("b", 9)];
    sortSkusByOnHandDesc(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("treats a missing on-hand as zero so it sorts to the bottom", () => {
    const out = sortSkusByOnHandDesc([
      sku("a", 3),
      { id: "b" } as SkuVM,
      sku("c", 7),
    ]);
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });
});
