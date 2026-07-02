// I8 mute interstitial — contract test for the dashboard reject endpoint:
// muting a shipped no-brainer (i_handle_this) 409s with confirm_required and
// records NOTHING until re-sent with confirmed=true; normal pairs and other
// reasons are unaffected.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const { alertsGetSpy, recordRejectionSpy, requireDashboardSessionSpy } = vi.hoisted(() => ({
  alertsGetSpy: vi.fn(),
  recordRejectionSpy: vi.fn(),
  requireDashboardSessionSpy: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSessionSpy(...a),
}));
vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) },
    calibration: { recordRejection: (...a: unknown[]) => recordRejectionSpy(...a) },
  }),
}));

const ORIGIN = "https://app.example.test";
vi.stubEnv("SHOPIFY_APP_URL", ORIGIN);

// The route under test — imported after all mocks are registered.
const { action } = await import("../dashboard.api.queue.reject");

// campaign_below_breakeven + pause_campaign is a shipped NO_BRAINER pair.
const NB_ALERT = {
  id: "al-nb",
  detector_id: "campaign_below_breakeven",
  campaign_id: "camp-1",
  dollar_impact: 4000,
};
// ad_tax_overload + a campaign recommends a budget move — a normal pair.
const NORMAL_ALERT = {
  id: "al-norm",
  detector_id: "ad_tax_overload",
  campaign_id: "camp-1",
  dollar_impact: 2000,
};

function call(body: Record<string, unknown>) {
  // Remix surfaces jsonError responses by THROWING them from the action —
  // catch and return, exactly as the framework would hand them to the client.
  return (
    action({
      request: new Request(`${ORIGIN}/dashboard/api/queue/reject`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs) as Promise<Response>
  ).catch((e) => {
    if (e instanceof Response) return e;
    throw e;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSessionSpy.mockResolvedValue({ shopId: "shop-1" });
  alertsGetSpy.mockResolvedValue(NB_ALERT);
  recordRejectionSpy.mockResolvedValue({
    reflection: "ok",
    delta: -1,
    before: 74,
    after: 73,
    savedAsRule: true,
    ruleKind: "muted_pair",
  });
});

describe("dashboard queue reject — I8 mute interstitial", () => {
  it("409s with confirm_required and records NOTHING when muting a no-brainer unconfirmed", async () => {
    const res = await call({ alertId: "al-nb", reason: "i_handle_this" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("confirm_required");
    expect(String(body.message)).toContain("protection");
    expect(recordRejectionSpy).not.toHaveBeenCalled();
  });

  it("records the mute when re-sent with confirmed=true", async () => {
    const res = await call({ alertId: "al-nb", reason: "i_handle_this", confirmed: true });
    expect(res.status).toBe(200);
    expect(recordRejectionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "al-nb", reason: "i_handle_this" }),
    );
  });

  it("does NOT interstitial a normal pair — one-step mute as before", async () => {
    alertsGetSpy.mockResolvedValue(NORMAL_ALERT);
    const res = await call({ alertId: "al-norm", reason: "i_handle_this" });
    expect(res.status).toBe(200);
    expect(recordRejectionSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT interstitial other reasons on a no-brainer", async () => {
    const res = await call({ alertId: "al-nb", reason: "too_aggressive" });
    expect(res.status).toBe(200);
    expect(recordRejectionSpy).toHaveBeenCalledTimes(1);
  });
});
