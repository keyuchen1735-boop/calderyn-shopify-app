// Weather segments panel: live per-region forecast, the merchant's home
// location ask, and forecast-driven budget predictions (arm to execute when
// the weather trigger verifies, or apply immediately).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Card, Btn } from "./ui";
import { money } from "./format";
import { CDIcon } from "./icons";
import {
  fetchWeatherForecast,
  saveMerchantLocation,
  type WeatherForecastDTO,
  type WeatherSuggestionDTO,
} from "~/lib/dashboard/customers-client";
import { REGION_STATES, US_STATE_NAMES, type UsState } from "~/lib/ads/geo-regions";
import { REGION_CENTROIDS } from "~/lib/weather/regions";
import type { RegionCode } from "~/lib/ads/actions";

const REGION_LABEL: Record<string, string> = {
  "us-west": "West",
  "us-central": "Central",
  "us-south": "South",
  "us-east": "East",
};

const ALL_STATES = (Object.keys(US_STATE_NAMES) as UsState[]).sort((a, b) =>
  US_STATE_NAMES[a].localeCompare(US_STATE_NAMES[b]),
);

function CardHead({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: "14px 20px",
        borderBottom: "0.5px solid var(--hairline-strong)",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

// State-picker fallback stores the state's REGION centroid — coarse on
// purpose; the browser geolocation path is the precise one.
function stateCentroid(st: UsState): { lat: number; lon: number } | null {
  const region = (Object.keys(REGION_STATES) as RegionCode[]).find((r) =>
    (REGION_STATES[r] as readonly string[]).includes(st),
  );
  const c = REGION_CENTROIDS.find((p) => p.region === region);
  return c ? { lat: c.lat, lon: c.lon } : null;
}

export function WeatherSegments({
  suggestions,
  onIntent,
  toast,
}: {
  suggestions: WeatherSuggestionDTO[];
  onIntent: (id: string, intent: "apply" | "arm" | "dismiss") => void;
  toast: (msg: string, icon?: string, tone?: string) => void;
}) {
  const [forecast, setForecast] = useState<WeatherForecastDTO | null>(null);
  const [forecastError, setForecastError] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoDenied, setGeoDenied] = useState(false);

  const loadForecast = useCallback(() => {
    fetchWeatherForecast()
      .then((f) => {
        setForecast(f);
        setForecastError(false);
      })
      .catch(() => setForecastError(true));
  }, []);

  useEffect(() => {
    loadForecast();
  }, [loadForecast]);

  const saveLocation = async (lat: number, lon: number) => {
    try {
      await saveMerchantLocation(lat, lon);
      toast("Location saved — local forecast enabled", "check");
      loadForecast();
    } catch {
      toast("Could not save your location", "x", "critical");
    } finally {
      setLocating(false);
    }
  };

  const askBrowserLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoDenied(true);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => void saveLocation(pos.coords.latitude, pos.coords.longitude),
      () => {
        setLocating(false);
        setGeoDenied(true);
      },
      { timeout: 10_000 },
    );
  };

  const pending = suggestions.filter((s) => s.status === "pending");
  const armed = suggestions.filter((s) => s.status === "armed");

  return (
    <>
      {/* Reachable even when the forecast fetch fails (saving a location
          doesn't depend on Open-Meteo), but hidden while loading so located
          merchants don't see the ask flash. */}
      {forecastError || (forecast && !forecast.hasLocation) ? (
        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="cd-row-title">Where are you based?</div>
              <div className="cd-caption">
                Your location sharpens the forecast for your home region, which sharpens budget
                predictions.
              </div>
            </div>
            <Btn small kind="primary" onClick={askBrowserLocation} disabled={locating}>
              {locating ? "Locating…" : "Use my location"}
            </Btn>
            {geoDenied ? (
              <select
                className="cd-input"
                defaultValue=""
                aria-label="Select your state"
                onChange={(e) => {
                  const c = stateCentroid(e.target.value as UsState);
                  if (c) void saveLocation(c.lat, c.lon);
                }}
              >
                <option value="" disabled>
                  Or pick your state…
                </option>
                {ALL_STATES.map((st) => (
                  <option key={st} value={st}>
                    {US_STATE_NAMES[st]}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card pad={false}>
        <CardHead>
          <div>
            <div className="cd-row-title">Next 3 days by region</div>
            <div className="cd-caption">
              Higher demand score = weather favors more budget in that region
            </div>
          </div>
        </CardHead>
        {forecastError ? (
          <div className="cd-caption" style={{ padding: "16px 20px" }}>
            Could not load the forecast right now.
          </div>
        ) : !forecast ? (
          <div className="cd-caption" style={{ padding: "16px 20px" }}>
            Loading forecast…
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: 12,
              padding: "12px 16px 16px",
            }}
          >
            {forecast.regions.map((r) => (
              <div
                key={r.region}
                className="cd-trow"
                style={{ display: "block", padding: 12, borderRadius: 10 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div className="cd-row-title">{REGION_LABEL[r.region] ?? r.region}</div>
                  {forecast.homeRegion === r.region ? (
                    <span className="cd-caption" style={{ color: "var(--accent)" }}>
                      · you
                    </span>
                  ) : null}
                </div>
                <div className="cd-caption" style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <span>
                    <CDIcon name="sun" size={12} /> {Math.round(r.avgTempC)}°C
                  </span>
                  <span>
                    <CDIcon name="rain" size={12} /> {Math.round(r.precipMm)}mm
                  </span>
                </div>
                <div
                  aria-hidden
                  style={{
                    marginTop: 8,
                    height: 4,
                    borderRadius: 2,
                    background: "color-mix(in oklch, var(--accent) 12%, transparent)",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(r.score * 100)}%`,
                      height: "100%",
                      borderRadius: 2,
                      background: "var(--accent)",
                    }}
                  />
                </div>
                <div className="cd-caption tabular-nums" style={{ marginTop: 4 }}>
                  Demand score {(r.score * 100).toFixed(0)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card pad={false}>
        <CardHead>
          <div>
            <div className="cd-row-title">Predicted budget moves</div>
            <div className="cd-caption">
              Arm a move and it executes on its own once the forecast holds up
            </div>
          </div>
        </CardHead>
        {pending.length === 0 && armed.length === 0 ? (
          <div className="cd-caption" style={{ padding: "16px 20px" }}>
            No weather moves predicted right now. When the next 3 days&apos; forecast favors
            shifting budget between regions, they&apos;ll appear here.
          </div>
        ) : (
          [...armed, ...pending].map((s) => (
            <div
              key={s.id}
              className="cd-trow"
              style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="cd-row-title">{`${money(s.amountCents)}/day`}</div>
                <div className="cd-caption">{s.narrative}</div>
              </div>
              {s.status === "armed" ? (
                <>
                  <span
                    className="cd-caption"
                    style={{ color: "var(--accent)", whiteSpace: "nowrap" }}
                  >
                    <CDIcon name="bolt" size={12} /> Armed · fires when the forecast confirms ·
                    through {s.expiresOn}
                  </span>
                  <Btn small onClick={() => onIntent(s.id, "dismiss")}>
                    Disarm
                  </Btn>
                </>
              ) : (
                <>
                  <Btn small kind="primary" onClick={() => onIntent(s.id, "arm")}>
                    Arm
                  </Btn>
                  <Btn small onClick={() => onIntent(s.id, "apply")}>
                    Apply now
                  </Btn>
                  <Btn small onClick={() => onIntent(s.id, "dismiss")}>
                    Dismiss
                  </Btn>
                </>
              )}
            </div>
          ))
        )}
      </Card>
    </>
  );
}
