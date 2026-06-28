import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DASH_TILE_IDS } from "../dashboard-layout";

describe("Overview no longer carries a Predictor tile", () => {
  it("the dashboard grid registry omits the predictor tile", () => {
    expect(DASH_TILE_IDS as readonly string[]).not.toContain("predictor");
  });

  it("Dashboard.tsx no longer renders a PredictorCard or navigates to predictor", () => {
    const src = readFileSync(new URL("../Dashboard.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("PredictorCard");
    expect(src).not.toContain('navigate("predictor")');
  });
});
