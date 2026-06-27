import { describe, it, expect } from "vitest";
import { suggestedReorderQty, COVER_BUFFER_DAYS } from "../reorder-qty";

describe("suggestedReorderQty", () => {
  it("covers lead time + buffer minus current cover", () => {
    // velocity 2.86, lead 14, cover 3.5 -> ceil(2.86 * (14 + 14 - 3.5)) = ceil(70.07) = 71
    expect(
      suggestedReorderQty({ daily_velocity_units: "2.86", lead_time_days: 14, days_of_cover: "3.5" }),
    ).toBe(71);
  });

  it("falls back to lead-time cover when days_of_cover is missing", () => {
    // ceil(6.29 * (14 + 14 - 0)) = ceil(176.12) = 177
    expect(suggestedReorderQty({ daily_velocity_units: "6.29", lead_time_days: 14 })).toBe(177);
  });

  it("floors at 1 when the computed quantity is <= 0", () => {
    expect(
      suggestedReorderQty({ daily_velocity_units: "1", lead_time_days: 5, days_of_cover: "999" }),
    ).toBe(1);
  });

  it("returns null when velocity is missing or non-positive", () => {
    expect(suggestedReorderQty({ lead_time_days: 14 })).toBeNull();
    expect(suggestedReorderQty({ daily_velocity_units: "0", lead_time_days: 14 })).toBeNull();
  });

  it("exposes the buffer constant", () => {
    expect(COVER_BUFFER_DAYS).toBe(14);
  });
});
