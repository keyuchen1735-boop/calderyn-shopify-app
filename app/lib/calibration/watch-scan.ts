// Pure (browser-safe, no .server imports) builder for the Live Engine hero's
// per-rectangle scan tickers. Turns real SKU + campaign data into bounded
// {label, value} lists. Deterministic — no Date.now()/Math.random() — so it is
// unit-testable and stable across renders. `ret` stays empty: there is no real
// customer/cohort source yet, so the hero shows a dimmed line instead of
// fabricating names.
import type { LiveEnginePageData, ScanItem } from "./live-engine-types";

export type WatchScan = LiveEnginePageData["watchScan"];

export interface ScanSku {
  title: string;
  onHand: number;
  velocity?: number | null;
  shipPnlCents?: number | null;
}
export interface ScanCampaign {
  name: string;
  roas7d?: number | null;
  status?: string;
}

const CAP = 8;

/** Whole-dollar per-unit profit, signed, e.g. "+$6/u" / "-$2/u". Sub-$1 P&L
 *  rounds to a meaningless signed zero, so it shows no figure (name only). */
function profitPerUnit(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / 100);
  if (dollars === 0) return "";
  return `${cents >= 0 ? "+" : "-"}$${dollars}/u`;
}

function dedupeTake<T>(rows: T[], label: (r: T) => string, value: (r: T) => string): ScanItem[] {
  const seen = new Set<string>();
  const out: ScanItem[] = [];
  for (const r of rows) {
    const l = label(r).trim();
    if (!l) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: l, value: value(r) });
    if (out.length >= CAP) break;
  }
  return out;
}

export function buildWatchScan(skus: ScanSku[], campaigns: ScanCampaign[]): WatchScan {
  const inv = dedupeTake(
    skus,
    (s) => s.title,
    (s) => `${Math.max(0, Math.round(s.onHand))} left`,
  );

  // Pricing scans the same products, ordered by velocity so its lead differs
  // from Inventory; figure is per-unit profit (no retail price exists in the
  // data), blank when there's no P&L for that SKU.
  const byVelocity = [...skus].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  let price = dedupeTake(
    byVelocity,
    (s) => s.title,
    (s) => (s.shipPnlCents == null ? "" : profitPerUnit(s.shipPnlCents)),
  );
  // Guarantee a visual difference from inv when velocity is flat/equal.
  if (price.length > 1 && price.every((it, i) => it.label === inv[i]?.label)) {
    const k = Math.floor(price.length / 2) || 1;
    price = [...price.slice(k), ...price.slice(0, k)];
  }

  // Active campaigns first; figure is 7-day ROAS, blank when ungraded (0).
  const activeFirst = [...campaigns].sort(
    (a, b) => (a.status === "paused" ? 1 : 0) - (b.status === "paused" ? 1 : 0),
  );
  const ads = dedupeTake(
    activeFirst,
    (c) => c.name,
    (c) => (c.roas7d && c.roas7d > 0 ? `${c.roas7d.toFixed(1)}×` : ""),
  );

  return { inv, price, ads, ret: [] };
}
