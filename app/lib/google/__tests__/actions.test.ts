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
});
