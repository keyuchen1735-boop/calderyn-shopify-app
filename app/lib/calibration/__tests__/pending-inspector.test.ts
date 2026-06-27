import { describe, it, expect } from "vitest";
import {
  pendingEvidenceStats,
  pendingApproveText,
  PENDING_DENY_TEXT,
  PENDING_TRUST_LINE,
} from "../pending-inspector";

describe("pendingEvidenceStats", () => {
  it("humanizes labels and formats values via the shared evidence machinery", () => {
    expect(
      pendingEvidenceStats({ stock_concentration_pct: "92.7", demand_share_pct: "11.4", location_region: "us-west" }),
    ).toEqual([
      { label: "Stock kept in this region", value: "92.7%" },
      { label: "Sales from this region", value: "11.4%" },
      { label: "Region", value: "us-west" },
    ]);
  });

  it("suppresses internal IDs and the redundant product name", () => {
    expect(
      pendingEvidenceStats({ inventory_item_id: "gid://x", title: "Widget", stock_concentration_pct: "92.7" }),
    ).toEqual([{ label: "Stock kept in this region", value: "92.7%" }]);
  });

  it("caps the figures and skips empty values", () => {
    const out = pendingEvidenceStats({ a_units: "1", b_units: "", c_units: "3", d_units: "4", e_units: "5" });
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.value)).toEqual(["1 units", "3 units", "4 units"]);
  });

  it("returns nothing for missing evidence", () => {
    expect(pendingEvidenceStats(undefined)).toEqual([]);
    expect(pendingEvidenceStats(null)).toEqual([]);
    expect(pendingEvidenceStats({})).toEqual([]);
  });
});

describe("pending decision copy", () => {
  it("names the action in the approve line and carries no em/en dashes", () => {
    const approve = pendingApproveText("Reallocate inventory");
    expect(approve).toBe("Calderyn will reallocate inventory now. You can undo it anytime from your history.");
    for (const line of [approve, PENDING_DENY_TEXT, PENDING_TRUST_LINE]) {
      expect(line).not.toMatch(/[—–]/);
    }
  });
});
