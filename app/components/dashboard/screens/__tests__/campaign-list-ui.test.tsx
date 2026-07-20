// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Campaigns from "../Campaigns";
import type { DashboardCtx } from "../../context";
import type { CampaignVM } from "../../view-models";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));
vi.mock("gsap", () => ({
  default: { registerPlugin: vi.fn(), utils: { toArray: () => [] } },
}));
vi.mock("gsap/Flip", () => ({
  Flip: { getState: vi.fn(), from: vi.fn() },
}));
vi.mock("../CampaignWizard", () => ({ CampaignWizard: () => null }));
vi.mock("~/lib/dashboard/campaign-drafts-client", () => ({
  fetchCampaignDrafts: () => new Promise(() => undefined),
  deleteCampaignDraft: vi.fn(),
}));
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {},
  fetchAnalytics: () => new Promise(() => undefined),
  fetchCampaignCreatives: () => new Promise(() => undefined),
  fetchCampaignSeries: () => new Promise(() => undefined),
  executeCampaignAction: vi.fn(),
  pushCreativeDraft: vi.fn(),
  regenerateCampaign: vi.fn(),
  updateCampaignClassification: vi.fn(),
}));

const campaign: CampaignVM = {
  id: "campaign-1",
  name: "Summer campaign",
  platform: "Meta",
  status: "active",
  daily_budget_cents: 2_000,
  campaign_kind: "sales",
  sale_type: "Summer sale",
  classification_source: "merchant",
  orders: 4,
  revenue_cents: 20_000,
  spend_cents: 5_000,
  profit_cents: 8_000,
  true_roas: 4,
  cost_complete: true,
  cost_sources: [],
  spend_7d: 5_000,
  roas_7d: 4,
  breakeven_roas: 2,
  contribution_margin: 0.4,
  grade: "winning",
  calderynScore: null,
};

const roots: Root[] = [];

function setNarrowViewport(narrow: boolean) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: vi.fn() },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: narrow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function dashboardApp(param: string | null): DashboardCtx {
  return {
    campaigns: [campaign],
    nav: { screen: "campaigns", param, sub: null },
    loading: false,
    storeLabel: "Test store",
    navigate: vi.fn(),
    toast: vi.fn(),
    refresh: vi.fn(),
  } as unknown as DashboardCtx;
}

function renderCampaigns(param: string | null = null) {
  const host = document.createElement("div");
  host.className = "cd-root";
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Campaigns app={dashboardApp(param)} />));
  return host;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("campaign list controls", () => {
  it("labels both segmented groups and exposes their selected values", () => {
    setNarrowViewport(false);
    const host = renderCampaigns();
    const filters = host.querySelector('[role="group"][aria-label="Campaign filters"]');
    const windowGroup = host.querySelector('[role="group"][aria-label="Reporting window"]');

    expect(filters?.querySelector('[aria-pressed="true"]')?.textContent).toBe("All");
    expect(windowGroup?.querySelector('[aria-pressed="true"]')?.textContent).toBe("30");
  });

  it("opens mobile classification editing outside the horizontally scrolling table", () => {
    setNarrowViewport(true);
    const host = renderCampaigns();

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Edit campaign type"]')!.click());

    const editor = document.body.querySelector('[role="dialog"][aria-label="Edit campaign type"]');
    expect(editor).not.toBeNull();
    expect(editor?.closest(".cd-pan")).toBeNull();
    expect(editor?.closest(".cd-root")).toBe(host);
  });
});

describe("campaign detail classification", () => {
  it("opens the shared classification editor from campaign detail", () => {
    setNarrowViewport(false);
    const host = renderCampaigns(campaign.id);
    const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit campaign type"]');

    expect(edit).not.toBeNull();
    act(() => edit!.click());
    expect(host.querySelector('select[aria-label="Campaign type"]')).not.toBeNull();
  });
});
