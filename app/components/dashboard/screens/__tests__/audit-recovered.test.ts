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
    ...overrides,
  };
}

function makeApp(audit: AuditVM[]): DashboardCtx {
  return {
    t: {},
    nav: { screen: "audit", param: null },
    navigate: () => {},
    alerts: [],
    campaigns: [],
    audit,
    guardrails: null,
    integrations: [],
    overview: null,
    feed: [],
    liveOn: false,
    setLiveOn: () => {},
    executeAction: () => {},
    undoAction: () => {},
    pushAdDraft: () => {},
    toast: () => {},
    relTime: () => "just now",
    refresh: () => {},
    loading: false,
  };
}

describe("Audit screen recovered total", () => {
  it("matches the shared helper: undone originals kept, undo rows excluded", () => {
    const html = renderToString(
      h(Audit, {
        app: makeApp([
          // An undone original: locally marked post "Reverted" by undoAction.
          // Extension semantics keep it in the total — only the undo row
          // itself is excluded.
          auditEntry("au-1", "succeeded", 12_000, { post: "Reverted" }),
          auditEntry("au-2", "succeeded", 0, { undo_of: "au-1" }),
          auditEntry("au-3", "failed", 50_000),
        ]),
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("$120 recovered");
  });
});
