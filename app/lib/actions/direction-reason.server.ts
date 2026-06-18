// Plain-English "why" for a campaign's recommended direction. The direction is
// ALREADY decided by recommendDirection — this layer only phrases it. Claude does
// the phrasing when available (directionReason); directionTemplate is the
// deterministic fallback, in the no-jargon house style of scale-reason.ts.

import type { Direction } from "./direction.server";

export interface ReasonFacts {
  roas: number | null;
  breakEvenRoas: number | null;
  dataSufficient: boolean;
  status: "active" | "paused";
}

function x(n: number | null): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(1)}×` : "—";
}

export function directionTemplate(direction: Direction, f: ReasonFacts): string {
  if (!f.dataSufficient) return "Not enough recent spend or margin data to make a call yet.";
  if (f.status === "paused") return "This campaign is paused — no change recommended right now.";
  const ret = x(f.roas);
  const be = x(f.breakEvenRoas);
  switch (direction) {
    case "scale_up":
      return `Winning campaign — earning ${ret} on ad spend, above the ${be} it needs to break even. Give the winner more budget.`;
    case "scale_down":
      return `Underperforming — ${ret} on ad spend is below the ${be} it needs to break even. Trim the budget to cut the bleed.`;
    case "pause":
      return `Losing money — ${ret} is well under the ${be} break-even. Pause it before it spends more.`;
    case "keep":
    default:
      return `Holding steady — ${ret} on ad spend is around the ${be} break-even. Keep the budget and keep watching.`;
  }
}
