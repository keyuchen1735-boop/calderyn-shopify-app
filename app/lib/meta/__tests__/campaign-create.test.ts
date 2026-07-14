import { describe, expect, it, vi } from "vitest";
import { createFirstCampaign, RollbackFailedError, type FirstCampaignInput } from "../campaign-create.server";
import type { MetaClient } from "../campaigns.server";
import type { MetaWriteConn } from "../ad-create.server";
import type { CreativeInput } from "~/lib/screener/types";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off everything this week.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

const BASE_INPUT: FirstCampaignInput = {
  name: "Summer Sale Launch",
  dailyBudgetCents: 1500,
  countryCode: "US",
  creative: CREATIVE,
};

// No retry backoff in tests: 1 attempt, no sleep.
const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0 };

/** Wires up a fake client that answers campaign/adset/promote_pages/creative/ad
 *  posts in sequence, recording every post call, so wire-shape assertions can
 *  inspect exactly what was sent. `overridePost` can intercept/replace any step. */
function wiredClient(overridePost?: (path: string, body: Record<string, string>) => MetaResponseLike | undefined) {
  const calls: Array<{ path: string; body: Record<string, string> }> = [];
  const post = vi.fn(async (path: string, body: Record<string, string>) => {
    calls.push({ path, body });
    const overridden = overridePost?.(path, body);
    if (overridden) return overridden;
    if (path === "/act_1/campaigns") return { id: "camp_1" };
    if (path === "/act_1/adsets") return { id: "as_1" };
    if (path === "/act_1/adcreatives") return { id: "crea_1" };
    if (path === "/as_1/ads") return { id: "ad_1" };
    return { success: true };
  });
  const get = vi.fn(async (path: string) => (path === "/act_1/promote_pages" ? { data: [{ id: "page_1" }] } : { data: [] }));
  const client: MetaClient = { get, post };
  const conn: MetaWriteConn = { client, adAccountId: "act_1" };
  return { client, conn, calls, post, get };
}

type MetaResponseLike = { id?: string; error?: { message: string; code?: number } } | Record<string, unknown>;

describe("createFirstCampaign", () => {
  it("(a) happy path: posts campaign PAUSED, ad set + ad ACTIVE, and returns all three ids", async () => {
    const { conn, calls } = wiredClient();

    const res = await createFirstCampaign(conn, BASE_INPUT, NO_RETRY);

    expect(res).toEqual({ campaignId: "camp_1", adSetId: "as_1", adId: "ad_1" });

    const campaignCall = calls.find((c) => c.path === "/act_1/campaigns");
    expect(campaignCall?.body).toEqual({
      name: "Summer Sale Launch",
      objective: "OUTCOME_SALES",
      status: "PAUSED",
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: "false",
    });

    const adSetCall = calls.find((c) => c.path === "/act_1/adsets");
    expect(adSetCall?.body.campaign_id).toBe("camp_1");
    expect(adSetCall?.body.daily_budget).toBe("1500");
    expect(adSetCall?.body.billing_event).toBe("IMPRESSIONS");
    expect(adSetCall?.body.optimization_goal).toBe("LINK_CLICKS");
    expect(adSetCall?.body.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(adSetCall?.body.status).toBe("ACTIVE");
    expect(adSetCall?.body.name).toBe("Summer Sale Launch — Ad set");
    const targeting = JSON.parse(adSetCall?.body.targeting ?? "{}");
    expect(targeting).toEqual({ geo_locations: { countries: ["US"] } });

    // Creative + ad flowed through createPausedAd with the new ad set id.
    const adCall = calls.find((c) => c.path === "/as_1/ads");
    expect(adCall?.body.adset_id).toBe("as_1");
    expect(adCall?.body.status).toBe("ACTIVE");

    // The campaign is the single on/off gate: it is the only object created
    // PAUSED, while the ad set and ad are created ACTIVE so turning the campaign
    // on delivers the whole funnel.
    const pausedWrites = calls.filter((c) => "status" in c.body && c.body.status === "PAUSED");
    expect(pausedWrites.map((c) => c.path)).toEqual(["/act_1/campaigns"]);
  });

  it("(b) ad-set failure deletes the campaign and rethrows the original error", async () => {
    const { conn, calls } = wiredClient((path) => {
      if (path === "/act_1/adsets") return { error: { message: "invalid targeting", code: 100 } };
      return undefined;
    });

    await expect(createFirstCampaign(conn, BASE_INPUT, NO_RETRY)).rejects.toThrow(/invalid targeting/);

    const deleteCall = calls.find((c) => c.path === "/camp_1" && c.body.status === "DELETED");
    expect(deleteCall).toBeTruthy();
    // No ad/creative posts happened after the ad-set failure.
    expect(calls.some((c) => c.path === "/act_1/adcreatives")).toBe(false);
  });

  it("(c) ad failure deletes the campaign and rethrows the original error", async () => {
    const { conn, calls } = wiredClient((path) => {
      if (path === "/as_1/ads") return { error: { message: "creative rejected", code: 100 } };
      return undefined;
    });

    await expect(createFirstCampaign(conn, BASE_INPUT, NO_RETRY)).rejects.toThrow(/creative rejected/);

    const deleteCall = calls.find((c) => c.path === "/camp_1" && c.body.status === "DELETED");
    expect(deleteCall).toBeTruthy();
  });

  it("(b2) Meta rejections surface the step label, code/subcode, and error_user_msg", async () => {
    const { conn } = wiredClient((path) => {
      if (path === "/act_1/campaigns")
        return {
          error: {
            message: "Invalid parameter",
            code: 100,
            error_subcode: 4834011,
            error_user_msg: "You must specify True or False in the field is_adset_budget_sharing_enabled",
          },
        };
      return undefined;
    });

    await expect(createFirstCampaign(conn, BASE_INPUT, NO_RETRY)).rejects.toThrow(
      "campaign create: Invalid parameter (code 100/4834011) — You must specify True or False in the field is_adset_budget_sharing_enabled",
    );
  });

  it("(d) budget outside 500-20000 throws before any post", async () => {
    const { conn, calls } = wiredClient();

    await expect(
      createFirstCampaign(conn, { ...BASE_INPUT, dailyBudgetCents: 499 }, NO_RETRY),
    ).rejects.toThrow(/dailyBudgetCents out of range 500-20000/);
    await expect(
      createFirstCampaign(conn, { ...BASE_INPUT, dailyBudgetCents: 20001 }, NO_RETRY),
    ).rejects.toThrow(/dailyBudgetCents out of range 500-20000/);

    expect(calls.length).toBe(0);
  });

  it("(e) rollback-delete failure does not mask the original error", async () => {
    const { conn } = wiredClient((path, body) => {
      if (path === "/act_1/adsets") return { error: { message: "invalid targeting", code: 100 } };
      if (path === "/camp_1" && body.status === "DELETED") return { error: { message: "cannot delete", code: 100 } };
      return undefined;
    });

    let caught: unknown;
    try {
      await createFirstCampaign(conn, BASE_INPUT, NO_RETRY);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RollbackFailedError);
    const err = caught as RollbackFailedError;
    expect(err.orphanCampaignId).toBe("camp_1");
    expect(err.message).toContain("invalid targeting");
  });

  it("(f) onCampaignCreated is awaited with the campaign id after the campaign post and before the ad set", async () => {
    const { conn, calls } = wiredClient();
    const pathsAtInvoke: string[][] = [];
    const onCampaignCreated = vi.fn(async (_id: string) => {
      pathsAtInvoke.push(calls.map((c) => c.path));
    });

    await createFirstCampaign(conn, BASE_INPUT, NO_RETRY, onCampaignCreated);

    expect(onCampaignCreated).toHaveBeenCalledTimes(1);
    expect(onCampaignCreated).toHaveBeenCalledWith("camp_1");
    // At invocation time the campaign post had happened and the ad set had not.
    expect(pathsAtInvoke[0]).toContain("/act_1/campaigns");
    expect(pathsAtInvoke[0]).not.toContain("/act_1/adsets");
  });

  it("(g) onCampaignCreated rejection aborts before the ad set, rollback-deletes the campaign, and rethrows", async () => {
    const { conn, calls } = wiredClient();
    const onCampaignCreated = vi.fn(async () => {
      throw new Error("bookkeeping write failed");
    });

    await expect(
      createFirstCampaign(conn, BASE_INPUT, NO_RETRY, onCampaignCreated),
    ).rejects.toThrow(/bookkeeping write failed/);

    // No ad set (or anything downstream) was created past the failed checkpoint.
    expect(calls.some((c) => c.path === "/act_1/adsets")).toBe(false);
    expect(calls.some((c) => c.path === "/act_1/adcreatives")).toBe(false);
    // The orphan campaign was rollback-deleted.
    const deleteCall = calls.find((c) => c.path === "/camp_1" && c.body.status === "DELETED");
    expect(deleteCall).toBeTruthy();
  });
});
