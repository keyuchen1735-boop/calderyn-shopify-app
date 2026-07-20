import type { CampaignWindow } from "~/lib/types";
import type { CampaignVM } from "./view-models";

export interface CampaignReportState {
  window: CampaignWindow;
  campaigns: CampaignVM[];
  status: "loading" | "ready" | "error";
  targetWindow: CampaignWindow | null;
  error: string | null;
  requestId: number | null;
}

type CampaignReportAction =
  | { type: "start"; requestId: number; window: CampaignWindow }
  | { type: "success"; requestId: number; window: CampaignWindow; campaigns: CampaignVM[] }
  | { type: "failure"; requestId: number; window: CampaignWindow; error: string }
  | { type: "poll"; window: CampaignWindow; campaigns: CampaignVM[] }
  | { type: "patch"; id: string; patch: Partial<CampaignVM> };

export function initialCampaignReport(
  window: CampaignWindow,
  campaigns: CampaignVM[] = [],
): CampaignReportState {
  return {
    window,
    campaigns,
    status: campaigns.length ? "ready" : "loading",
    targetWindow: null,
    error: null,
    requestId: null,
  };
}

export function campaignReportReducer(
  state: CampaignReportState,
  action: CampaignReportAction,
): CampaignReportState {
  switch (action.type) {
    case "start":
      return { ...state, status: "loading", targetWindow: action.window, error: null, requestId: action.requestId };
    case "success":
      if (state.requestId !== action.requestId || state.targetWindow !== action.window) return state;
      return { window: action.window, campaigns: action.campaigns, status: "ready", targetWindow: null, error: null, requestId: null };
    case "failure":
      if (state.requestId !== action.requestId || state.targetWindow !== action.window) return state;
      return { ...state, status: "error", error: action.error, requestId: null };
    case "poll":
      if (state.status !== "ready" || state.targetWindow !== null || state.window !== action.window) return state;
      return { ...state, campaigns: action.campaigns };
    case "patch":
      return { ...state, campaigns: state.campaigns.map((campaign) => campaign.id === action.id ? { ...campaign, ...action.patch } : campaign) };
  }
}
