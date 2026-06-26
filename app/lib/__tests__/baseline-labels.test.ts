import { describe, it, expect } from "vitest";
import { DETECTOR_LABELS, DETECTOR_TERMS } from "../labels";

const NEW_IDS = [
  "out_of_stock_live",
  "inventory_untracked",
  "priced_below_cost",
  "thin_margin",
  "missing_cost",
] as const;

describe("baseline detector labels", () => {
  it("has a plain label and a term for every new detector", () => {
    for (const id of NEW_IDS) {
      expect(DETECTOR_LABELS[id]).toBeTruthy();
      expect(DETECTOR_TERMS[id]).toBeTruthy();
    }
  });
});
