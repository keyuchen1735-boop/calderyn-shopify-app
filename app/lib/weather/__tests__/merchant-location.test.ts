import { describe, it, expect } from "vitest";
import { nearestRegion, forecastPoints, REGION_CENTROIDS } from "../regions";

describe("nearestRegion", () => {
  it("maps coordinates to the closest region centroid", () => {
    expect(nearestRegion(37.77, -122.42)).toBe("us-west"); // San Francisco
    expect(nearestRegion(40.75, -73.99)).toBe("us-east"); // Manhattan
    expect(nearestRegion(33.75, -84.39)).toBe("us-south"); // Atlanta
    expect(nearestRegion(44.98, -93.27)).toBe("us-central"); // Minneapolis
  });
});

describe("forecastPoints", () => {
  it("returns the plain centroids when no merchant location is set", () => {
    expect(forecastPoints(null)).toEqual(REGION_CENTROIDS);
  });

  it("replaces the merchant's home-region centroid with their exact point", () => {
    const pts = forecastPoints({ lat: 47.61, lon: -122.33 }); // Seattle
    const west = pts.find((p) => p.region === "us-west");
    expect(west).toEqual({ region: "us-west", lat: 47.61, lon: -122.33 });
    // Other regions untouched, and still exactly one point per region.
    expect(pts).toHaveLength(REGION_CENTROIDS.length);
    expect(pts.filter((p) => p.region !== "us-west")).toEqual(
      REGION_CENTROIDS.filter((p) => p.region !== "us-west"),
    );
  });
});
