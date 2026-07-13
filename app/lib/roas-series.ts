// Pure, client-safe day-aggregation for ad_spend_fact rows. Shared by
// calderyn.server.ts's dailyRoasSeries (all campaigns) and campaignRoasSeries
// (single campaign) so both build the exact same DailyRoasRow shape.
import type { DailyRoasRow } from "./types";

export interface SpendFactRow {
  day: string;
  spend_cents: number;
  revenue_attrib_cents: number;
}

export function aggregateSpendRows(rows: SpendFactRow[]): DailyRoasRow[] {
  const byDay = new Map<string, DailyRoasRow>();
  for (const r of rows) {
    const cur = byDay.get(r.day) ?? { day: r.day, spend_cents: 0, revenue_cents: 0 };
    cur.spend_cents += r.spend_cents ?? 0;
    cur.revenue_cents += r.revenue_attrib_cents ?? 0;
    byDay.set(r.day, cur);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
