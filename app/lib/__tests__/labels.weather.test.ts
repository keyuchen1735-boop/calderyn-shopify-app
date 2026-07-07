import { describe, it, expect } from "vitest";
import { DETECTOR_TO_ACTIONS, DETECTOR_LABELS, DETECTOR_TERMS } from "../labels";

describe("weather_demand registration", () => {
  it("maps to inventory + budget actions and snooze", () => {
    expect(DETECTOR_TO_ACTIONS.weather_demand).toEqual([
      "reallocate_inventory",
      "reallocate_budget",
      "snooze_alert",
    ]);
  });
  it("has a plain label and a jargon term", () => {
    expect(DETECTOR_LABELS.weather_demand).toBeTruthy();
    expect(DETECTOR_TERMS.weather_demand).toBeTruthy();
  });
});
