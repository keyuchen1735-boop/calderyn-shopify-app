// Deterministic 4-way campaign direction. Pure: no I/O, no model. The thresholds
// mirror engine/calderyn_engine/grade.py (GRADE_OK_FACTOR 0.95, GRADE_WIN_FACTOR 1.2)
// so a recommendation never contradicts the displayed grade; PAUSE_FLOOR (0.7) is the
// one new tunable — below it a campaign is bleeding hard enough to pause outright.

export type Direction = "scale_up" | "keep" | "scale_down" | "pause";
export type DirectionActionKind =
  | "pause_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget";

const GRADE_OK_FACTOR = 0.95;
const GRADE_WIN_FACTOR = 1.2;
const PAUSE_FLOOR = 0.7;

export interface DirectionInput {
  roas: number | null;
  breakEvenRoas: number | null;
  status: "active" | "paused";
  /** Open campaign_scaling_opportunity alert for this campaign. */
  hasScalingHeadroom: boolean;
  /** Open campaign_below_breakeven / negative_unit_economics alert for this campaign. */
  pauseAlertActive: boolean;
}

export interface DirectionResult {
  direction: Direction;
  actionKind: DirectionActionKind | null;
  dataSufficient: boolean;
}

const KEEP: DirectionResult = { direction: "keep", actionKind: null, dataSufficient: true };

export function recommendDirection(input: DirectionInput): DirectionResult {
  const { roas, breakEvenRoas } = input;
  // Fail visibly (rule 12): no fabricated direction without real numbers.
  if (roas == null || breakEvenRoas == null || breakEvenRoas <= 0 || !Number.isFinite(roas)) {
    return { ...KEEP, dataSufficient: false };
  }
  if (input.status === "paused") return KEEP;

  if (input.pauseAlertActive || roas < PAUSE_FLOOR * breakEvenRoas) {
    return { direction: "pause", actionKind: "pause_campaign", dataSufficient: true };
  }
  if (roas < GRADE_OK_FACTOR * breakEvenRoas) {
    return { direction: "scale_down", actionKind: "reduce_campaign_budget", dataSufficient: true };
  }
  if (roas < GRADE_WIN_FACTOR * breakEvenRoas) {
    return KEEP;
  }
  // Winning.
  if (input.hasScalingHeadroom) {
    return { direction: "scale_up", actionKind: "increase_campaign_budget", dataSufficient: true };
  }
  return KEEP;
}
