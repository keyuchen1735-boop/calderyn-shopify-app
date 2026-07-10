// Pure purchase-order formatting helpers. Client-safe: imported by both the
// server libs (draft.server.ts / purchase-orders.server.ts) and the dashboard
// UI (PoModal's ETA prefill), so the two sides share one definition.

/** `PO-YYYYMMDD-<REF>` — the one PO-number shape, shared by the Autopilot
 *  draft snapshots and real purchase orders. */
export function formatPoNumber(ref: string, now: Date): string {
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `PO-${ymd}-${ref}`;
}

/** Date-only ETA `today + leadTimeDays` (UTC day, matching `expected_at date`). */
export function defaultEta(leadTimeDays: number, now: Date = new Date()): string {
  return new Date(now.getTime() + leadTimeDays * 86_400_000).toISOString().slice(0, 10);
}
