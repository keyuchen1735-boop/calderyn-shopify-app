// Weather segments panel: icon-led per-region forecast, the merchant's home
// location ask, and forecast-driven budget predictions (arm to execute when
// the weather trigger verifies, or apply immediately).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Card, Btn, Pill } from "./ui";
import { money, shortDate } from "./format";
import { CDIcon } from "./icons";
import {
  fetchWeatherForecast,
  saveMerchantLocation,
  type WeatherForecastDTO,
  type WeatherSuggestionDTO,
} from "~/lib/dashboard/customers-client";
import { conditionFor, type WeatherCondition } from "~/lib/weather/forecast-view";

const REGION_LABEL: Record<string, string> = {
  "us-west": "West",
  "us-central": "Central",
  "us-south": "South",
  "us-east": "East",
};

const COND_ICON: Record<WeatherCondition, string> = {
  clear: "sun",
  showers: "cloudSun",
  rain: "rain",
  snow: "snowflake",
};

const COND_COLOR: Record<WeatherCondition, string> = {
  clear: "var(--orange)",
  showers: "var(--text-2)",
  rain: "var(--accent)",
  snow: "var(--accent)",
};

const fahrenheit = (c: number): number => Math.round((c * 9) / 5 + 32);

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

/** Compact icon+label glyph for one endpoint of a budget-move flow row. */
function RegionGlyph({ region, cond }: { region: string; cond: WeatherCondition | null }) {
  return (
    <div style={{ textAlign: "center", minWidth: 52 }}>
      <CDIcon
        name={cond ? COND_ICON[cond] : "globe"}
        size={22}
        strokeWidth={1.6}
        style={{ color: cond ? COND_COLOR[cond] : "var(--text-3)" }}
      />
      <div className="cd-caption" style={{ marginTop: 2 }}>
        {REGION_LABEL[region] ?? region}
      </div>
    </div>
  );
}

export function WeatherSegments({
  suggestions,
  onIntent,
  toast,
  auto,
}: {
  suggestions: WeatherSuggestionDTO[];
  onIntent: (id: string, intent: "apply" | "arm" | "dismiss") => void;
  toast: (msg: string, icon?: string, tone?: string) => void;
  /** Sensitivity dial at 100: predictions arm and execute unattended. */
  auto: boolean;
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
      setGeoDenied(false);
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

  // Region → coarse condition, for the flow rows below the forecast grid.
  const condByRegion = new Map<string, WeatherCondition>(
    (forecast?.regions ?? []).map((r) => [r.region, conditionFor(r)]),
  );

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
            <CDIcon name="mapPin" size={20} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="cd-row-title">Set your location</div>
              <div className="cd-caption">Sharpens your home-region forecast</div>
            </div>
            <Btn small kind="primary" onClick={askBrowserLocation} disabled={locating}>
              <CDIcon name="locate" size={13} strokeWidth={2} />{" "}
              {locating ? "Locating…" : geoDenied ? "Try again" : "Find my location"}
            </Btn>
          </div>
          {geoDenied ? (
            <div className="cd-caption" style={{ color: "var(--red)", marginTop: 8 }}>
              Couldn&apos;t get your location — check location permissions in your browser and
              OS, then try again.
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card pad={false}>
        <CardHead>
          <div className="cd-row-title">Next 3 days</div>
          {auto ? (
            <Pill tone="success" icon="bolt">
              Auto
            </Pill>
          ) : null}
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
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 12,
              padding: "12px 16px 16px",
            }}
          >
            {forecast.regions.map((r) => {
              const cond = conditionFor(r);
              const home = forecast.homeRegion === r.region;
              return (
                <div
                  key={r.region}
                  className="cd-trow"
                  style={{ display: "block", padding: "14px 12px", borderRadius: 10, textAlign: "center" }}
                >
                  <CDIcon
                    name={COND_ICON[cond]}
                    size={34}
                    strokeWidth={1.5}
                    style={{ color: COND_COLOR[cond] }}
                  />
                  <div className="tabular-nums" style={{ fontSize: 25, fontWeight: 650, lineHeight: 1.2 }}>
                    {fahrenheit(r.avgTempC)}°
                  </div>
                  <div
                    className="cd-caption"
                    style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4 }}
                  >
                    {home ? (
                      <CDIcon name="mapPin" size={11} strokeWidth={2.2} style={{ color: "var(--accent)" }} />
                    ) : null}
                    {REGION_LABEL[r.region] ?? r.region}
                  </div>
                  {cond !== "clear" ? (
                    <div className="cd-caption tabular-nums" style={{ marginTop: 4 }}>
                      <CDIcon name={cond === "snow" ? "snowflake" : "rain"} size={11} />{" "}
                      {cond === "snow" ? `${Math.round(r.snowCm)}cm` : `${Math.round(r.precipMm)}mm`}
                    </div>
                  ) : null}
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
                    {(r.score * 100).toFixed(0)} demand
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card pad={false}>
        <CardHead>
          <div className="cd-row-title">Budget moves</div>
          {auto ? (
            <span className="cd-caption">Executes on its own when the forecast confirms</span>
          ) : (
            <span className="cd-caption">Armed moves execute when the forecast confirms</span>
          )}
        </CardHead>
        {pending.length === 0 && armed.length === 0 ? (
          <div className="cd-caption" style={{ padding: "16px 20px" }}>
            No weather moves predicted — needs two active campaigns each targeting a single US
            region.
          </div>
        ) : (
          [...armed, ...pending].map((s) => (
            <div
              key={s.id}
              className="cd-trow"
              title={s.narrative}
              style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                <RegionGlyph region={s.sourceRegion} cond={condByRegion.get(s.sourceRegion) ?? null} />
                <div style={{ textAlign: "center" }}>
                  <div className="cd-row-title tabular-nums" style={{ whiteSpace: "nowrap" }}>
                    {money(s.amountCents)}/day
                  </div>
                  <CDIcon name="arrowRight" size={16} strokeWidth={2} style={{ color: "var(--accent)" }} />
                </div>
                <RegionGlyph region={s.destRegion} cond={condByRegion.get(s.destRegion) ?? null} />
              </div>
              {s.status === "armed" ? (
                <>
                  <Pill tone="accent" icon="bolt">
                    {auto ? "Auto" : "Armed"} · thru {shortDate(s.expiresOn)}
                  </Pill>
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
