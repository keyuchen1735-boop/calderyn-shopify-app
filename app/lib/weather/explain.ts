// Plain-English justification for a weather budget move. Behavior marking
// follows the weather–online-shopping literature: gloomy conditions move
// browsing indoors and raise demand attention, while sunshine lifts mood and
// lowers perceived purchase risk, so clear-day shoppers follow through
// (Li, Chen, Peng, Huang & Sha 2024, J. Retailing & Consumer Services 78).
import { conditionFor } from "./forecast-view";

interface RegionWeather {
  avgTempC: number;
  precipMm: number;
  snowCm: number;
  /** Demand favorability in [0,1]. */
  score: number;
}

export interface MoveExplanation {
  /** One short plain-English line naming the driver. */
  headline: string;
  /** Icon-led chips carrying the numbers behind the call. */
  factors: Array<{ icon: string; label: string }>;
}

export function explainMove(input: {
  sourceName: string;
  destName: string;
  source: RegionWeather | null;
  dest: RegionWeather | null;
}): MoveExplanation {
  const { sourceName, destName, source, dest } = input;
  const factors: MoveExplanation["factors"] = [];

  const destCond = dest ? conditionFor(dest) : null;
  let headline = `Weather favors demand in ${destName}`;
  if (dest && destCond === "snow") {
    headline = `Snow keeps ${destName} shoppers home — buying online`;
    factors.push({ icon: "snowflake", label: `${Math.round(dest.snowCm)}cm · ${destName}` });
  } else if (dest && (destCond === "rain" || destCond === "showers")) {
    headline = `Rain pushes ${destName} shopping online`;
    factors.push({ icon: "rain", label: `${Math.round(dest.precipMm)}mm · ${destName}` });
  } else if (dest && dest.avgTempC <= 5) {
    headline = `Cold snap keeps ${destName} shoppers indoors`;
    factors.push({ icon: "snowflake", label: `${Math.round((dest.avgTempC * 9) / 5 + 32)}° · ${destName}` });
  }

  // Sunshine on the source side is part of the case: good-mood shoppers are
  // out, and the ones online follow through without extra ad pressure.
  if (source && conditionFor(source) === "clear") {
    factors.push({ icon: "sun", label: `clear · ${sourceName}` });
  }

  if (source && dest) {
    factors.push({
      icon: "trendUp",
      label: `demand ${Math.round(dest.score * 100)} vs ${Math.round(source.score * 100)}`,
    });
  }

  return { headline, factors };
}
