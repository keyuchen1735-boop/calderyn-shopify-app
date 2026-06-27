import { describe, it, expect } from "vitest";
import { hasAdsManagementScope, grantedScopesFromPermissions } from "../integration-status";

describe("hasAdsManagementScope", () => {
  it("is true when ads_management is present", () => {
    expect(hasAdsManagementScope("ads_read,ads_management")).toBe(true);
    expect(hasAdsManagementScope(" ads_management , ads_read ")).toBe(true);
  });
  it("is false when absent, empty, or null", () => {
    expect(hasAdsManagementScope("ads_read")).toBe(false);
    expect(hasAdsManagementScope("")).toBe(false);
    expect(hasAdsManagementScope(null)).toBe(false);
    expect(hasAdsManagementScope(undefined)).toBe(false);
  });
});

describe("grantedScopesFromPermissions", () => {
  it("keeps only granted permissions, comma-joined", () => {
    const perms = {
      data: [
        { permission: "ads_management", status: "granted" },
        { permission: "ads_read", status: "granted" },
        { permission: "email", status: "declined" },
      ],
    };
    expect(grantedScopesFromPermissions(perms)).toBe("ads_management,ads_read");
  });
  it("returns '' on a malformed payload", () => {
    expect(grantedScopesFromPermissions(null)).toBe("");
    expect(grantedScopesFromPermissions({})).toBe("");
  });
});
