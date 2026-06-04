import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../snapshot.server";
import type { CalderynClient } from "../../calderyn.server";

function fakeClient(alertCount: number): CalderynClient {
  const alerts = Array.from({ length: alertCount }, (_, i) => ({
    id: `a${i}`,
    detector_id: "campaign_below_breakeven",
    severity: i % 2 === 0 ? "critical" : "high",
    status: "open",
    dollar_impact: 100000 + i, // cents
    claude_rank: i + 1,
    created_at: "2026-06-02T00:00:00Z",
    title: `Alert ${i}`,
    narrative: "",
    campaign: null,
    sku: null,
    evidence: {},
  }));
  return {
    alerts: { list: async () => alerts, get: async () => alerts[0] },
    campaigns: { list: async () => [{ id: "c1" }, { id: "c2" }] },
    skus: { list: async () => [{ id: "s1" }] },
  } as unknown as CalderynClient;
}

describe("buildSnapshot", () => {
  it("includes counts and caps the alert list at 10", async () => {
    const text = await buildSnapshot(fakeClient(25));
    expect(text).toContain("Open alerts: 25");
    expect(text).toContain("Campaigns: 2");
    expect(text).toContain("SKUs: 1");
    expect(text.match(/- \[#/g)?.length).toBe(10);
    expect(text).toContain("$1,000"); // 100000 cents -> $1,000
  });

  it("handles the empty case", async () => {
    const text = await buildSnapshot(fakeClient(0));
    expect(text).toContain("Open alerts: 0");
    expect(text).toContain("No open alerts.");
  });
});
