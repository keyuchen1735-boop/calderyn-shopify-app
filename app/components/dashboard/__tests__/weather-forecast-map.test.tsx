// The Forecast card's map section: tall enough to read the four region
// markers, and absent entirely when there are no regions to plot. Static
// markup only (repo has no jsdom); marker/tooltip behavior lives in maplibre.
import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForecastMap } from "../WeatherSegments";
import type { RegionMapView } from "../WeatherRegionMap";

// Keep the lazy maplibre-gl chunk out of this DOM-less process.
vi.mock("../WeatherRegionMap", () => ({ default: () => null }));

const view: RegionMapView = {
  region: "us-west",
  label: "US West",
  home: false,
  icon: "sun",
  color: "var(--orange)",
  tempF: 71,
  tier: "high",
  demandText: "High demand",
};

function render(views: RegionMapView[]): string {
  return renderToStaticMarkup(
    h(ForecastMap, { views, dark: true, onLocate: () => {}, onLocateError: () => {} }),
  );
}

describe("ForecastMap", () => {
  it("renders the map region 320px tall", () => {
    expect(render([view])).toContain("height:320px");
  });

  it("renders nothing when there are no regions to plot", () => {
    expect(render([])).toBe("");
  });
});
