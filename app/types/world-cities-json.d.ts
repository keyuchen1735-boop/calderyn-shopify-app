declare module "world-cities-json" {
  export interface WorldCityJsonRow {
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

  export interface WorldCitiesJsonModule {
    cities: readonly WorldCityJsonRow[];
  }

  export const cities: readonly WorldCityJsonRow[];
}
