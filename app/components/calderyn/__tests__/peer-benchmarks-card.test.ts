import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { PeerBenchmarksCard } from "../PeerBenchmarksCard";
import type { PeerBenchmarks } from "~/lib/benchmarks/types";

function html(data: PeerBenchmarks): string {
  return renderToString(
    h(AppProvider, { i18n: en }, h(PeerBenchmarksCard, { data })),
  ).replace(/<!-- -->/g, "");
}

const AVAILABLE: PeerBenchmarks = {
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

describe("PeerBenchmarksCard", () => {
  it("renders the niche and a KPI row with peer band when available", () => {
    const out = html(AVAILABLE);
    expect(out).toContain("Peer Benchmarks");
    expect(out).toContain("Average order value");
    expect(out).toContain("electronics");
    expect(out).toContain("7 peers");
    expect(out).toContain("$300.00");
  });

  it("shows the opt-in prompt and the own value when not consented", () => {
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
    expect(out).toContain("$300.00"); // own value still shown
  });

  it("renders nothing (no card) for an uncategorized niche", () => {
    const out = html({ niche: "cat:uncategorized", consented: true, kpis: [] });
    expect(out).not.toContain("Peer Benchmarks");
  });

  it("shows the locked message when consented but no KPI is available", () => {
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
    expect(out).toContain("$300.00"); // own value still shown
  });

  it("never renders 'nullth pct' when a baseline exists but the shop has no own value", () => {
    const out = html({
      niche: "cat:electronics",
      consented: true,
      kpis: [
        {
          ...AVAILABLE.kpis[0],
          your_value: null, // no own value → percentile is null even though available
          percentile: null,
          n: 7,
          available: true,
        },
      ],
    });
    expect(out).not.toContain("null");
    expect(out).toContain("7 peers");
  });
});
