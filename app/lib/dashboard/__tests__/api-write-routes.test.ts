import { describe, it, expect, vi, beforeEach } from "vitest";

import { action as campaignAction } from "../../../routes/dashboard.api.campaigns.$id.action";
import { action as undoRoute } from "../../../routes/dashboard.api.audit.$id.undo";
import { action as guardrailsAction } from "../../../routes/dashboard.api.guardrails";
import { action as logoutAction } from "../../../routes/dashboard.api.logout";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeAction = vi.fn();
const undoAction = vi.fn();
const guardrailsUpdate = vi.fn();
const revokeSession = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
  revokeSession: (...a: unknown[]) => revokeSession(...a),
}));
vi.mock("../http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http.server")>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeAction(...a),
}));
vi.mock("../../actions/undo.server", () => ({
  undoAction: (...a: unknown[]) => undoAction(...a),
}));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      guardrails: {
        get: vi.fn(async () => ({ cooldown_minutes: 30 })),
        update: (...a: unknown[]) => guardrailsUpdate(...a),
      },
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

function post(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}

describe("POST /dashboard/api/campaigns/:id/action", () => {
  it("executes a pause through the shared action pipeline", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-1", outcome: "succeeded" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "key-1",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-1", outcome: "succeeded" });
    expect(executeAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        kind: "pause_campaign",
        campaignId: "c1",
        idempotencyKey: "key-1",
        actor: "merchant:web-dashboard",
      }),
      expect.anything(),
    );
  });

  it("422s on a bad action type and on a missing budget for budget changes", async () => {
    for (const body of [
      { type: "delete_campaign", idempotency_key: "k" },
      { type: "reduce_campaign_budget", idempotency_key: "k" },
    ]) {
      const res = (await campaignAction({
        request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", body),
        params: { id: "c1" },
        context: {},
      })) as Response;
      expect(res.status).toBe(422);
    }
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("returns 502 with the audit id when the platform call failed", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-2", outcome: "failed" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "k2",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "action_failed",
      audit_id: "audit-2",
      outcome: "failed",
    });
  });
});

describe("PUT /dashboard/api/guardrails", () => {
  it("applies the patch via calderynClient.guardrails.update", async () => {
    guardrailsUpdate.mockResolvedValueOnce({ cooldown_minutes: 45 });
    const res = (await guardrailsAction({
      request: post(
        "https://calderyncompany.com/dashboard/api/guardrails",
        { cooldown_minutes: 45 },
        "PUT",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(guardrailsUpdate).toHaveBeenCalledWith({ cooldown_minutes: 45 });
  });

  it("405s non-PUT methods", async () => {
    const res = (await guardrailsAction({
      request: post("https://calderyncompany.com/dashboard/api/guardrails", {}, "PATCH"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(405);
  });
});

describe("POST /dashboard/api/audit/:id/undo", () => {
  it("delegates to undoAction with the session's shop", async () => {
    undoAction.mockResolvedValueOnce({ id: "audit-3" });
    const res = (await undoRoute({
      request: post("https://calderyncompany.com/dashboard/api/audit/a1/undo", {}),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-3" });
    expect(undoAction).toHaveBeenCalledWith("shop-1", "a1", expect.anything());
  });
});

describe("POST /dashboard/api/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const res = (await logoutAction({
      request: post("https://calderyncompany.com/dashboard/api/logout", {}),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith("sess-1");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
