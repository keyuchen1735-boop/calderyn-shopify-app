import { describe, it, expect } from "vitest";
import * as client from "../client";

describe("dead Predictor-only screener client fns are pruned", () => {
  it("fetchLatestScreenRun, screenCreative, and adaptScreenRun are no longer exported", () => {
    expect("fetchLatestScreenRun" in client).toBe(false);
    expect("screenCreative" in client).toBe(false);
    expect("adaptScreenRun" in client).toBe(false);
  });

  it("the kept campaign drop-in surface is still exported", () => {
    expect(typeof client.screenCampaignCreative).toBe("function");
  });
});
