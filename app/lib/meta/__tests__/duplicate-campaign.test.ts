import { describe, expect, it } from "vitest";
import { duplicateCampaign } from "../campaigns.server";
import type { MetaClient, MetaResponse } from "../campaigns.server";

function fakeClient(post: (path: string, body: Record<string, string>) => MetaResponse): MetaClient {
  return {
    get: async () => ({} as MetaResponse),
    post: async (path, body) => post(path, body),
  };
}

describe("duplicateCampaign", () => {
  it("POSTs /{id}/copies with deep_copy + PAUSED and returns the copy id", async () => {
    const calls: Array<{ path: string; body: Record<string, string> }> = [];
    const client = fakeClient((path, body) => {
      calls.push({ path, body });
      return { copied_campaign_id: "238123" } as unknown as MetaResponse;
    });
    const res = await duplicateCampaign(client, "9001");
    expect(res).toEqual({ copiedCampaignId: "238123" });
    expect(calls[0].path).toBe("/9001/copies");
    expect(calls[0].body.deep_copy).toBe("true");
    expect(calls[0].body.status_option).toBe("PAUSED");
  });

  it("throws loudly when Meta returns an error payload", async () => {
    const client = fakeClient(() => ({ error: { message: "nope", code: 10 } } as unknown as MetaResponse));
    await expect(duplicateCampaign(client, "9001")).rejects.toThrow(/nope/);
  });

  it("throws when the response has no copied_campaign_id", async () => {
    const client = fakeClient(() => ({} as MetaResponse));
    await expect(duplicateCampaign(client, "9001")).rejects.toThrow(/copied_campaign_id/);
  });
});
