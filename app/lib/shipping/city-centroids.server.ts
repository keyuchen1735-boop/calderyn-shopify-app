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

function loadWorldCityRows(): readonly WorldCityRow[] {
  const dataset = require("world-cities-json") as WorldCitiesJsonModule;
  return dataset.cities;
}

export function resolveCityCentroid(
  input: CityLookupInput,
  rows?: readonly WorldCityRow[],
): ResolvedCity | null {
  const city = normalizePlace(input.city);
  const region = normalizePlace(input.region);
  const country = normalizePlace(input.country);

  const candidates = (rows ?? loadWorldCityRows())
    .map((row) => ({
      row,
      latitude: Number(row.lat),
      longitude: Number(row.lng),
      regionMatch:
        region.length > 0 && normalizePlace(row.admin_name) === region,
      population: Number(row.population),
    }))
    .filter(
      ({ row, latitude, longitude }) =>
        (normalizePlace(row.city) === city ||
          normalizePlace(row.city_ascii) === city) &&
        (normalizePlace(row.country) === country ||
          normalizePlace(row.iso2) === country ||
          normalizePlace(row.iso3) === country) &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude),
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
