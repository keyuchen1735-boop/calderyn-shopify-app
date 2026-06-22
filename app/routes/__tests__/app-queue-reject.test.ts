/**
 * Tests for the reject + undo-rule intents on app.queue.tsx.
 *
 * Key invariant: reject re-derives detector/action/impact from the TRUSTED alert
 * (via client.alerts.get), never from the form. It must NEVER call any executor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { action, loader } from "../app.queue";

// Hoisted spies — must be set up before any imports are resolved.
const {
  queueListSpy,
  learnedRulesSpy,
  recordRejectionSpy,
  undoRuleSpy,
  alertsGetSpy,
  executeActionSpy,
  recommendedActionSpy,
} = vi.hoisted(() => ({
  queueListSpy: vi.fn(),
  learnedRulesSpy: vi.fn(),
  recordRejectionSpy: vi.fn(),
  undoRuleSpy: vi.fn(),
  alertsGetSpy: vi.fn(),
  executeActionSpy: vi.fn(),
  recommendedActionSpy: vi.fn(),
}));

// Stub Polaris so the route module loads without the real UI library.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    InlineStack: Stub,
    Page: Stub,
    Select: Stub,
    Text: Stub,
    TextField: Stub,
  };
});

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    queue: { list: (...a: unknown[]) => queueListSpy(...a) },
    calibration: {
      learnedRules: (...a: unknown[]) => learnedRulesSpy(...a),
      recordRejection: (...a: unknown[]) => recordRejectionSpy(...a),
      undoRule: (...a: unknown[]) => undoRuleSpy(...a),
      get: async () => ({ pct: 24, updated_at: null }),
      nearGraduation: async () => 0,
    },
    alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) },
    // Expose an actions.execute spy to prove reject never calls it.
    actions: { execute: (...a: unknown[]) => executeActionSpy(...a) },
  }),
}));

vi.mock("~/lib/labels", () => ({
  alertDetectorLabel: (id: string) => id,
  ACTION_LABELS: {} as Record<string, string>,
  recommendedAction: (...a: unknown[]) => recommendedActionSpy(...a),
}));

vi.mock("~/lib/format", () => ({
  fmtMoney: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

vi.mock("~/lib/ids", () => ({
  newIdempotencyKey: () => "test-key",
}));

// A trusted alert the server returns from alerts.get (the form does NOT carry these).
const TRUSTED_ALERT = {
  id: "alert-q-1",
  detector_id: "campaign_below_breakeven",
  severity: "high",
  status: "open",
  dollar_impact: 5000, // cents
  claude_rank: 1,
  created_at: "2026-06-21T00:00:00Z",
  title: "Campaign losing money",
  narrative: "ROAS below breakeven for 7 days",
  campaign: "Test Campaign",
  campaign_id: "camp-dim-uuid",
  campaign_external_id: "ext-123",
  sku: null,
  evidence: {},
};

function makeActionRequest(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://app.example.com/app/queue", {
    method: "POST",
    body: fd,
  });
}

function callAction(request: Request) {
  return action({ request, params: {} } as unknown as ActionFunctionArgs);
}

function callLoader(request?: Request) {
  return loader({
    request: request ?? new Request("https://app.example.com/app/queue"),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
}

beforeEach(() => {
  queueListSpy.mockReset();
  learnedRulesSpy.mockReset();
  recordRejectionSpy.mockReset();
  undoRuleSpy.mockReset();
  alertsGetSpy.mockReset();
  executeActionSpy.mockReset();
  recommendedActionSpy.mockReset();

  // Defaults
  queueListSpy.mockResolvedValue([]);
  learnedRulesSpy.mockResolvedValue([]);
  alertsGetSpy.mockResolvedValue(TRUSTED_ALERT);
  recommendedActionSpy.mockReturnValue("pause_campaign");
  recordRejectionSpy.mockResolvedValue({ reflection: "Got it -- I will be more careful here." });
  undoRuleSpy.mockResolvedValue(undefined);
  executeActionSpy.mockResolvedValue({ outcome: "succeeded" });
});

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------
describe("app.queue loader with learnedRules", () => {
  it("returns learnedRules from calibration.learnedRules()", async () => {
    const rule = {
      id: "rule-1",
      detector_id: "campaign_below_breakeven",
      action_kind: "pause_campaign",
      rule_kind: "muted_pair",
      summary: "I leave pause campaign on Campaign is losing money to you",
      created_at: "2026-06-21T00:00:00Z",
    };
    learnedRulesSpy.mockResolvedValue([rule]);
    queueListSpy.mockResolvedValue([]);

    const res = await callLoader();
    const payload = await (res as Response).json();

    expect(payload.learnedRules).toHaveLength(1);
    expect(payload.learnedRules[0].id).toBe("rule-1");
    expect(payload.error).toBeNull();
  });

  it("returns empty learnedRules on calibration.learnedRules() failure (fail-soft)", async () => {
    learnedRulesSpy.mockRejectedValue(new Error("db down"));
    queueListSpy.mockResolvedValue([]);

    const res = await callLoader();
    const payload = await (res as Response).json();

    // Primary proposals still succeed; learnedRules gracefully degrades.
    expect(payload.learnedRules).toHaveLength(0);
    expect(payload.error).toBeNull();
  });

  it("returns error + empty learnedRules when queue.list fails", async () => {
    queueListSpy.mockRejectedValue(
      Object.assign(new Error("db down"), { code: "DB_ERROR" }),
    );
    learnedRulesSpy.mockResolvedValue([]);

    const res = await callLoader();
    const payload = await (res as Response).json();

    expect(payload.proposals).toHaveLength(0);
    expect(payload.learnedRules).toHaveLength(0);
    expect(payload.error?.code).toBe("DB_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Action: intent=reject
// ---------------------------------------------------------------------------
describe("app.queue action -- reject intent", () => {
  it("calls recordRejection with RE-DERIVED detector/actionKind/impact from the trusted alert, not the form", async () => {
    // NOTE: the form sends alertId + reason only. The action must call alerts.get
    // and use those values -- detector_id, actionKind (via recommendedAction), dollar_impact.
    const res = await callAction(
      makeActionRequest({
        intent: "reject",
        alertId: "alert-q-1",
        reason: "too_aggressive",
        // Attacker supplies wrong values -- action must ignore them.
        detectorId: "wrong_detector",
        actionKind: "resume_campaign",
        dollar_impact: "999999",
      }),
    );

    expect(alertsGetSpy).toHaveBeenCalledWith("alert-q-1");
    // recommendedAction is called with the alert's detector_id and hasCampaign from alert.campaign_id
    expect(recommendedActionSpy).toHaveBeenCalledWith(
      "campaign_below_breakeven",
      { hasCampaign: true },
    );
    expect(recordRejectionSpy).toHaveBeenCalledWith({
      alertId: "alert-q-1",
      detectorId: "campaign_below_breakeven", // re-derived from trusted alert
      actionKind: "pause_campaign",           // re-derived via recommendedAction
      reason: "too_aggressive",
      note: undefined,
      dollarImpactCents: 5000,               // re-derived from trusted alert
    });

    const body = await (res as Response).json();
    expect(body.reflection).toBe("Got it -- I will be more careful here.");
  });

  it("passes the optional note when reason is 'other'", async () => {
    const res = await callAction(
      makeActionRequest({
        intent: "reject",
        alertId: "alert-q-1",
        reason: "other",
        note: "My brand does not fit this approach",
      }),
    );

    expect(recordRejectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "other", note: "My brand does not fit this approach" }),
    );
    const body = await (res as Response).json();
    expect(body.reflection).toBeDefined();
  });

  it("returns 400 for an invalid reason", async () => {
    const res = await callAction(
      makeActionRequest({
        intent: "reject",
        alertId: "alert-q-1",
        reason: "not_a_real_reason",
      }),
    );

    expect(res.status).toBe(400);
    const body = await (res as Response).json();
    expect(body.error).toBeDefined();
    // Must not have called recordRejection or any executor.
    expect(recordRejectionSpy).not.toHaveBeenCalled();
    expect(executeActionSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when alertId is missing", async () => {
    const res = await callAction(
      makeActionRequest({
        intent: "reject",
        reason: "wrong_timing",
        // no alertId
      }),
    );

    expect(res.status).toBe(400);
    expect(recordRejectionSpy).not.toHaveBeenCalled();
  });

  it("NEVER calls actions.execute (reject executes nothing)", async () => {
    await callAction(
      makeActionRequest({
        intent: "reject",
        alertId: "alert-q-1",
        reason: "not_enough_data",
      }),
    );

    // The critical invariant: no executor was called.
    expect(executeActionSpy).not.toHaveBeenCalled();
  });

  it("handles hasCampaign=false when alert.campaign_id is null", async () => {
    alertsGetSpy.mockResolvedValue({
      ...TRUSTED_ALERT,
      campaign_id: null,
      campaign_external_id: null,
    });
    recommendedActionSpy.mockReturnValue("exclude_sku_free_ship");

    await callAction(
      makeActionRequest({
        intent: "reject",
        alertId: "alert-q-1",
        reason: "i_handle_this",
      }),
    );

    expect(recommendedActionSpy).toHaveBeenCalledWith(
      expect.any(String),
      { hasCampaign: false }, // campaign_id was null
    );
  });
});

// ---------------------------------------------------------------------------
// Action: intent=undo-rule
// ---------------------------------------------------------------------------
describe("app.queue action -- undo-rule intent", () => {
  it("calls undoRule with the ruleId and returns { ok: true }", async () => {
    const res = await callAction(
      makeActionRequest({
        intent: "undo-rule",
        ruleId: "rule-abc-123",
      }),
    );

    expect(undoRuleSpy).toHaveBeenCalledWith("rule-abc-123");
    const body = await (res as Response).json();
    expect(body.ok).toBe(true);
  });

  it("returns 400 when ruleId is missing", async () => {
    const res = await callAction(
      makeActionRequest({
        intent: "undo-rule",
        // no ruleId
      }),
    );

    expect(res.status).toBe(400);
    expect(undoRuleSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Action: unknown intent
// ---------------------------------------------------------------------------
describe("app.queue action -- unknown intent", () => {
  it("returns 400 for an unknown intent", async () => {
    const res = await callAction(
      makeActionRequest({ intent: "fly-to-moon" }),
    );

    expect(res.status).toBe(400);
    expect(recordRejectionSpy).not.toHaveBeenCalled();
    expect(undoRuleSpy).not.toHaveBeenCalled();
  });
});
