// Evidence label/value formatting delegates to app/lib/labels.ts (the single
// source of truth shared with the embedded app) so both surfaces show identical
// plain-language labels instead of raw keys like "cac_per_unit_usd".
import {
  formatEvidenceKey,
  getEvidenceFormatter,
  INTERNAL_EVIDENCE_ID_KEYS,
} from "~/lib/labels";

export function money(cents: number): string {
  // Guard non-finite input (null/undefined/NaN coerced from partial live rows)
  // so a missing value renders "$0" instead of "$NaN". moneyK delegates here on
  // NaN (its `>= 1000` branch is false), so this covers both formatters.
  if (!Number.isFinite(cents)) return "$0";
  return (
    (cents < 0 ? "-$" : "$") +
    Math.abs(cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * Compact relative-time for user-facing display, e.g. "just now", "5m ago",
 * "3h ago", "2d ago", or "Jun 12, 2026" for anything older than a week. Guards
 * non-parseable input (returns "—") so a missing/partial timestamp renders an
 * em dash rather than a raw ISO string or a dangling " · " separator. Keeps the
 * year on absolute dates to match the embedded app's audit-log contract (an
 * audit log can straddle a year boundary, so "Jun 12" alone is ambiguous).
 */
export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Full absolute timestamp for hover/title text, e.g. "Jun 12, 2026, 2:03 PM".
 * Pairs with timeAgo so a compact relative time still exposes the exact moment
 * on hover — required on the audit log where precise execution time matters.
 * Returns "" on non-parseable input so callers can omit the title attribute.
 */
export function absTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2026-07-02" → "Jul 2" (UTC — date-only strings are UTC days). */
export function shortDate(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function moneyK(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return (d < 0 ? "-$" : "$") + (Math.abs(d) / 1000).toFixed(1) + "k";
  return money(cents);
}

/**
 * Blended ROAS label (revenue ÷ spend) for the chart tooltip. Returns "—" when
 * spend is zero/non-finite so a zero-spend day (organic sales, pre-launch)
 * renders an em dash instead of "Infinity×" / "NaN×".
 */
export function blendedRoas(revenueCents: number, spendCents: number): string {
  if (!Number.isFinite(revenueCents) || !Number.isFinite(spendCents) || spendCents <= 0) {
    return "—";
  }
  return `${(revenueCents / spendCents).toFixed(1)}×`;
}

export const ACTION_LABELS: Record<string, string> = {
  pause_campaign: "Pause campaign",
  reduce_campaign_budget: "Reduce budget",
  increase_campaign_budget: "Scale campaign budget",
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  snooze_alert: "Snooze",
  // remediation move kinds (Phase 1 advisory)
  discontinue: "Stop reordering",
  cut_ads: "Cut ad spend",
  reallocate_to_winner: "Reallocate to a winner",
  fix_returns: "Fix returns",
  review_pricing: "Review pricing",
};

// Detector names come from the single source (app/lib/labels) so the dashboard
// shows the same PLAIN labels as the embedded admin, and no id ever leaks as
// snake_case (P2-10). This was a partial local copy of the analyst terms that
// was missing newer detectors (campaign_scaling_opportunity, free_shipping_
// leakage), which then rendered raw on the dashboard.
export { detectorLabel, detectorTerm, alertDetectorLabel } from "~/lib/labels";

export const GROUP_LABELS: Record<string, string> = {
  attention: "Attention",
  message: "Message",
  offer_conversion: "Offer & Conversion",
  trust_safety: "Trust & Safety",
};

export interface SevStyle {
  fg: string;
  label: string;
}

export const SEV_STYLE: Record<string, SevStyle> = {
  critical: { fg: "var(--red)", label: "Critical" },
  high: { fg: "var(--orange)", label: "High" },
  medium: { fg: "var(--yellow-fg)", label: "Medium" },
  low: { fg: "var(--text-2)", label: "Low" },
};

const INTERNAL_EVIDENCE_KEYS = new Set<string>(INTERNAL_EVIDENCE_ID_KEYS);

/** Plain-language label for an evidence key ("cac_per_unit_usd" → "Ad cost per sale"). */
export function evidenceLabel(key: string): string {
  return formatEvidenceKey(key);
}

/** Display string for an evidence value ("139.47" → "$139", "0.49" → "49%"). */
export function evidenceValue(key: string, v: string): string {
  const fmt = getEvidenceFormatter(key);
  return fmt ? fmt(v) : v;
}

/** Raw platform identifiers (GIDs/uuids) are plumbing — never merchant-facing. */
export function isInternalEvidenceKey(key: string): boolean {
  return INTERNAL_EVIDENCE_KEYS.has(key);
}
