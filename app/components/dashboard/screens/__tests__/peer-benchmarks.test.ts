import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { PeerBenchmarks } from "../PeerBenchmarks";
import type { PeerBenchmarks as Data } from "~/lib/benchmarks/types";

function html(data: Data): string {
  return renderToString(h(PeerBenchmarks, { data })).replace(/<!-- -->/g, "");
}

const AVAILABLE: Data = {
  niche: "cat:electronics",
  consented: true,
  kpis: [
    {
      metric_key: "aov",
      label: "Average order value",
      unit: "USD",
      your_value: 300,
      p25: 200,
      p50: 300,
      p75: 400,
      n: 7,
      percentile: 50,
      available: true,
    },
  ],
};

describe("dashboard PeerBenchmarks", () => {
  it("renders the niche label and KPI when available", () => {
    const out = html(AVAILABLE);
    expect(out).toContain("Peer Benchmarks");
    expect(out).toContain("Average order value");
    expect(out).toContain("electronics");
    expect(out).toContain("7 peers");
    expect(out).toContain("$300.00");
  });

  it("renders the opt-in prompt and own value when not consented", () => {
    const out = html({
      niche: "cat:electronics",
      consented: false,
      kpis: [
        {
          ...AVAILABLE.kpis[0],
          available: false,
          p25: null,
          p50: null,
          p75: null,
          n: null,
          percentile: null,
        },
      ],
    });
    expect(out).toContain("Share anonymized metrics");
    expect(out).toContain("$300.00");
  });

  it("shows the locked message when consented but nothing available", () => {
    const out = html({
      niche: "cat:electronics",
      consented: true,
      kpis: [
        {
          ...AVAILABLE.kpis[0],
          available: false,
          p25: null,
          p50: null,
          p75: null,
          n: null,
          percentile: null,
        },
      ],
    });
    expect(out).toContain("Benchmarks unlock when 5+ electronics");
  });

  it("never renders 'nullth pct' when a baseline exists but no own value", () => {
    const out = html({
      niche: "cat:electronics",
      consented: true,
      kpis: [{ ...AVAILABLE.kpis[0], your_value: null, percentile: null, n: 7, available: true }],
    });
    expect(out).not.toContain("null");
    expect(out).toContain("7 peers");
  });

  it("renders empty for an uncategorized niche", () => {
    const out = html({ niche: "cat:uncategorized", consented: true, kpis: [] });
    expect(out).toBe("");
  });
});
