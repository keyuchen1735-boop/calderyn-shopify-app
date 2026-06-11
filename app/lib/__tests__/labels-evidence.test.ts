import { describe, it, expect } from "vitest";
import { EVIDENCE_LABELS, formatEvidenceKey, getEvidenceFormatter } from "../labels";

// Every evidence key the live detectors emit (sampled from prod alert_context
// on 2026-06-10). Each must resolve to a curated plain-language label — never
// the title-cased fallback.
const LIVE_EVIDENCE_KEYS = [
  "ad_spend_7d_usd", "ad_tax_ratio", "revenue_7d_usd", "threshold",
  "campaign_name", "cogs_7d_usd", "gross_profit_7d_usd", "spend_7d_usd",
  "current_unit_cost_usd", "drift_pct", "prior_unit_cost_usd", "title", "units_30d",
  "baseline_unit_margin_usd", "baseline_units_30d", "current_unit_margin_usd",
  "current_units_7d", "drop_pct", "cac_per_unit_usd", "gross_unit_margin_usd",
  "net_per_unit_usd", "units_14d", "daily_demand", "lead_time_days",
  "regional_stock_units", "shortfall_units", "region", "regional_spend_7d_usd",
  "regional_stock", "stock_elsewhere", "gap_days", "unit_margin_usd",
  "return_30d_usd", "return_rate", "revenue_30d_usd", "units_sold_30d",
  "demand_share_pct", "location_region", "stock_concentration_pct", "stock_units",
  "stock", "sku_title", "days_of_cover", "spend_wow_ratio",
  "spend_prev_7d_usd", "spend_this_7d_usd", "velocity_units_per_day",
  "daily_velocity_units",
];

describe("evidence labels", () => {
  it("has a curated label for every key the live detectors emit", () => {
    const missing = LIVE_EVIDENCE_KEYS.filter((k) => !EVIDENCE_LABELS[k]);
    expect(missing).toEqual([]);
  });

  it("never leaks lowercase acronyms through the fallback", () => {
    // Unknown keys (not in the map) must uppercase CAC/USD/etc.
    expect(formatEvidenceKey("cac_blended_usd")).toBe("CAC blended USD");
    expect(formatEvidenceKey("roas_target")).toBe("ROAS target");
    expect(formatEvidenceKey("sku_count")).toBe("SKU count");
    expect(formatEvidenceKey("some_new_metric")).toBe("Some new metric");
  });

  it("prefers the curated label over the fallback", () => {
    expect(formatEvidenceKey("cac_per_unit_usd")).toBe("Ad cost per sale");
    expect(formatEvidenceKey("days_of_cover")).toBe("Days until sold out");
  });
});

describe("evidence value formatters", () => {
  it("formats money keys as currency", () => {
    expect(getEvidenceFormatter("unit_margin_usd")!("-22.43")).toBe("-$22");
    expect(getEvidenceFormatter("spend_7d_usd")!("4668.85")).toBe("$4,669");
  });

  it("formats rate/ratio/pct keys as percentages", () => {
    expect(getEvidenceFormatter("ad_tax_ratio")!("0.493")).toBe("49.3%");
    expect(getEvidenceFormatter("return_rate")!("0.265")).toBe("26.5%");
    expect(getEvidenceFormatter("stock_concentration_pct")!("93.4")).toBe("93.4%");
  });

  it("formats unit and day keys with suffixes", () => {
    expect(getEvidenceFormatter("shortfall_units")!("41.1")).toBe("41.1 units");
    expect(getEvidenceFormatter("lead_time_days")!(14)).toBe("14 days");
  });

  it("returns undefined for keys with no formatter so plain values pass through", () => {
    expect(getEvidenceFormatter("campaign_name")).toBeUndefined();
    expect(getEvidenceFormatter("region")).toBeUndefined();
  });
});
