// app/routes/__tests__/dashboard-reallocate-budget-route.test.ts
// Regression for the reallocate_budget critical fix: on a succeeded (or
// retrying) executeReallocation outcome the route must acknowledge the alert
// (open -> acknowledged) so it leaves the queue and can't be re-approved into
// a second budget move. On a failed outcome it must NOT acknowledge.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action as alertAction } from "../dashboard.api.alerts.$id.action";
import type * as HttpServer from "~/lib/dashboard/http.server";
import type * as CalderynServer from "~/lib/calderyn.server";

const requireDashboardSession = vi.fn();
const executeReallocation = vi.fn();
const acknowledgeAlert = vi.fn();
const alertsGetSpy = vi.fn();
const recordApprovalSpy = vi.fn();
const recordActionFailureSpy = vi.fn();

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("~/lib/actions/po-action.server", () => ({ executeCreatePoDraft: vi.fn() }));
vi.mock("~/lib/actions/reallocate-sku.server", () => ({ executeReallocateSpendSku: vi.fn() }));
vi.mock("~/lib/actions/adjust-price.server", () => ({ executeAdjustPriceAlertAction: vi.fn() }));
vi.mock("~/lib/actions/alert-action.server", () => ({
  executeInventoryAlertAction: vi.fn(),
  executeDiscontinueAlertAction: vi.fn(),
}));
vi.mock("~/lib/actions/reallocate.server", () => ({
  executeReallocation: (...a: unknown[]) => executeReallocation(...a),
}));
vi.mock("~/lib/alerts.server", () => ({
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
  requireSameOrigin: vi.fn(),
}));
vi.mock("~/lib/calderyn.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CalderynServer>()),
  calderynClient: () => ({ alerts: { get: (...a: unknown[]) => alertsGetSpy(...a) } }),
}));
vi.mock("~/lib/calibration/approval.server", () => ({
  recordApproval: (...a: unknown[]) => recordApprovalSpy(...a),
}));
vi.mock("~/lib/calibration/failure.server", () => ({
  recordActionFailure: (...a: unknown[]) => recordActionFailureSpy(...a),
}));
vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })) },
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ mocked: true }) }));

function post(body: unknown): Request {
  return new Request("https://calderyncompany.com/dashboard/api/alerts/a1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}

const call = (body: unknown) =>
  alertAction({ request: post(body), params: { id: "a1" }, context: {} } as never) as Promise<Response>;

const REALLOC_ALERT = {
  id: "a1",
  detector_id: "weather_demand",
  evidence: {
    source_campaign_id: "camp-src-1",
    dest_campaign_id: "camp-dst-1",
    amount_cents: 5000,
  },
};

describe("POST /dashboard/api/alerts/:id/action — reallocate_budget acknowledges on success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "x.myshopify.com" });
    alertsGetSpy.mockResolvedValue(REALLOC_ALERT);
    recordApprovalSpy.mockResolvedValue({ delta: 1, before: 22, after: 23 });
    recordActionFailureSpy.mockResolvedValue(undefined);
  });

  it("acknowledges the alert when executeReallocation succeeds", async () => {
    executeReallocation.mockResolvedValue({ id: "audit-rb-1", outcome: "succeeded" });
    acknowledgeAlert.mockResolvedValue(true);

    const res = await call({ type: "reallocate_budget", idempotency_key: "krb-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-rb-1",
      outcome: "succeeded",
      acknowledged: true,
      calibration: { delta: 1, before: 22, after: 23 },
    });
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        alertId: "a1",
        sourceCampaignId: "camp-src-1",
        destCampaignId: "camp-dst-1",
        amountCents: 5000,
        idempotencyKey: "krb-1",
        actor: "merchant:web-dashboard",
      }),
      expect.anything(),
    );
    expect(acknowledgeAlert).toHaveBeenCalledWith(expect.anything(), "shop-1", "a1");
  });

  it("acknowledges the alert when executeReallocation is retrying (transient, not terminal)", async () => {
    executeReallocation.mockResolvedValue({ id: "audit-rb-2", outcome: "retrying" });
    acknowledgeAlert.mockResolvedValue(true);

    const res = await call({ type: "reallocate_budget", idempotency_key: "krb-2" });
    const body = (await res.json()) as { acknowledged: boolean; outcome: string };
    expect(body.outcome).toBe("retrying");
    expect(body.acknowledged).toBe(true);
    expect(acknowledgeAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT acknowledge the alert when executeReallocation fails — prevents a double budget move on re-approve", async () => {
    executeReallocation.mockResolvedValue({ id: "audit-rb-3", outcome: "failed" });

    const res = await call({ type: "reallocate_budget", idempotency_key: "krb-3" });
    const body = (await res.json()) as { acknowledged: boolean; outcome: string };
    expect(body.outcome).toBe("failed");
    expect(body.acknowledged).toBe(false);
    expect(acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("422s (never 200) when the alert carries no reallocation plan — the throw backstop", async () => {
    // ad_tax_overload also lists reallocate_budget but carries no plan in evidence.
    // The backstop must throw (a returned Response inside dashboardJson wraps as
    // 200); a thrown Response rejects the action promise, which Remix turns into
    // the real HTTP response — so capture it from the rejection here.
    alertsGetSpy.mockResolvedValue({ id: "a1", detector_id: "ad_tax_overload", evidence: {} });

    const res = (await call({ type: "reallocate_budget", idempotency_key: "krb-4" }).catch(
      (e: unknown) => e,
    )) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(422);
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(acknowledgeAlert).not.toHaveBeenCalled();
  });
});
