// Pure outcome-tally math for Calderyn Calibration (design 2026-06-26 §2.1/§4).
// NO I/O, NO .server import: shared by the recompute job, the live gate, and any
// UI that wants to show "made money N of M times". A "measured outcome" is the
// sign of a closed-window reward_signal persisted on action_audit by the engine.

export interface OutcomeRow {
  /** Signed reward_signal: >0 helped, <0 hurt (undo = -100), 0 = no opinion. */
  signal: number;
  /** reward_window_closed_at ISO string; used only to pick the most recent sign. */
  closedAt: string;
}

export interface OutcomeTally {
  /** max(0, #positive − #negative). The bar in graduationVerdict compares this. */
  netPositive: number;
  /** Sign of the most recently closed outcome. Drives outcome demotion. */
  lastSign: -1 | 0 | 1;
}

const signOf = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0);

export function tallyOutcomes(rows: OutcomeRow[]): OutcomeTally {
  let pos = 0;
  let neg = 0;
  let latestAt = "";
  let lastSign: -1 | 0 | 1 = 0;
  for (const r of rows) {
    const s = signOf(r.signal);
    if (s > 0) pos++;
    else if (s < 0) neg++;
    if (r.closedAt > latestAt) {
      latestAt = r.closedAt;
      lastSign = s;
    }
  }
  return { netPositive: Math.max(0, pos - neg), lastSign };
}
