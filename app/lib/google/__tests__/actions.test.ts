import { describe, it, expect, vi, afterEach } from "vitest";
import { makeGoogleActionAdapter, googleActionAdapterForShop } from "../actions.server";

// Mock collaborators so googleActionAdapterForShop's real mutate can run
// without db/crypto. The injected-mutate tests below are unaffected.
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { access_token_encrypted: "enc", external_account_id: "123" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("../../crypto.server", () => ({ decrypt: () => "refresh-token" }));

describe("googleActionAdapter", () => {
  it("pause issues an updateMask status=PAUSED mutate on the campaign", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").pause("777");
    expect(mutate).toHaveBeenCalledWith("campaigns", expect.objectContaining({
      update: expect.objectContaining({ resourceName: "customers/123/campaigns/777", status: "PAUSED" }),
      updateMask: "status",
    }));
  });

  it("setDailyBudget mutates the budget resource in micros", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").setDailyBudget("777", 5000);
    // 5000 cents -> 50,000,000 micros
    expect(mutate).toHaveBeenCalledWith("campaignBudgets", expect.objectContaining({
      update: expect.objectContaining({ amountMicros: 50000000 }),
      updateMask: "amount_micros",
    }), "777");
  });

  it("getState reads status + budget via the injected reader", async () => {
    const mutate = vi.fn();
    const read = vi.fn(async () => ({ status: "PAUSED", amountMicros: 50000000 }));
    const s = await makeGoogleActionAdapter(mutate, "123", read).getState("777");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });

  it("excludeGeo creates one negative location criterion per state in the region", async () => {
    const ops: Array<{ resource: string; op: Record<string, unknown> }> = [];
    const mutate = vi.fn(async (resource: string, op: Record<string, unknown>) => {
      ops.push({ resource, op });
      return {};
    });
    // us-east covers 12 states (incl. DC).
    await makeGoogleActionAdapter(mutate, "123").excludeGeo("555", "us-east");
    expect(ops).toHaveLength(12);
    expect(ops[0].resource).toBe("campaignCriteria");
    expect(ops[0].op).toMatchObject({
      create: {
        campaign: "customers/123/campaigns/555",
        negative: true,
        location: { geoTargetConstant: expect.stringMatching(/^geoTargetConstants\/\d+$/) },
      },
    });
  });

  it("includeGeo removes only the region's negative location criteria", async () => {
    const removed: string[] = [];
    const mutate = vi.fn(async (_resource: string, op: Record<string, unknown>) => {
      if ("remove" in op) removed.push(String(op.remove));
      return {};
    });
    // One criterion in the region (CA = us-west) and one outside it (NY = us-east).
    const searchCriteria = vi.fn(async () => [
      { resourceName: "customers/123/campaignCriteria/555~1", geoTargetConstant: "geoTargetConstants/21137" }, // CA
      { resourceName: "customers/123/campaignCriteria/555~2", geoTargetConstant: "geoTargetConstants/21167" }, // NY
    ]);
    await makeGoogleActionAdapter(mutate, "123", undefined, searchCriteria).includeGeo("555", "us-west");
    expect(removed).toEqual(["customers/123/campaignCriteria/555~1"]);
  });
});

describe("googleActionAdapterForShop mutate errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces detail errorCode + message, not just the generic top-level message", async () => {
    // Mutate (non-streaming) returns a BARE { error } body. Same
    // PERMISSION_DENIED shape captured live on 2026-06-10: the actionable
    // reason lives only in error.details[].errors[] (rule 12).
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    const fetchMock = vi
      .fn()
      // 1st call: oauth token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" })))
      // 2nd call: campaigns:mutate -> 403 with detail errors
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "The caller does not have permission",
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.ads.googleads.v23.errors.GoogleAdsFailure",
                  errors: [
                    {
                      errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" },
                      message:
                        "The developer token is only approved for use with test accounts. To access non-test accounts, apply for Basic or Standard access.",
                    },
                  ],
                },
              ],
            },
          }),
          { status: 403 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await googleActionAdapterForShop("shop-1");
    await expect(adapter!.pause("777")).rejects.toThrow(/DEVELOPER_TOKEN_NOT_APPROVED/);
  });

  it("setDailyBudget resolves the campaign's budget resourceName before mutating", async () => {
    // Regression: the real mutate ignored campaignExternalId and sent a
    // campaignBudgets update with NO resourceName — every Google budget edit
    // failed. The budget is its own resource and must be looked up first.
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    const fetchMock = vi
      .fn()
      // 1st: oauth token exchange (search path)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" })))
      // 2nd: googleAds:search -> campaign.campaignBudget
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ campaign: { campaignBudget: "customers/123/campaignBudgets/456" } }],
          }),
        ),
      )
      // 3rd: oauth token exchange (mutate path)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" })))
      // 4th: campaignBudgets:mutate -> ok
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{}] })));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await googleActionAdapterForShop("shop-1");
    await adapter!.setDailyBudget("777", 5000);

    const searchCall = fetchMock.mock.calls[1];
    expect(String(searchCall[0])).toContain("googleAds:search");
    expect(String(searchCall[1]?.body)).toContain("campaign.id = 777");

    const mutateCall = fetchMock.mock.calls[3];
    expect(String(mutateCall[0])).toContain("campaignBudgets:mutate");
    const body = JSON.parse(String(mutateCall[1]?.body)) as {
      operations: Array<{ update: { resourceName?: string; amountMicros?: number } }>;
    };
    expect(body.operations[0].update.resourceName).toBe("customers/123/campaignBudgets/456");
    expect(body.operations[0].update.amountMicros).toBe(50_000_000);
  });

  it("setDailyBudget fails actionably when the campaign has no budget row", async () => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
    process.env.GOOGLE_ADS_CLIENT_ID = "cid";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await googleActionAdapterForShop("shop-1");
    await expect(adapter!.setDailyBudget("777", 5000)).rejects.toThrow(
      /no campaign budget found/,
    );
  });
});
