import { describe, expect, it } from "vitest";
import { firstRunPreflight } from "../first-run.server";
import type { MetaResponse } from "../campaigns.server";

const sbWithScopes = (scopes: string | null) =>
  ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: scopes === null ? null : { scopes }, error: null }),
          }),
        }),
      }),
    }),
  }) as never;

const conn = (pages: unknown[], funding?: unknown) => ({
  adAccountId: "act_1",
  client: {
    post: async () => ({} as MetaResponse),
    get: async (path: string) =>
      (path.includes("promote_pages")
        ? { data: pages }
        : { funding_source_details: funding }) as MetaResponse,
  },
});

describe("firstRunPreflight", () => {
  it("all green with scope + page + funding", async () => {
    const res = await firstRunPreflight("shop", sbWithScopes("ads_management,ads_read"), {
      resolveConn: async () => conn([{ id: "77" }], { id: "f1" }),
    });
    expect(res).toEqual({ metaConnected: true, adsScope: true, pageOk: true, fundingOk: true });
  });

  it("not connected: everything false, fundingOk null", async () => {
    const res = await firstRunPreflight("shop", sbWithScopes(null), { resolveConn: async () => null });
    expect(res).toEqual({ metaConnected: false, adsScope: false, pageOk: false, fundingOk: null });
  });

  it("funding lookup failure reports null (advisory), not false", async () => {
    const badFunding = conn([{ id: "77" }]);
    badFunding.client.get = async (path: string) =>
      (path.includes("promote_pages") ? { data: [{ id: "77" }] } : { error: { message: "denied" } }) as MetaResponse;
    const res = await firstRunPreflight("shop", sbWithScopes("ads_management"), {
      resolveConn: async () => badFunding,
    });
    expect(res.fundingOk).toBeNull();
    expect(res.pageOk).toBe(true);
  });

  it("connection lookup failure degrades to not-connected, never throws", async () => {
    const res = await firstRunPreflight("shop", sbWithScopes("ads_management"), {
      resolveConn: async () => {
        throw new Error("supabase read failed");
      },
    });
    expect(res).toEqual({ metaConnected: false, adsScope: false, pageOk: false, fundingOk: null });
  });
});
