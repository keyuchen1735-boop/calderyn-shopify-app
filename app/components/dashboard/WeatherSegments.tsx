// Weather segments panel: icon-led per-region forecast, the merchant's home
// location ask, and forecast-driven budget predictions (arm to execute when
// the weather trigger verifies, or apply immediately).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Card, Btn, Pill, Segmented } from "./ui";
import { money, shortDate } from "./format";
import { CDIcon } from "./icons";
import {
  fetchWeatherForecast,
  saveMerchantLocation,
  type WeatherForecastDTO,
  type WeatherSuggestionDTO,
} from "~/lib/dashboard/customers-client";
import { conditionFor, demandLabel, sortMoves, type WeatherCondition } from "~/lib/weather/forecast-view";
import { explainMove } from "~/lib/weather/explain";
import type { WeatherMode } from "~/lib/weather/types";

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
  mode,
  onMode,
}: {
  suggestions: WeatherSuggestionDTO[];
  onIntent: (id: string, intent: "apply" | "arm" | "dismiss") => void;
  toast: (msg: string, icon?: string, tone?: string) => void;
  /** Automation level: off (no predictions), approve (merchant confirms), auto
   *  (predictions arm and execute unattended). */
  mode: WeatherMode;
  onMode: (next: WeatherMode) => void;
}) {
  const auto = mode === "auto";
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

  // Region → coarse condition (3-day window), for the flow rows below.
  const condByRegion = new Map<string, WeatherCondition>(
    (forecast?.regions ?? []).map((r) => [r.region, conditionFor(r)]),
  );

  // Day chips: Today, then the following forecast dates. Cards show the
  // selected day; the demand meter stays window-level (scores are 3-day
  // quantities). Undated series → window aggregates, no chips.
  const [dayKey, setDayKey] = useState("0");
  const days = forecast?.regions.find((r) => r.days && r.days.length > 0)?.days ?? [];
  const dayIdx = days.length > 0 ? Math.min(Number(dayKey), days.length - 1) : null;

  // Manual: pending moves wait for approve/reject/schedule. Auto: moves run
  // unattended; executed ones surface below with when and why.
  const active = suggestions.filter((s) => s.status === "pending" || s.status === "armed");
  const executed = suggestions.filter((s) => s.status === "applied");

  // Clicked-open move showing its plain-English justification.
  const [openId, setOpenId] = useState<string | null>(null);
  const fcByRegion = new Map((forecast?.regions ?? []).map((r) => [r.region, r]));

  const renderMove = (s: WeatherSuggestionDTO) => {
    const open = openId === s.id;
    const why = explainMove({
      sourceName: REGION_LABEL[s.sourceRegion] ?? s.sourceRegion,
      destName: REGION_LABEL[s.destRegion] ?? s.destRegion,
      source: fcByRegion.get(s.sourceRegion) ?? null,
      dest: fcByRegion.get(s.destRegion) ?? null,
    });
    return (
      <div key={s.id} className="cd-trow" style={{ display: "block" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          {/* The flow cluster is the click target for the justification;
              flex-start + a fixed 22px arrow row keeps the arrow on the
              icon line and the $/day on the label line. */}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpenId(open ? null : s.id)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              minWidth: 0,
              flex: 1,
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: "inherit",
              font: "inherit",
              textAlign: "inherit",
            }}
          >
            <RegionGlyph region={s.sourceRegion} cond={condByRegion.get(s.sourceRegion) ?? null} />
            <div style={{ textAlign: "center" }}>
              <div style={{ height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CDIcon name="arrowRight" size={16} strokeWidth={2} style={{ color: "var(--accent)" }} />
              </div>
              <div
                className="cd-caption tabular-nums"
                style={{ marginTop: 2, whiteSpace: "nowrap", fontWeight: 600 }}
              >
                {money(s.amountCents)}/day
              </div>
              {s.status !== "applied" ? (
                <div className="cd-caption" style={{ whiteSpace: "nowrap" }}>
                  thru {shortDate(s.expiresOn)}
                </div>
              ) : null}
            </div>
            <RegionGlyph region={s.destRegion} cond={condByRegion.get(s.destRegion) ?? null} />
            <CDIcon
              name="chevronRight"
              size={14}
              style={{
                color: "var(--text-3)",
                marginTop: 4,
                flexShrink: 0,
                transition: "transform 0.18s ease",
                transform: open ? "rotate(90deg)" : "none",
              }}
            />
          </button>
          {s.status === "applied" ? (
            <Pill tone="success" icon="check">
              Ran{s.executedAt ? ` ${shortDate(s.executedAt.slice(0, 10))}` : ""}
            </Pill>
          ) : s.status === "armed" ? (
            <>
              <Pill tone="accent" icon="bolt">
                {auto ? "Auto" : "Scheduled"}
              </Pill>
              <Btn small onClick={() => onIntent(s.id, "dismiss")}>
                Cancel
              </Btn>
            </>
          ) : (
            <>
              <Btn small kind="primary" onClick={() => onIntent(s.id, "arm")}>
                Schedule
              </Btn>
              <Btn small onClick={() => onIntent(s.id, "apply")}>
                Approve
              </Btn>
              <Btn small onClick={() => onIntent(s.id, "dismiss")}>
                Reject
              </Btn>
            </>
          )}
        </div>
        {open ? (
          <div style={{ marginTop: 10 }}>
            <div className="cd-row-title">{why.headline}</div>
            {why.factors.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {why.factors.map((f) => (
                  <Pill key={f.label} icon={f.icon}>
                    {f.label}
                  </Pill>
                ))}
              </div>
            ) : null}
            {why.note ? (
              <div className="cd-caption" style={{ marginTop: 8, maxWidth: "60ch" }}>
                {why.note}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <Card>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <CDIcon name="cloudSun" size={26} strokeWidth={1.6} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div className="cd-row-title">Weather-smart ads</div>
            <div className="cd-caption">
              Rain and cold push shoppers online — your ad budget follows them.
            </div>
          </div>
        </div>
      </Card>

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
          <div className="cd-row-title">Forecast</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {forecast?.homeRegion ? (
              <Pill tone="accent" icon="mapPin">
                {REGION_LABEL[forecast.homeRegion] ?? forecast.homeRegion}
              </Pill>
            ) : null}
            {days.length > 0 ? (
              <Segmented
                small
                value={String(dayIdx ?? 0)}
                onChange={setDayKey}
                options={days.map((d, i) => ({
                  value: String(i),
                  label: i === 0 ? "Today" : shortDate(d.date),
                }))}
              />
            ) : null}
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
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 12,
              padding: "12px 16px 16px",
            }}
          >
            {forecast.regions.map((r) => {
              // A selected day narrows the icon/temp/precip to that day; the
              // demand meter stays window-level (scores are 3-day quantities).
              const disp = dayIdx !== null ? r.days?.[dayIdx] ?? r : r;
              const cond = conditionFor(disp);
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
                    {fahrenheit(disp.avgTempC)}°
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
                  {/* Slot is always rendered so every card's demand meter sits
                      on the same line regardless of precipitation. */}
                  <div className="cd-caption tabular-nums" style={{ marginTop: 4, minHeight: 16 }}>
                    {cond !== "clear" ? (
                      <>
                        <CDIcon name={cond === "snow" ? "snowflake" : "rain"} size={11} />{" "}
                        {cond === "snow"
                          ? `${Math.round(disp.snowCm)}cm`
                          : `${Math.round(disp.precipMm)}mm`}
                      </>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
                    <Pill tone={demandLabel(r.score).tone}>{demandLabel(r.score).label}</Pill>
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
          <Segmented
            small
            value={mode}
            onChange={(v) => onMode(v as WeatherMode)}
            options={[
              { value: "manual", label: "Manual" },
              { value: "auto", label: "Auto" },
            ]}
          />
        </CardHead>
        {active.length === 0 && executed.length === 0 ? (
          <div className="cd-caption" style={{ padding: "16px 20px" }}>
            {mode === "auto"
              ? "Moves run on their own — what ran shows up here with when and why."
              : "No weather moves predicted — needs two active campaigns each targeting a single US region."}
          </div>
        ) : (
          <>
            {sortMoves(active, condByRegion).map(renderMove)}
            {executed.length > 0 ? (
              <>
                <div
                  className="cd-caption"
                  style={{
                    padding: "12px 20px 2px",
                    fontWeight: 650,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontSize: 10.5,
                  }}
                >
                  Executed
                </div>
                {executed.map(renderMove)}
              </>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
