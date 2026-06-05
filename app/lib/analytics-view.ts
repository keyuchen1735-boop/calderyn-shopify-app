// Pure view-model helpers for the Analytics route. No DB, no React.
import type { MarginPoint } from "../components/MarginChart";
import type { DailyRoasRow } from "./types";

export type { DailyRoasRow } from "./types";

/** Polaris Badge tone for a campaign grade. */
export type GradeTone = "success" | "warning" | "critical" | undefined;

/** Daily ROAS = revenue/spend; spend 0 -> 0 (no divide-by-zero). */
export function toRoasSeries(rows: DailyRoasRow[]): MarginPoint[] {
  return rows.map((r) => ({
    date: r.day,
    margin_pct: r.spend_cents > 0 ? r.revenue_cents / r.spend_cents : 0,
  }));
}

export function formatRoas(v: number): string {
  return `${v.toFixed(2)}x`;
}

/** Map an engine grade to a Polaris Badge tone. */
export function gradeTone(grade: string): GradeTone {
  if (grade === "winning") return "success";
  if (grade === "okay") return "warning";
  if (grade === "poor") return "critical";
  return undefined;
}
