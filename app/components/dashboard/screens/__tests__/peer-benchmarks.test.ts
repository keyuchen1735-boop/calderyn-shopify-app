import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { PeerBenchmarks } from "../PeerBenchmarks";
import type { PeerBenchmarks as Data } from "~/lib/benchmarks/types";

function html(data: Data, opts?: { defaultOpen?: boolean }): string {
  return renderToString(h(PeerBenchmarks, { data, ...opts })).replace(/<!-- -->/g, "");
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

describe("dashboard PeerBenchmarks — collapsible disclosure", () => {
  it("is collapsed by default with an aria-expanded toggle", () => {
    const out = html(AVAILABLE);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('data-open="0"');
  });

  it("renders expanded when defaultOpen is set", () => {
    const out = html(AVAILABLE, { defaultOpen: true });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('data-open="1"');
  });

  it("keeps the metric content in the DOM while collapsed (CSS-driven)", () => {
    // Disclosure hides via CSS, so the values remain server-rendered.
    const out = html(AVAILABLE);
    expect(out).toContain("Average order value");
    expect(out).toContain("$300.00");
  });

  it("wires the toggle button to the panel via aria-controls", () => {
    const out = html(AVAILABLE);
    const m = out.match(/aria-controls="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(out).toContain(`id="${m![1]}"`);
  });
});

describe("dashboard PeerBenchmarks — peer-distribution bar", () => {
  it("draws the track, peer IQR band, median tick and you-marker when available", () => {
    const out = html(AVAILABLE, { defaultOpen: true });
    expect(out).toContain("cd-bench-track");
    expect(out).toContain("cd-bench-band");
    expect(out).toContain("cd-bench-median");
    expect(out).toContain("cd-bench-you");
  });

  it("positions the bar elements with percentage offsets", () => {
    const out = html(AVAILABLE, { defaultOpen: true });
    // band is placed by inline left/width percentages derived from the geometry
    expect(out).toMatch(/cd-bench-band[^>]*style="[^"]*%/);
  });

  it("omits the you-marker but keeps the band when the shop has no own value", () => {
    const out = html(
      {
        niche: "cat:electronics",
        consented: true,
        kpis: [{ ...AVAILABLE.kpis[0], your_value: null, percentile: null, n: 7, available: true }],
      },
      { defaultOpen: true },
    );
    expect(out).toContain("cd-bench-band");
    expect(out).not.toContain("cd-bench-you");
    expect(out).not.toContain("null");
  });

  it("renders no bar track for a locked (unavailable) KPI", () => {
    const out = html(
      {
        niche: "cat:electronics",
        consented: true,
        kpis: [
          { ...AVAILABLE.kpis[0], available: false, p25: null, p50: null, p75: null, n: null, percentile: null },
        ],
      },
      { defaultOpen: true },
    );
    expect(out).not.toContain("cd-bench-track");
    expect(out).toContain("$300.00"); // own value still shown
  });
});
