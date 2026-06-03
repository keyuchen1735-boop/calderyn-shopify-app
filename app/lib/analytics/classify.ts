import type { CampaignGrade } from "~/lib/types";

/** A campaign is "winning" once ROAS clears break-even by this factor. */
export const GRADE_WIN_FACTOR = 1.2;
/** Below this fraction of break-even it is "poor"; between, "okay". */
export const GRADE_OK_FACTOR = 0.95;

export function gradeCampaign(roas: number, breakEvenRoas: number): CampaignGrade {
  if (breakEvenRoas <= 0) return roas > 0 ? "winning" : "poor";
  if (roas >= GRADE_WIN_FACTOR * breakEvenRoas) return "winning";
  if (roas >= GRADE_OK_FACTOR * breakEvenRoas) return "okay";
  return "poor";
}
