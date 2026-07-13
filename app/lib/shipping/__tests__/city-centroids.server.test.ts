import { describe, expect, it } from "vitest";
import {
  normalizePlace,
  resolveCityCentroid,
  type WorldCityRow,
} from "../city-centroids.server";

const rows: WorldCityRow[] = [
  {
    city: "Portland",
    city_ascii: "Portland",
    lat: "45.5235",
    lng: "-122.6762",
    country: "United States",
    iso2: "US",
    iso3: "USA",
    admin_name: "Oregon",
    population: "652503",
  },
  {
    city: "Portland",
    city_ascii: "Portland",
    lat: "43.6591",
    lng: "-70.2568",
    country: "United States",
    iso2: "US",
    iso3: "USA",
    admin_name: "Maine",
    population: "68408",
  },
  {
    city: "Montréal",
    city_ascii: "Montreal",
    lat: "45.5019",
    lng: "-73.5674",
    country: "Canada",
    iso2: "CA",
    iso3: "CAN",
    admin_name: "Quebec",
    population: "1762949",
  },
];

describe("city centroid resolution", () => {
  it("normalizes accents, punctuation, and whitespace", () => {
    expect(normalizePlace("  Montréal—Nord ")).toBe("montreal nord");
  });

  it("prefers a matching administrative region", () => {
    expect(
      resolveCityCentroid(
        { city: "Portland", region: "Maine", country: "US" },
        rows,
      ),
    ).toMatchObject({ latitude: 43.6591, longitude: -70.2568 });
  });

  it("uses the highest population when the region is absent", () => {
    expect(
      resolveCityCentroid(
        { city: "Portland", region: "", country: "United States" },
        rows,
      ),
    ).toMatchObject({ region: "Oregon" });
  });

  it("matches ascii aliases and country codes", () => {
    expect(
      resolveCityCentroid(
        { city: "Montreal", region: "Quebec", country: "CA" },
        rows,
      ),
    ).toMatchObject({ city: "Montréal", country: "CA" });
  });

  it("returns null instead of inventing an unknown city", () => {
    expect(
      resolveCityCentroid(
        { city: "Not A City", region: "", country: "US" },
        rows,
      ),
    ).toBeNull();
  });

  it("resolves a known city from the installed world-cities-json package", () => {
    const resolved = resolveCityCentroid({
      city: "Toronto",
      region: "Ontario",
      country: "CA",
    });

    expect(resolved).toMatchObject({ city: "Toronto", country: "CA" });
    expect(Number.isFinite(resolved?.latitude)).toBe(true);
    expect(Number.isFinite(resolved?.longitude)).toBe(true);
  });

  it("reuses one normalized package index across default lookups", async () => {
    const cityCentroids = await import("../city-centroids.server");
    const getDefaultCityIndex = (
      cityCentroids as typeof cityCentroids & {
        getDefaultCityIndex?: () => object;
      }
    ).getDefaultCityIndex;

    expect(getDefaultCityIndex).toBeTypeOf("function");
    const index = getDefaultCityIndex?.();

    expect(
      resolveCityCentroid({ city: "Toronto", region: "Ontario", country: "CA" }),
    ).toMatchObject({ city: "Toronto", region: "Ontario", country: "CA" });
    expect(
      resolveCityCentroid({ city: "Montréal", region: "Quebec", country: "Canada" }),
    ).toMatchObject({ city: "Montréal", region: "Quebec", country: "CA" });
    expect(getDefaultCityIndex?.()).toBe(index);
  });
});
