import type { MarginConfidence } from "~/lib/types";

/** Fallback gross margin when costs are unknown/low-coverage. */
export const DEFAULT_MARGIN = 0.4;
/** Minimum fraction of revenue with a known unit cost to trust the computed margin. */
export const COVERAGE_THRESHOLD = 0.7;

export interface MarginLine {
  price_cents: number;
  quantity: number;
  unit_cost_cents: number | null;
}

export interface BreakEvenInput {
  lines: MarginLine[];
  override: number | null; // gross-margin fraction 0..1, or null
  defaultMargin: number;
  coverageThreshold: number;
}

export interface BreakEvenResult {
  margin: number; // 0..1
  breakEvenRoas: number;
  confidence: MarginConfidence;
  coverage: number; // 0..1
}

function fromMargin(margin: number, confidence: MarginConfidence, coverage: number): BreakEvenResult {
  return { margin, breakEvenRoas: 1 / margin, confidence, coverage };
}

export function computeBreakEven(input: BreakEvenInput): BreakEvenResult {
  if (input.override != null && input.override > 0 && input.override < 1) {
    // coverage still reported for display, but the override wins.
    return fromMargin(input.override, "override", coverageOf(input.lines));
  }

  const coverage = coverageOf(input.lines);
  const known = input.lines.filter((l) => l.unit_cost_cents != null);
  const revenueKnown = known.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const cogsKnown = known.reduce((s, l) => s + (l.unit_cost_cents as number) * l.quantity, 0);

  if (revenueKnown > 0 && coverage >= input.coverageThreshold) {
    const margin = 1 - cogsKnown / revenueKnown;
    if (margin > 0) return fromMargin(margin, "ok", coverage);
  }
  return fromMargin(input.defaultMargin, "default", coverage);
}

function coverageOf(lines: MarginLine[]): number {
  const all = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  if (all <= 0) return 0;
  const known = lines
    .filter((l) => l.unit_cost_cents != null)
    .reduce((s, l) => s + l.price_cents * l.quantity, 0);
  return known / all;
}
