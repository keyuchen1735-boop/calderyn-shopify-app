import { describe, it, expect, vi } from "vitest";
import { hasAdsManagementScope, grantedScopesFromPermissions } from "../integration-status";
import { metaDraftPushEnabled } from "../meta/ad-create.server";
import type { SupabaseClient } from "@supabase/supabase-js";

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

describe("metaDraftPushEnabled", () => {
  function fakeSb(scopes: string | null, error = false): SupabaseClient {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      error ? { data: null, error: { message: "x" } } : { data: { scopes }, error: null },
    );
    return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  }
  it("true when the stored token carries ads_management", async () => {
    expect(await metaDraftPushEnabled(fakeSb("ads_management,ads_read"), "shop")).toBe(true);
  });
  it("false when ads_management is missing", async () => {
    expect(await metaDraftPushEnabled(fakeSb("ads_read"), "shop")).toBe(false);
  });
  it("false when the lookup errors (no false-enable)", async () => {
    expect(await metaDraftPushEnabled(fakeSb(null, true), "shop")).toBe(false);
  });
});
