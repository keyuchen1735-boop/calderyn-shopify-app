// Suggested reorder quantity from a reorder_timing alert's evidence. Pure.
// Cover the supplier lead time plus a safety buffer, net of stock already on hand
// (expressed as days_of_cover). Falls back to lead-time-only cover when the
// current cover is unknown; returns null when velocity itself is unusable
// (caller must then route to the detail page rather than guess - rule 12).

export const COVER_BUFFER_DAYS = 14;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

export function suggestedReorderQty(evidence: Record<string, unknown>): number | null {
  const velocity = num(evidence.daily_velocity_units);
  if (!(velocity > 0)) return null;
  const lead = num(evidence.lead_time_days);
  const leadDays = lead > 0 ? lead : 0;
  const cover = num(evidence.days_of_cover);
  const coverDays = Number.isFinite(cover) && cover > 0 ? cover : 0;
  const targetDays = leadDays + COVER_BUFFER_DAYS - coverDays;
  const qty = Math.ceil(velocity * targetDays);
  return Math.max(1, qty);
}
