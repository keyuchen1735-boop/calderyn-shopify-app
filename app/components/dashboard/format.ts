// Calderyn DashV2 — pure formatters + label maps.
// Ported verbatim from the prototype's data.js (money/moneyK) and ui.jsx (SEV_STYLE).
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

export function moneyK(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return (d < 0 ? "-$" : "$") + (Math.abs(d) / 1000).toFixed(1) + "k";
  return money(cents);
}

export const ACTION_LABELS: Record<string, string> = {
  pause_campaign: "Pause campaign",
  reduce_campaign_budget: "Reduce budget",
  exclude_geo: "Exclude geography",
  reallocate_inventory: "Reallocate inventory",
  create_po_draft: "Create PO draft",
  snooze_alert: "Snooze",
};

export const DETECTOR_TERMS: Record<string, string> = {
  sku_stockout_vs_spend: "SKU stockout vs spend",
  campaign_below_breakeven: "Campaign below breakeven",
  regional_spend_starved_stock: "Regional spend on starved stock",
  margin_erosion: "Margin erosion",
  scaling_sku_fulfillment_risk: "Scaling SKU fulfillment risk",
  return_rate_hidden_loss: "Return-rate hidden loss",
  reorder_timing: "Reorder timing",
  wrong_location_concentration: "Wrong location concentration",
  cogs_drift: "COGS drift",
  ad_tax_overload: "Ad-tax overload",
  negative_unit_economics: "Negative unit economics",
  regional_shortage_risk: "Regional shortage risk",
};

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
