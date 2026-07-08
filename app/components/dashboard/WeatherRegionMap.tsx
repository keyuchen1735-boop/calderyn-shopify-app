// Region weather map for the Forecast card: one marker per US region showing
// the selected day's condition + temperature, demand tier as border emphasis,
// and the merchant's home region pinned. Loaded lazily from WeatherSegments so
// maplibre-gl ships as its own chunk, not in the main dashboard bundle.
import { CDIcon } from "./icons";
import type { DemandTier } from "~/lib/weather/forecast-view";
import {
  Map as RegionMap,
  MapControls,
  MapMarker,
  MarkerContent,
  MarkerLabel,
  MarkerTooltip,
} from "~/components/ui/mapcn-map";
import { REGION_CENTROIDS } from "~/lib/weather/regions";

const CENTROID_BY_REGION = new Map<string, (typeof REGION_CENTROIDS)[number]>(
  REGION_CENTROIDS.map((c) => [c.region, c]),
);

/** Per-region values precomputed by WeatherSegments — one source for the map
 *  markers and the card grid, so the two can't drift. */
export interface RegionMapView {
  region: string;
  label: string;
  home: boolean;
  /** CDIcon name + color for the region's (day-narrowed) condition. */
  icon: string;
  color: string;
  tempF: number;
  /** Window-level demand tier (map emphasis) and its plain-language label. */
  tier: DemandTier;
  demandText: string;
}

export default function WeatherRegionMap({
  views,
  dark,
  onLocate,
  onLocateError,
}: {
  views: RegionMapView[];
  dark: boolean;
  onLocate: (lat: number, lon: number) => void;
  onLocateError: () => void;
}) {
  return (
    <RegionMap
      center={[-96.5, 38.8]}
      zoom={3}
      minZoom={2.5}
      maxZoom={7}
      cooperativeGestures
      theme={dark ? "dark" : "light"}
    >
      {/* Locate doubles as the location ask: flying home also saves the
          merchant's location, same as the card above. */}
      <MapControls
        position="top-right"
        showCompass
        showLocate
        showFullscreen
        onLocate={(c) => onLocate(c.latitude, c.longitude)}
        onLocateError={onLocateError}
      />
      {views.map((v) => {
        const c = CENTROID_BY_REGION.get(v.region);
        if (!c) return null;
        return (
          <MapMarker key={v.region} longitude={c.lon} latitude={c.lat}>
            <MarkerContent>
              <div className="mapcn-region" data-demand={v.tier}>
                {v.home ? (
                  <CDIcon name="mapPin" size={11} strokeWidth={2.2} style={{ color: "var(--accent)" }} />
                ) : null}
                <CDIcon name={v.icon} size={14} strokeWidth={2} style={{ color: v.color }} />
                <span className="tabular-nums">{v.tempF}°</span>
              </div>
              <MarkerLabel position="bottom">{v.label}</MarkerLabel>
            </MarkerContent>
            <MarkerTooltip>{v.demandText}</MarkerTooltip>
          </MapMarker>
        );
      })}
    </RegionMap>
  );
}
