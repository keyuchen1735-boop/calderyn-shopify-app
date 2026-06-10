// Real-time sync contract: actions taken in the embedded extension land in the
// shared database and must surface on the web dashboard within one poll tick —
// audit rows and alerts as feed events, guardrail budget usage and campaign
// state as refreshed tiles. pollLiveTick is the single testable tick the
// useLiveFeed hook runs on its interval.
import { describe, expect, it } from "vitest";
import { pollLiveTick, type LivePollState } from "../live";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  GuardrailVM,
  OverviewVM,
} from "../view-models";

const OVERVIEW: OverviewVM = {
  roas_series: [{ daysAgo: 0, spend_cents: 1000, revenue_cents: 3000 }],
  campaign_count: 1,
  active_campaign_count: 1,
  open_alert_count: 0,
  open_alert_dollar_impact_cents: 0,
};

const CAMPAIGN: CampaignVM = {
  id: "c1",
  name: "Prospecting",
  platform: "Meta",
  status: "active",
  daily_budget_cents: 50_000,
  spend_7d: 100_000,
  roas_7d: 3,
  breakeven_roas: 1.7,
  contribution_margin: 0.5,
  grade: "winning",
};

const GUARDRAILS: GuardrailVM = {
  daily_action_budget_cents: 50_000,
  daily_action_budget_used_cents: 0,
  dollar_cap_cents: 100_000,
  cooldown_minutes: 30,
  business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" },
  in_business_hours: true,
  autopilot_enabled: true,
  autopilot_daily_action_cap: 5,
  autopilot_actions_today: 0,
  autopilot_min_spend_cents: 1_000,
  autopilot_max_budget_cut_pct: 30,
};

function auditEntry(id: string): AuditVM {
  return {
    id,
    action_kind: "pause_campaign",
    verb: "Paused campaign",
    target: "Prospecting",
    detail: "",
    dollar_impact_at_exec: 12_000,
    outcome: "succeeded",
    actor: "merchant",
    when: "2026-06-10T18:00:00.000Z",
    undo_eligible: true,
    pre: "—",
    post: "—",
  };
}

function alertEntry(id: string): AlertVM {
  return {
    id,
    detector_id: "campaign_below_breakeven",
    severity: "critical",
    status: "open",
    claude_rank: 1,
    dollar_impact: 40_000,
    created_at: "2026-06-10",
    title: "Campaign below breakeven",
    narrative: "",
    campaign: "Prospecting",
    sku: null,
    evidence: {},
    campaign_id: "c1",
    actions: ["pause_campaign", "snooze_alert"],
    recommended: "pause_campaign",
    rec_detail: "",
  };
}

function makeFetchers(data: {
  audit: AuditVM[];
  alerts: AlertVM[];
  campaigns?: CampaignVM[];
  guardrails?: GuardrailVM;
}) {
  const alertCalls: CampaignVM[][] = [];
  const fetchers = {
    fetchOverview: async () => OVERVIEW,
    fetchAudit: async () => data.audit,
    fetchAlerts: async (
      _filters: undefined,
      campaigns: CampaignVM[] = [],
    ) => {
      alertCalls.push(campaigns);
      return data.alerts;
    },
    fetchCampaigns: async () => data.campaigns ?? [CAMPAIGN],
    fetchGuardrails: async () => data.guardrails ?? GUARDRAILS,
  };
  return { fetchers, alertCalls };
}

function collect() {
  const seen = {
    overview: [] as OverviewVM[],
    campaigns: [] as CampaignVM[][],
    guardrails: [] as GuardrailVM[],
    newAudit: [] as AuditVM[],
    newAlerts: [] as AlertVM[],
  };
  const callbacks = {
    onOverview: (o: OverviewVM) => seen.overview.push(o),
    onCampaigns: (c: CampaignVM[]) => seen.campaigns.push(c),
    onGuardrails: (g: GuardrailVM) => seen.guardrails.push(g),
    onNewAudit: (e: AuditVM) => seen.newAudit.push(e),
    onNewAlerts: (a: AlertVM) => seen.newAlerts.push(a),
  };
  return { seen, callbacks };
}

describe("pollLiveTick — extension actions reflect on the dashboard", () => {
  it("first tick primes the backlog without replaying it as new", async () => {
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const { fetchers } = makeFetchers({
      audit: [auditEntry("au-1")],
      alerts: [alertEntry("al-1")],
    });
    const { seen, callbacks } = collect();

    await pollLiveTick(state, fetchers, callbacks);

    expect(seen.newAudit).toEqual([]);
    expect(seen.newAlerts).toEqual([]);
    expect(seen.overview).toHaveLength(1);
    expect(seen.campaigns).toHaveLength(1);
    expect(seen.guardrails).toHaveLength(1);
  });

  it("surfaces an audit row written by the extension on the next tick", async () => {
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const { seen, callbacks } = collect();

    const first = makeFetchers({ audit: [auditEntry("au-1")], alerts: [] });
    await pollLiveTick(state, first.fetchers, callbacks);

    // The extension executes an action → a new audit row appears, newest-first.
    const second = makeFetchers({
      audit: [auditEntry("au-3"), auditEntry("au-2"), auditEntry("au-1")],
      alerts: [],
    });
    await pollLiveTick(state, second.fetchers, callbacks);

    // Emitted oldest-new-first so unshifting keeps the feed in arrival order.
    expect(seen.newAudit.map((e) => e.id)).toEqual(["au-2", "au-3"]);
  });

  it("surfaces a new alert and refreshed guardrails/campaigns on the next tick", async () => {
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const { seen, callbacks } = collect();

    const first = makeFetchers({ audit: [], alerts: [] });
    await pollLiveTick(state, first.fetchers, callbacks);

    const pausedCampaign = { ...CAMPAIGN, status: "paused" };
    const usedGuardrails = { ...GUARDRAILS, daily_action_budget_used_cents: 12_000 };
    const second = makeFetchers({
      audit: [],
      alerts: [alertEntry("al-1")],
      campaigns: [pausedCampaign],
      guardrails: usedGuardrails,
    });
    await pollLiveTick(state, second.fetchers, callbacks);

    expect(seen.newAlerts.map((a) => a.id)).toEqual(["al-1"]);
    expect(seen.campaigns[1][0].status).toBe("paused");
    expect(seen.guardrails[1].daily_action_budget_used_cents).toBe(12_000);
  });

  it("derives alert campaign mapping from the freshly fetched campaigns", async () => {
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const { fetchers, alertCalls } = makeFetchers({ audit: [], alerts: [] });
    const { callbacks } = collect();

    await pollLiveTick(state, fetchers, callbacks);

    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0].map((c) => c.id)).toEqual(["c1"]);
  });

  it("swallows a transient fetch failure and leaves the state untouched", async () => {
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const { seen, callbacks } = collect();

    const failing = {
      fetchOverview: async (): Promise<OverviewVM> => {
        throw new Error("network blip");
      },
      fetchAudit: async () => [auditEntry("au-1")],
      fetchAlerts: async () => [] as AlertVM[],
      fetchCampaigns: async () => [CAMPAIGN],
      fetchGuardrails: async () => GUARDRAILS,
    };
    await pollLiveTick(state, failing, callbacks);

    expect(seen.overview).toEqual([]);
    expect(seen.newAudit).toEqual([]);
    expect(state.seenAudit).toBeNull();
    expect(state.seenAlerts).toBeNull();
  });
});
