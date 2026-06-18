import { describe, it, expect } from "vitest";
import {
  IMPACT_WINDOW_DAYS,
  IMPACT_LABEL,
  IMPACT_SUFFIX,
} from "../impact-window";

// P1-5: alerts' dollar_impact is a 30-day projection (see assistant/prompt). The
// dashboard previously mislabeled it "/wk". This locks the single canonical
// window so both surfaces agree and a regression to weekly/other fails here.
describe("impact window", () => {
  it("is a 30-day window", () => {
    expect(IMPACT_WINDOW_DAYS).toBe(30);
  });

  it("labels and suffixes the window as 30-day, never weekly", () => {
    expect(IMPACT_LABEL).toMatch(/30-day/);
    expect(IMPACT_SUFFIX).toBe("/30d");
    expect(IMPACT_SUFFIX).not.toMatch(/wk|week/i);
    expect(IMPACT_LABEL).not.toMatch(/wk|week/i);
  });
});
