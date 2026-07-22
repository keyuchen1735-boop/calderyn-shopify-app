import { describe, expect, it } from "vitest";
import {
  campaignReportReducer,
  initialCampaignReport,
} from "../campaign-report-state";
import type { CampaignVM } from "../view-models";

const row = (id: string) => ({ id }) as CampaignVM;

describe("campaign report state", () => {
  it("commits only the newest overlapping window request", () => {
    let state = initialCampaignReport(30);
    state = campaignReportReducer(state, { type: "start", requestId: 1, window: 90 });
    state = campaignReportReducer(state, { type: "start", requestId: 2, window: 7 });
    state = campaignReportReducer(state, {
      type: "success", requestId: 2, window: 7, campaigns: [row("seven")],
    });
    const newest = state;

    state = campaignReportReducer(state, {
      type: "success", requestId: 1, window: 90, campaigns: [row("stale")],
    });

    expect(state).toBe(newest);
    expect(state).toMatchObject({
      window: 7,
      campaigns: [{ id: "seven" }],
      status: "ready",
      targetWindow: null,
    });
  });

  it("retains an initial campaign failure until a matching retry succeeds", () => {
    let state = initialCampaignReport(30);
    state = campaignReportReducer(state, { type: "start", requestId: 1, window: 30 });
    state = campaignReportReducer(state, {
      type: "failure", requestId: 1, window: 30, error: "Campaign metrics unavailable.",
    });

    expect(state).toMatchObject({
      window: 30,
      campaigns: [],
      status: "error",
      targetWindow: 30,
      error: "Campaign metrics unavailable.",
    });

    state = campaignReportReducer(state, { type: "start", requestId: 2, window: 30 });
    state = campaignReportReducer(state, {
      type: "success", requestId: 2, window: 30, campaigns: [row("retry")],
    });
    expect(state).toMatchObject({ status: "ready", campaigns: [{ id: "retry" }] });
  });

  it("rejects poll data for an old or superseded reporting window", () => {
    let state = initialCampaignReport(30, [row("thirty")]);
    state = campaignReportReducer(state, { type: "start", requestId: 1, window: 90 });

    expect(campaignReportReducer(state, {
      type: "poll", window: 30, campaigns: [row("old-poll")],
    })).toBe(state);

    state = campaignReportReducer(state, {
      type: "success", requestId: 1, window: 90, campaigns: [row("ninety")],
    });
    expect(campaignReportReducer(state, {
      type: "poll", window: 30, campaigns: [row("late-poll")],
    })).toBe(state);
  });
});
