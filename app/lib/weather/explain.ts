// Plain-English justification for a weather budget move. Behavior marking
// follows the weather–retail evidence: rain, snow and cold move shopping
// online (more browsing, bigger baskets), while sunshine puts shoppers
// outdoors and in stores (Li et al. 2024, J. Retailing & Consumer Services;
// Steinker, Hoberg & Thonemann 2017, Management Science).
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
  /** Optional second line about the source region. */
  note?: string;
}

const fahrenheit = (c: number): number => Math.round((c * 9) / 5 + 32);

export function explainMove(input: {
  sourceName: string;
  destName: string;
  source: RegionWeather | null;
  dest: RegionWeather | null;
}): MoveExplanation {
  const { sourceName, destName, source, dest } = input;
  const factors: MoveExplanation["factors"] = [];
  let note: string | undefined;

  const destCond = dest ? conditionFor(dest) : null;
  let headline = `Weather sends more ${destName} shoppers online`;
  if (dest && destCond === "snow") {
    headline = `Snow in ${destName} — more people shop online`;
    factors.push({ icon: "snowflake", label: `${Math.round(dest.snowCm)}cm snow · ${destName}` });
  } else if (dest && (destCond === "rain" || destCond === "showers")) {
    headline = `Rain in ${destName} — more people shop online`;
    factors.push({ icon: "rain", label: `${Math.round(dest.precipMm)}mm rain · ${destName}` });
  } else if (dest && dest.avgTempC <= 5) {
    headline = `Cold in ${destName} — more people shop online`;
    factors.push({ icon: "snowflake", label: `${fahrenheit(dest.avgTempC)}° · ${destName}` });
  }

  if (dest) factors.push({ icon: "user", label: `more buyers · ${destName}` });

  // Sunshine on the source side is the other half of the call: shoppers there
  // are out and about, not browsing.
  if (source && conditionFor(source) === "clear") {
    factors.push({ icon: "sun", label: `sunny · ${sourceName}` });
    note = `Sunny in ${sourceName} — people are out, not browsing.`;
  }

  return { headline, factors, note };
}
