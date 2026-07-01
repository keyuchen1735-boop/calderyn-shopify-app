import { describe, it, expect, vi, beforeEach } from "vitest";
import { CutoverBlockedError } from "~/lib/cutover/errors";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1" }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string, m?: string) =>
    new Response(JSON.stringify(m ? { error: e, message: m } : { error: e }), { status: s }),
  dashboardJson: async (fn: () => Promise<unknown>) =>
    new Response(JSON.stringify(await fn()), { status: 200 }),
}));

const getOrgMode = vi.fn();
const transitionOrgMode = vi.fn();
vi.mock("~/lib/cutover/org-mode.server", () => ({
  getOrgMode: (shopId: string) => getOrgMode(shopId),
  transitionOrgMode: (shopId: string, to: string, reason?: string) =>
    transitionOrgMode(shopId, to, reason),
  // Real vocabulary/adjacency, restated: the route only needs membership + lookup.
  isOrgMode: (v: string) => ["mirror", "importing", "dual_run", "live"].includes(v),
  LEGAL_ORG_TRANSITIONS: {
    mirror: ["importing"],
    importing: ["dual_run", "mirror"],
    dual_run: ["live", "mirror"],
    live: ["dual_run"],
  },
}));

const checkGoLiveGates = vi.fn();
vi.mock("~/lib/cutover/go-live.server", () => ({
  checkGoLiveGates: (shopId: string) => checkGoLiveGates(shopId),
}));

const PASSING_GATES = { pass: true, checks: [] };

function post(body: unknown): Request {
  return new Request("https://app.x/x", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgMode.mockResolvedValue("dual_run");
  checkGoLiveGates.mockResolvedValue(PASSING_GATES);
});

describe("cutover route", () => {
  it("GET returns mode, legal next moves, and the gate report", async () => {
    const { loader } = await import("../dashboard.api.cutover");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "dual_run",
      allowed: ["live", "mirror"],
      gates: PASSING_GATES,
    });
    expect(getOrgMode).toHaveBeenCalledWith("shop1");
    expect(checkGoLiveGates).toHaveBeenCalledWith("shop1");
  });

  it("POST transitions and returns the fresh status", async () => {
    transitionOrgMode.mockResolvedValue({ id: "t1" });
    getOrgMode.mockResolvedValueOnce("live");
    const { action } = await import("../dashboard.api.cutover");
    const res = (await action({ request: post({ to: "live", reason: "pilot" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(transitionOrgMode).toHaveBeenCalledWith("shop1", "live", "pilot");
    expect(await res.json()).toMatchObject({ mode: "live" });
  });

  it("POST surfaces a blocked transition as 409 with the exact message", async () => {
    transitionOrgMode.mockRejectedValue(
      new CutoverBlockedError("go-live blocked: 1 gate check(s) failing: paid_order"),
    );
    const { action } = await import("../dashboard.api.cutover");
    const res = (await action({ request: post({ to: "live" }) } as never)) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "cutover_blocked",
      message: "go-live blocked: 1 gate check(s) failing: paid_order",
    });
  });

  it("POST surfaces a system failure as 500 without leaking the raw error", async () => {
    transitionOrgMode.mockRejectedValue(new Error("connection to db failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { action } = await import("../dashboard.api.cutover");
      const res = (await action({ request: post({ to: "live" }) } as never)) as Response;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("POST rejects an unknown target mode with 422", async () => {
    const { action } = await import("../dashboard.api.cutover");
    const res = (await action({ request: post({ to: "warp" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(transitionOrgMode).not.toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const { action } = await import("../dashboard.api.cutover");
    const res = (await action({
      request: new Request("https://app.x/x", { method: "DELETE" }),
    } as never)) as Response;
    expect(res.status).toBe(405);
  });
});
