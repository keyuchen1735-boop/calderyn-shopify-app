// Pure "leveling" bands for Calderyn Calibration — the single source of truth
// for the band name, the 1-of-4 level, and the milestone track rendered on BOTH
// surfaces (embedded app + dashboard). No I/O, no .server imports, no React, so
// either surface can import it directly.
//
// This supersedes the old per-surface threshold labels (embedded used 70/50,
// dashboard used 75/45) so the two can never drift apart again.

export interface CalibrationMilestone {
  /** Display label, e.g. "Trusted". */
  label: string;
  /** Calibration % at which this milestone is reached; also its position (0..100) on the track. */
  at: number;
  /** True once calibration % has reached this milestone. */
  reached: boolean;
}

export interface CalibrationBandInfo {
  /** Current level, 1..4. */
  level: number;
  /** Total number of levels (always 4). */
  levels: number;
  /** Current band display name, e.g. "Getting started". */
  name: string;
  /** One-line plain-language description of the current band. */
  copy: string;
  /** The four milestones in order, with reached flags + track positions. */
  milestones: CalibrationMilestone[];
  /** Fill width of the milestone track, 0..100 (equals the calibration %). */
  trackWidthPct: number;
}

interface BandDef {
  at: number;
  name: string;
  copy: string;
}

/**
 * The four levels, ordered by calibration %. `at` is both the reach threshold
 * and the milestone's position on the 0..100 track. "Hands-off" sits at 100
 * because full autonomy is the north star: the merchant trains the agent all the
 * way up. Per-pair graduation (autopilot for a single fix) happens well before
 * the overall number gets there.
 */
export const CALIBRATION_BANDS: readonly BandDef[] = [
  {
    at: 0,
    name: "Getting started",
    copy: "Calderyn is learning how you run your shop. Approve or reject its calls to teach it your style.",
  },
  {
    at: 34,
    name: "Learning",
    copy: "Calderyn is picking up your style. Keep approving the good calls and it earns more trust.",
  },
  {
    at: 67,
    name: "Trusted",
    copy: "Calderyn handles a lot on its own. A few more good calls and it can run even more without asking.",
  },
  {
    at: 100,
    name: "Hands-off",
    copy: "Calderyn runs your shop the way you taught it. Step in or adjust the limits any time.",
  },
] as const;

const clampPct = (n: number): number => (n < 0 ? 0 : n > 100 ? 100 : Math.round(n));

/**
 * Resolve a calibration % into its band + milestone track. A null/undefined pct
 * (fresh shop, not yet computed) is treated as 0 → "Getting started".
 */
export function calibrationBand(pct: number | null | undefined): CalibrationBandInfo {
  const p = pct == null || !Number.isFinite(pct) ? 0 : clampPct(pct);

  // Highest band whose threshold has been reached (index 0 is always reached).
  let idx = 0;
  for (let i = 0; i < CALIBRATION_BANDS.length; i++) {
    if (p >= CALIBRATION_BANDS[i].at) idx = i;
  }
  const band = CALIBRATION_BANDS[idx];

  const milestones: CalibrationMilestone[] = CALIBRATION_BANDS.map((b) => ({
    label: b.name,
    at: b.at,
    reached: p >= b.at,
  }));

  return {
    level: idx + 1,
    levels: CALIBRATION_BANDS.length,
    name: band.name,
    copy: band.copy,
    milestones,
    trackWidthPct: p,
  };
}
