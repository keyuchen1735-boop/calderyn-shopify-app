import { describe, it, expect } from "vitest";
import { resolveActionParam } from "../action-param";

describe("resolveActionParam", () => {
  const allowed = ["pause_campaign", "snooze_alert"] as const;

  it("returns the kind when it is in the allowed list", () => {
    expect(resolveActionParam("pause_campaign", [...allowed])).toBe("pause_campaign");
  });

  it("returns null for a kind not allowed for this alert", () => {
    expect(resolveActionParam("exclude_geo", [...allowed])).toBeNull();
  });

  it("returns null for an unknown or missing value", () => {
    expect(resolveActionParam("garbage", [...allowed])).toBeNull();
    expect(resolveActionParam(null, [...allowed])).toBeNull();
  });
});
