// Resolve a campaign's DISPLAY grade from its grade-fact row. "nodata" is a
// distinct state from "poor": the grader had spend but ZERO attributed revenue
// for the window, so the economics are unknown — an attribution gap, not a
// confident "below break-even" judgment. The engine still emits
// winning/okay/poor; this is the single source both surfaces use so neither
// mislabels an attribution gap as poor performance (P1-6).

export type DisplayGrade = "winning" | "okay" | "poor" | "nodata";

export interface GradeRowLike {
  grade?: string;
  roas?: number;
  break_even_roas?: number;
  spend_cents?: number;
  revenue_cents?: number;
}

const VALID: readonly DisplayGrade[] = ["winning", "okay", "poor", "nodata"];

/**
 * `fallbackRoas` (e.g. the campaign's own roas_7d) is used only when the grade
 * row carries no usable roas of its own.
 */
export function gradeFromRow(row: GradeRowLike, fallbackRoas?: number): DisplayGrade {
  // Spend but no attributed revenue → unknown economics. Never "poor": a $0
  // revenue figure is far more often an attribution lag than a real wipeout, and
  // the merchant can't act on a confident "poor" built from missing data.
  if ((row.spend_cents ?? 0) > 0 && (row.revenue_cents ?? 0) === 0) return "nodata";

  if (row.grade && (VALID as readonly string[]).includes(row.grade)) return row.grade as DisplayGrade;

  const roas = typeof row.roas === "number" && row.roas > 0 ? row.roas : fallbackRoas;
  const be = row.break_even_roas;
  if (typeof roas === "number" && typeof be === "number" && be > 0) {
    if (roas >= be * 1.2) return "winning";
    if (roas >= be) return "okay";
    return "poor";
  }
  return "okay";
}

export function gradeLabel(grade: DisplayGrade): string {
  switch (grade) {
    case "winning":
      return "Winning";
    case "okay":
      return "Okay";
    case "poor":
      return "Poor";
    default:
      return "No data";
  }
}
