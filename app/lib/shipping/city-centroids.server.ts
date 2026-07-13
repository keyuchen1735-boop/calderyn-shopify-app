import { createRequire } from "node:module";

import type { WorldCitiesJsonModule } from "world-cities-json";
import { normalizePlace } from "./destination-aggregation";

export { normalizePlace } from "./destination-aggregation";

export interface CityLookupInput {
  city: string;
  region: string;
  country: string;
}

export interface WorldCityRow {
  city: string;
  city_ascii: string;
  lat: string;
  lng: string;
  country: string;
  iso2: string;
  iso3: string;
  admin_name: string;
  population?: string | number | null;
}

export interface ResolvedCity {
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

const require = createRequire(import.meta.url);

interface IndexedWorldCityRow {
  row: WorldCityRow;
  latitude: number;
  longitude: number;
  region: string;
  countries: readonly string[];
  population: number;
}

export type CityCentroidIndex = ReadonlyMap<
  string,
  readonly IndexedWorldCityRow[]
>;

let defaultCityIndex: CityCentroidIndex | undefined;

function loadWorldCityRows(): readonly WorldCityRow[] {
  const dataset = require("world-cities-json") as WorldCitiesJsonModule;
  return dataset.cities;
}

function buildCityIndex(rows: readonly WorldCityRow[]): CityCentroidIndex {
  const index = new Map<string, IndexedWorldCityRow[]>();

  for (const row of rows) {
    const latitude = Number(row.lat);
    const longitude = Number(row.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const cityNames = new Set([
      normalizePlace(row.city),
      normalizePlace(row.city_ascii),
    ]);
    const indexedRow: IndexedWorldCityRow = {
      row,
      latitude,
      longitude,
      region: normalizePlace(row.admin_name),
      countries: [
        normalizePlace(row.country),
        normalizePlace(row.iso2),
        normalizePlace(row.iso3),
      ],
      population: Number(row.population),
    };

    for (const cityName of cityNames) {
      const candidates = index.get(cityName);
      if (candidates) candidates.push(indexedRow);
      else index.set(cityName, [indexedRow]);
    }
  }

  return index;
}

export function getDefaultCityIndex(): CityCentroidIndex {
  defaultCityIndex ??= buildCityIndex(loadWorldCityRows());
  return defaultCityIndex;
}

export function resolveCityCentroid(
  input: CityLookupInput,
  rows?: readonly WorldCityRow[],
): ResolvedCity | null {
  const city = normalizePlace(input.city);
  const region = normalizePlace(input.region);
  const country = normalizePlace(input.country);

  const index = rows ? buildCityIndex(rows) : getDefaultCityIndex();
  const candidates = (index.get(city) ?? [])
    .map((candidate) => ({
      ...candidate,
      regionMatch: region.length > 0 && candidate.region === region,
    }))
    .filter(
      ({ countries }) => countries.includes(country),
    )
    .sort(
      (left, right) =>
        Number(right.regionMatch) - Number(left.regionMatch) ||
        (Number.isFinite(right.population) ? right.population : 0) -
          (Number.isFinite(left.population) ? left.population : 0),
    );

  const match = candidates[0];
  if (!match) return null;

  return {
    city: match.row.city,
    region: match.row.admin_name,
    country: match.row.iso2.toUpperCase(),
    latitude: match.latitude,
    longitude: match.longitude,
  };
}
