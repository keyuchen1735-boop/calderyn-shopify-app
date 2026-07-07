import { describe, it, expect } from "vitest";
import { INVENTORY_RELOCATION_DETECTORS } from "../autopilot.server";

describe("weather_demand autopilot routing", () => {
  it("routes weather_demand through inventory relocation", () => {
    expect(INVENTORY_RELOCATION_DETECTORS.has("weather_demand")).toBe(true);
  });
});
