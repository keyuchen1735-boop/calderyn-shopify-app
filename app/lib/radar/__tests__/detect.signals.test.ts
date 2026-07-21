import { describe, expect, it } from "vitest";
import {
  detectAeoQuiet,
  detectAll,
  detectConversionGaps,
  detectJsonLdIssues,
  detectStaleHome,
  detectTrafficDrops,
} from "../detect.server";
import type { AiCrawlDay, RadarCollectInputs, TrafficDay } from "../types";

const NOW = new Date("2026-07-19T10:00:00Z");

function day(day: string, paths: Array<[string, number, number, string | null]>): TrafficDay {
  const views = paths.reduce((n, [, v]) => n + v, 0);
  const cartAdds = paths.reduce((n, [, , c]) => n + c, 0);
  return {
    day, views, sessions: views, cartAdds, checkouts: 0,
    topPaths: paths.map(([path, v, c, productId]) => ({ path, views: v, cartAdds: c, productId })),
  };
}

/** 7 baseline days of `views` on one path, then a last day of `lastViews`.
 *  cartAdds per baseline day is configurable so a traffic-drop fixture can
 *  stay clear of the conversion-gap detector (rate >= 1%) when a test wants
 *  exactly one candidate family. */
function dropSeries(
  path: string,
  views: number,
  lastViews: number,
  productId: string | null = null,
  cartAdds = 1,
): TrafficDay[] {
  const days: TrafficDay[] = [];
  for (let i = 0; i < 7; i++) days.push(day(`2026-07-${11 + i}`, [[path, views, cartAdds, productId]]));
  days.push(day("2026-07-18", [[path, lastViews, 0, productId]]));
  return days;
}

describe("detectTrafficDrops", () => {
  it("flags a top page down 30%+ vs its 7-day average", () => {
    const out = detectTrafficDrops(dropSeries("/storefront/products/trail-boots", 100, 60, "p1"));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("section_refresh");
    expect(out[0].dedupKey).toBe("traffic-drop:/storefront/products/trail-boots");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "pdp", handle: "trail-boots" });
    expect(String(out[0].payload.brief)).toContain("trail boots");
  });
  it("ignores small drops and thin baselines", () => {
    expect(detectTrafficDrops(dropSeries("/storefront", 100, 80))).toHaveLength(0); // 20% drop
    expect(detectTrafficDrops(dropSeries("/storefront", 10, 2))).toHaveLength(0); // avg under floor
  });
  it("does not fabricate a 100% drop when a top page is merely outranked off a full last day", () => {
    const target = "/storefront/products/trail-boots";
    const baseline: TrafficDay[] = [];
    for (let i = 0; i < 7; i++) baseline.push(day(`2026-07-${11 + i}`, [[target, 100, 1, "p1"]]));
    // Last day is a full 20-row rollup and the baseline top page is absent from it:
    // it was outranked, not zeroed, so its true count is unknown — no drop should fire.
    const saturated = Array.from({ length: 20 }, (_, i): [string, number, number, string | null] => [
      `/storefront/products/other-${i}`, 50, 1, `q${i}`,
    ]);
    expect(detectTrafficDrops([...baseline, day("2026-07-18", saturated)])).toHaveLength(0);
    // A genuine zero on a non-saturated (< 20 entries) last day still fires.
    const outZero = detectTrafficDrops([...baseline, day("2026-07-18", [["/storefront/products/other-0", 50, 1, "q0"]])]);
    expect(outZero).toHaveLength(1);
    expect(outZero[0].dedupKey).toBe(`traffic-drop:${target}`);
    expect(outZero[0].evidence.facts).toMatchObject({ lastViews: 0, dropPct: 100 });
  });
});

describe("detectConversionGaps", () => {
  it("flags 50+ views with cart-add rate under 1%", () => {
    const days: TrafficDay[] = [];
    for (let i = 0; i < 7; i++) days.push(day(`2026-07-${12 + i}`, [["/storefront/products/mug", 10, 0, "p9"]]));
    const out = detectConversionGaps(days);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toBe("conv-gap:p9");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "pdp", productId: "p9", handle: "mug" });
  });
  it("skips products that convert", () => {
    const days: TrafficDay[] = [];
    for (let i = 0; i < 7; i++) days.push(day(`2026-07-${12 + i}`, [["/storefront/products/mug", 10, 1, "p9"]]));
    expect(detectConversionGaps(days)).toHaveLength(0);
  });
});

describe("detectStaleHome", () => {
  const declining = [
    ...[0, 1, 2, 3, 4, 5, 6].map((i) =>
      day(`2026-07-${String(5 + i).padStart(2, "0")}`, [["/storefront", 100, 0, null]])),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => day(`2026-07-${12 + i}`, [["/storefront", 60, 0, null]])),
  ];
  it("flags a home page unchanged 6+ weeks with declining views", () => {
    const out = detectStaleHome(declining, "2026-05-01T00:00:00Z", NOW);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toBe("stale:home");
    expect(out[0].payload).toMatchObject({ applyMode: "refresh_section", target: "home" });
  });
  it("skips a recently published or unpublished home", () => {
    expect(detectStaleHome(declining, "2026-07-10T00:00:00Z", NOW)).toHaveLength(0);
    expect(detectStaleHome(declining, null, NOW)).toHaveLength(0);
  });
});

describe("detectAeoQuiet", () => {
  const priorHits: AiCrawlDay[] = [
    { botName: "GPTBot", day: "2026-07-01", hits: 4 },
    { botName: "ClaudeBot", day: "2026-07-05", hits: 3 },
  ];
  it("drafts a refresh move when hits go quiet and the description is missing", () => {
    const out = detectAeoQuiet(priorHits, { allowAiCrawlers: true, hasOrgDescription: false }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("aeo_refresh");
    expect(out[0].payload.applyMode).toBe("refresh_org");
  });
  it("drafts a review move when the description already exists", () => {
    const out = detectAeoQuiet(priorHits, { allowAiCrawlers: true, hasOrgDescription: true }, NOW);
    expect(out[0].payload.applyMode).toBe("review");
  });
  it("stays silent when crawlers are blocked, still active, or never came", () => {
    expect(detectAeoQuiet(priorHits, { allowAiCrawlers: false, hasOrgDescription: false }, NOW)).toHaveLength(0);
    const active = [...priorHits, { botName: "GPTBot", day: "2026-07-18", hits: 2 }];
    expect(detectAeoQuiet(active, { allowAiCrawlers: true, hasOrgDescription: false }, NOW)).toHaveLength(0);
    expect(detectAeoQuiet([], { allowAiCrawlers: true, hasOrgDescription: false }, NOW)).toHaveLength(0);
  });
});

describe("detectJsonLdIssues", () => {
  it("wraps validator issues into review moves that deep-link the product", () => {
    const out = detectJsonLdIssues([
      { productId: "p1", handle: "mug", title: "Mug", issues: ["Offer requires price, priceCurrency, availability"] },
      { productId: "p2", handle: "hat", title: "Hat", issues: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("aeo_jsonld_fix");
    expect(out[0].dedupKey).toBe("jsonld:product:p1");
    expect(out[0].payload).toMatchObject({ applyMode: "review", deepLink: "/dashboard/products/p1" });
  });
});

describe("detectAll", () => {
  it("concatenates every detector family over the collected inputs", () => {
    const inputs: RadarCollectInputs = {
      // cartAdds 2/day keeps the cart-add rate at 1.8%, so ONLY the traffic
      // drop fires from this fixture (not the conversion-gap detector too).
      traffic: dropSeries("/storefront/products/trail-boots", 100, 60, "p1", 2),
      rankings: [],
      aiCrawl: [{ botName: "GPTBot", day: "2026-07-01", hits: 6 }],
      allowAiCrawlers: true,
      hasOrgDescription: false,
      lastPublishedAt: "2026-07-15T00:00:00Z",
      jsonLdIssues: [{ productId: "p1", handle: "trail-boots", title: "Boots", issues: ["missing @type"] }],
      publishedRuntimeVersion: null,
      competitorDiffs: [],
    };
    const out = detectAll(inputs, NOW);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toEqual(["aeo_jsonld_fix", "aeo_refresh", "section_refresh"]);
  });
});
