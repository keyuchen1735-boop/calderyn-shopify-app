// Regression test for the serverless-safe calibration signal in
// dashboard.api.campaigns.$id.action.tsx.
//
// The defect (fixed): the signal was dispatched as an un-awaited .then() chain
// just before the return. On Vercel serverless, promises not awaited before the
// Response is returned are abandoned when the function cold-freezes, so the
// alpha bump silently never ran in prod.
//
// The fix: await client.alerts.get(alertId) before the return, matching the
// pattern in dashboard.api.alerts.$id.action.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

// Hoisted spies
const { recordApprovalSpy, alertsGetSpy, executeActionSpy, requireDashboardSessionSpy } =
  vi.hoisted(() => ({
    recordApprovalSpy: vi.fn(),
    alertsGetSpy: vi.fn(),
    executeActionSpy: vi.fn(),
    requireDashboardSessionSpy: vi.fn(),
  }));

// Dashboard session — the only auth boundary for this route
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSessionSpy(...a),
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) },
  }),
}));

vi.mock("~/lib/calibration/approval.server", () => ({
  recordApproval: (...a: unknown[]) => recordApprovalSpy(...a),
}));

vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeActionSpy(...a),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: vi.fn(() => ({ __fake: "sb" })),
}));

// requireSameOrigin reads DASHBOARD_PUBLIC_URL / SHOPIFY_APP_URL; stub both so
// the CSRF guard passes without touching the real env.
const ORIGIN = "https://app.example.test";
vi.stubEnv("SHOPIFY_APP_URL", ORIGIN);

// The route under test — imported after all mocks are registered.
const { action } = await import("../dashboard.api.campaigns.$id.action");

const SHOP_ID = "shop-uuid-campaigns-cal";
const SHOP_DOMAIN = "calibration-test.myshopify.com";
const CAMPAIGN_ID = "camp-dim-uuid-1";
const ALERT_ID = "alert-uuid-cal-1";

const ALERT = {
  id: ALERT_ID,
  detector_id: "campaign_below_breakeven",
  severity: "high",
  status: "open",
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/dashboard/api/campaigns/${CAMPAIGN_ID}/action`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(body: Record<string, unknown>) {
  return action({
    request: makeRequest(body),
    params: { id: CAMPAIGN_ID },
    context: {},
  } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSessionSpy.mockResolvedValue({
    shopId: SHOP_ID,
    shopDomain: SHOP_DOMAIN,
    sessionId: "session-uuid-1",
  });
  executeActionSpy.mockResolvedValue({ id: "audit-uuid-1", outcome: "succeeded" });
  alertsGetSpy.mockResolvedValue(ALERT);
  recordApprovalSpy.mockResolvedValue(undefined);
});

describe("dashboard.api.campaigns.$id.action — calibration signal (serverless-safe)", () => {
  it("calls recordApproval with detector_id + kind when outcome=succeeded and alertId present", async () => {
    const res = await call({
      type: "pause_campaign",
      idempotency_key: "idem-key-1",
      alert_id: ALERT_ID,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit_id: string; outcome: string };
    expect(body.outcome).toBe("succeeded");

    // Signal must have been awaited — if it weren't, it would be abandoned and
    // this assertion would flake / fail on the first serverless cold-flush.
    expect(alertsGetSpy).toHaveBeenCalledWith(ALERT_ID);
    expect(recordApprovalSpy).toHaveBeenCalledTimes(1);
    expect(recordApprovalSpy).toHaveBeenCalledWith(
      SHOP_ID,
      "campaign_below_breakeven",
      "pause_campaign",
      expect.anything(), // supabase client
    );
  });

  it("does NOT call recordApproval when outcome=failed", async () => {
    executeActionSpy.mockResolvedValue({ id: "audit-uuid-2", outcome: "failed" });

    const res = await call({
      type: "pause_campaign",
      idempotency_key: "idem-key-2",
      alert_id: ALERT_ID,
    });

    // Failed outcome returns a 502
    expect(res.status).toBe(502);
    expect(recordApprovalSpy).not.toHaveBeenCalled();
    expect(alertsGetSpy).not.toHaveBeenCalled();
  });

  it("does NOT call recordApproval when there is no alert_id (standalone campaign action)", async () => {
    const res = await call({
      type: "reduce_campaign_budget",
      idempotency_key: "idem-key-3",
      daily_budget_cents: 1000,
      // no alert_id
    });

    expect(res.status).toBe(200);
    expect(alertsGetSpy).not.toHaveBeenCalled();
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });

  it("does NOT call recordApproval when the alert lookup fails (graceful guard)", async () => {
    alertsGetSpy.mockRejectedValue(new Error("not found"));

    const res = await call({
      type: "resume_campaign",
      idempotency_key: "idem-key-4",
      alert_id: ALERT_ID,
    });

    // Action still succeeds — signal failure must never affect the result
    expect(res.status).toBe(200);
    expect(recordApprovalSpy).not.toHaveBeenCalled();
  });
});
