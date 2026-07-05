// Stat-row parity with the embedded extension's home page (app._index.tsx).
// The web dashboard's four KPI tiles must mirror the extension's contract:
//   Open alerts / Recovered (7d) / Daily action budget / Real ad return (7d)
// — every tile clickable, no fabricated numbers (the old "Revenue today" card
// showed ad-attributed revenue as shop revenue with a hardcoded 0 order count,
// and "Blended ROAS today" used a single-day ratio instead of the extension's
// spend-weighted, margin-adjusted 7d trueRoas).
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { StatRow } from "../overview-cards";
import type { DashboardCtx } from "../../context";
import type { AuditVM, CampaignVM, GuardrailVM } from "../../view-models";

const CAMPAIGNS: CampaignVM[] = [
  {
    id: "c1",
    name: "Prospecting — Summit Tee",
    platform: "Meta",
    status: "active",
    daily_budget_cents: 50_000,
    spend_7d: 100_000,
    roas_7d: 3,
    breakeven_roas: 1.7,
    contribution_margin: 0.5,
    grade: "winning",
    calderynScore: null,
  },
  {
    id: "c2",
    name: "Retargeting — Duffel",
    platform: "Meta",
    status: "active",
    daily_budget_cents: 30_000,
    spend_7d: 50_000,
    roas_7d: 2,
    breakeven_roas: 1.7,
    contribution_margin: 0.4,
    grade: "okay",
    calderynScore: null,
  },
];

const GUARDRAILS: GuardrailVM = {
  daily_action_budget_cents: 50_000,
  daily_action_budget_used_cents: 12_000,
  dollar_cap_cents: 100_000,
  cooldown_minutes: 30,
  business_hours: { start: "09:00", end: "17:00", tz: "America/New_York" },
  in_business_hours: true,
  business_hours_only: false,
  autopilot_enabled: true,
  autopilot_bypass_guardrails: false,
  autopilot_daily_action_cap: 5,
  autopilot_actions_today: 1,
  autopilot_min_spend_cents: 1_000,
  autopilot_max_budget_cut_pct: 30,
  autopilot_max_budget_increase_pct: 20,
  autopilot_max_daily_budget_cents: null,
  max_price_change_pct: 15,
  autopilot_max_price_change_pct: 10,
  autopilot_max_inventory_units_per_move: null,
};

function auditEntry(
  id: string,
  outcome: string,
  cents: number,
  undo_of: string | null = null,
): AuditVM {
  return {
    id,
    action_kind: "pause_campaign",
    verb: "Paused campaign",
    target: "Prospecting",
    detail: "",
    dollar_impact_at_exec: cents,
    outcome,
    actor: "merchant",
    when: "2026-06-10T18:00:00.000Z",
    // Recovered (7d) on the Dashboard screen windows by the real clock, so keep
    // these fixtures inside the window regardless of when the suite runs.
    created_at: new Date().toISOString(),
    undo_eligible: true,
    undo_of,
    pre: "—",
    post: "—",
    mode: "manual",
    actorDisplay: "You",
    marginBasis: "none",
    marginBasisLabel: "No booked margin",
    costLineage: [],
    why: "Manual — dashboard",
    stateDiff: [],
  };
}

function makeApp(overrides: Partial<DashboardCtx> = {}): DashboardCtx {
  return {
    t: {},
    shopDomain: "test.myshopify.com",
    storeLabel: "test.myshopify.com",
    demoMode: false,
    canDeleteAccount: false,
    hasCatalog: true,
    nav: { screen: "dashboard", param: null, sub: null },
    navigate: () => {},
  setNightMode: () => {},
    alerts: [],
    campaigns: CAMPAIGNS,
    audit: [],
    guardrails: GUARDRAILS,
    integrations: [],
    setIntegrations: () => {},
    consent: null,
    overview: null,
    calibration: null,
    actionQueue: [],
    liveEngine: null,
    feed: [],
    liveOn: false,
    setLiveOn: () => {},
    executeAction: async () => ({ ok: true, receipt: null }),
    undoAction: () => {},
    pushAdDraft: () => {},
    toast: () => {},
    relTime: () => "just now",
    refresh: () => {},
    refreshCalibration: () => {},
    openAssistant: () => {},
    refreshLiveEngine: () => {},
    loading: false,
    booted: true,
    ...overrides,
  };
}

function renderStatGrid(app: DashboardCtx): { html: string; grid: string } {
  // Strip SSR text-boundary markers (`across <!-- -->1<!-- --> action`) so
  // assertions can match the visible text. StatRow now lives in overview-cards
  // and is rendered on the Analytics screen (the Overview is the Live Engine);
  // render it directly — its whole output IS the stat grid.
  const html = renderToString(h(StatRow, { app })).replace(/<!-- -->/g, "");
  const start = html.indexOf("cd-stat-grid");
  expect(start).toBeGreaterThan(-1);
  return { html, grid: html.slice(start) };
}

describe("Dashboard stat row mirrors the extension's KPI contract", () => {
  it("renders the extension's four tiles and drops the fabricated ones", () => {
    const { grid } = renderStatGrid(makeApp());
    expect(grid).toContain("Open alerts");
    expect(grid).toContain("Recovered (7d)");
    expect(grid).toContain("Daily action budget");
    expect(grid).toContain("Real ad return (7d)");
    expect(grid).not.toContain("Revenue today");
    expect(grid).not.toContain("Blended ROAS today");
  });

  it("computes Real ad return with the extension's spend-weighted trueRoas", () => {
    const { grid } = renderStatGrid(makeApp());
    // Same fixture as roas.test.ts: (100000·3·0.5 + 50000·2·0.4)/150000 → 1.3×
    expect(grid).toContain("1.3×");
    expect(grid).toContain("margin-adjusted ROAS, all campaigns");
  });

  it("shows the remaining daily action budget from live guardrails", () => {
    const { grid } = renderStatGrid(makeApp());
    // 50_000 − 12_000 = 38_000 cents left
    expect(grid).toContain("left today");
    expect(grid).toContain("$380");
  });

  it("degrades the budget tile when guardrails have not loaded", () => {
    const { grid } = renderStatGrid(makeApp({ guardrails: null }));
    expect(grid).toContain("Daily action budget");
    expect(grid).toContain("unavailable");
  });

  it("computes Recovered (7d) like the extension: undo rows excluded, undone originals pulled back", () => {
    const { grid } = renderStatGrid(
      makeApp({
        audit: [
          auditEntry("au-1", "succeeded", 12_000), // undone below → pulled back
          auditEntry("au-2", "succeeded", -12_000, "au-1"), // undo of au-1
          auditEntry("au-3", "failed", 50_000),
          auditEntry("au-4", "succeeded", 12_000), // still standing → counts
        ],
      }),
    );
    // au-1 is undone (excluded) and au-2 is its undo row (excluded); only the
    // still-standing au-4 counts.
    expect(grid).toContain("$120");
    expect(grid).toContain("across 1 action");
    expect(grid).not.toContain("$240");
  });

  it("makes every stat tile a keyboard-operable click target", () => {
    const { grid } = renderStatGrid(makeApp());
    const buttons = grid.match(/role="button"/g) ?? [];
    expect(buttons.length).toBe(4);
  });
});
