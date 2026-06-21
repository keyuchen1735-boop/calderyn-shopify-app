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

describe("dashboard PeerBenchmarks — always expanded (no dropdown)", () => {
  it("shows the graphic up front with no disclosure toggle", () => {
    const out = html(AVAILABLE);
    expect(out).toContain("cd-bench-track"); // graphic is rendered…
    expect(out).not.toContain("aria-expanded"); // …with no collapse toggle
    expect(out).not.toContain("<button"); // and no toggle button at all
  });

  it("does not wrap the content in a collapsible region", () => {
    const out = html(AVAILABLE);
    expect(out).not.toContain("cd-collapse");
    expect(out).not.toContain("data-open");
  });
});

describe("dashboard PeerBenchmarks — peer-distribution bar", () => {
  it("draws the track, peer IQR band, median tick and you-marker when available", () => {
    const out = html(AVAILABLE);
    expect(out).toContain("cd-bench-track");
    expect(out).toContain("cd-bench-band");
    expect(out).toContain("cd-bench-median");
    expect(out).toContain("cd-bench-you");
  });

  it("positions the bar elements with percentage offsets", () => {
    const out = html(AVAILABLE);
    // band is placed by inline left/width percentages derived from the geometry
    expect(out).toMatch(/cd-bench-band[^>]*style="[^"]*%/);
  });

  it("omits the you-marker but keeps the band when the shop has no own value", () => {
    const out = html({
      niche: "cat:electronics",
      consented: true,
      kpis: [{ ...AVAILABLE.kpis[0], your_value: null, percentile: null, n: 7, available: true }],
    });
    expect(out).toContain("cd-bench-band");
    expect(out).not.toContain("cd-bench-you");
    expect(out).not.toContain("null");
  });

  it("renders no bar track for a locked (unavailable) KPI", () => {
    const out = html({
      niche: "cat:electronics",
      consented: true,
      kpis: [
        { ...AVAILABLE.kpis[0], available: false, p25: null, p50: null, p75: null, n: null, percentile: null },
      ],
    });
    expect(out).not.toContain("cd-bench-track");
    expect(out).toContain("$300.00"); // own value still shown
  });
});
