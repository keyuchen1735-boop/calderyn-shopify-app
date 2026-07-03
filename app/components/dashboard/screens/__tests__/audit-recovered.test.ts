// The Audit screen's header "recovered" total must use the same shared
// computation (app/lib/recovered.ts) as the Overview tile and the embedded
// extension: succeeded actions, undo rows excluded — never the local
// post === "Reverted" heuristic.
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import Audit from "../Audit";
import type { DashboardCtx } from "../../context";
import type { AuditVM } from "../../view-models";

function auditEntry(
  id: string,
  outcome: string,
  cents: number,
  overrides: Partial<AuditVM> = {},
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
    created_at: "2026-06-10T18:00:00.000Z",
    undo_eligible: true,
    undo_of: null,
    pre: "—",
    post: "—",
    mode: "manual",
    actorDisplay: "You",
    marginBasis: "none",
    marginBasisLabel: "No booked margin",
    costLineage: [],
    why: "Manual — dashboard",
    stateDiff: [],
    ...overrides,
  };
}

function makeApp(audit: AuditVM[]): DashboardCtx {
  return {
    t: {},
    shopDomain: "test.myshopify.com",
    storeLabel: "test.myshopify.com",
    nav: { screen: "audit", param: null, sub: null },
    navigate: () => {},
    alerts: [],
    campaigns: [],
    audit,
    guardrails: null,
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
    refreshLiveEngine: () => {},
    loading: false,
  };
}

describe("Audit screen recovered total", () => {
  it("matches the shared helper: undone originals pulled back, undo rows excluded", () => {
    const html = renderToString(
      h(Audit, {
        app: makeApp([
          // An undone original: undoAction reverses it, so its recovered impact
          // is pulled back out of the total. Both the original (au-1) and its
          // undo row (au-2) drop out; only still-standing actions count.
          auditEntry("au-1", "succeeded", 12_000, { post: "Reverted" }),
          auditEntry("au-2", "succeeded", -12_000, { undo_of: "au-1" }),
          auditEntry("au-3", "failed", 50_000),
          auditEntry("au-4", "succeeded", 8_000),
        ]),
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("$80 recovered");
  });
});
