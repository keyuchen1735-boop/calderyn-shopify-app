// Home Autopilot gauge view state. The gauge sweeps from 0 on every target
// change (TickGauge sweepFrom0), so it must not receive a calibration pct
// until boot has decided whether the store is dormant — otherwise a stale
// row sweeps the dial up and dormancy immediately drops it back to 0.
export function homeGaugeView(
  booted: boolean,
  dormant: boolean,
  pct: number | null,
): { pct: number; pending: boolean } {
  if (!booted) return { pct: 0, pending: true };
  if (dormant) return { pct: 0, pending: false };
  return { pct: pct ?? 0, pending: false };
}
