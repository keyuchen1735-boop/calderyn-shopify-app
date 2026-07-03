// Route contract for POST /dashboard/api/demo-reset: same-origin + session
// gated, POST-only, rate-limited, and surfaces the orchestrator's
// not_demo_shop refusal as the 409 the Settings button renders verbatim.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CalderynError } from "../../lib/calderyn.server";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const rateLimit = vi.fn();
const resetDemoShowcase = vi.fn();

vi.mock("../../lib/dashboard/session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/dashboard/session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/dashboard/http.server")>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../lib/rate-limit.server", () => ({
  rateLimit: (...a: unknown[]) => rateLimit(...a),
}));
vi.mock("../../lib/supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("../../lib/demo/reset.server", () => ({
  resetDemoShowcase: (...a: unknown[]) => resetDemoShowcase(...a),
}));

import { action } from "../dashboard.api.demo-reset";

function post(method = "POST"): Request {
  return new Request("https://app.example.com/dashboard/api/demo-reset", { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({ shopId: "shop-1", userId: "user-1" });
  rateLimit.mockResolvedValue(true);
});

describe("dashboard.api.demo-reset action", () => {
  it("rejects non-POST", async () => {
    const res = (await action({ request: post("DELETE"), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(405);
  });

  it("rate-limits repeat resets", async () => {
    rateLimit.mockResolvedValue(false);
    const res = (await action({ request: post(), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(429);
    expect(resetDemoShowcase).not.toHaveBeenCalled();
  });

  it("returns the reset summary for a demo shop", async () => {
    resetDemoShowcase.mockResolvedValue({ wiped: ["orders"], inserted: { alerts: 18 }, promoted: {} });
    const res = (await action({ request: post(), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { inserted: { alerts: number } } };
    expect(body.ok).toBe(true);
    expect(body.summary.inserted.alerts).toBe(18);
    expect(resetDemoShowcase).toHaveBeenCalledWith("shop-1", expect.anything());
  });

  it("maps the orchestrator's refusal to 409 not_demo_shop", async () => {
    resetDemoShowcase.mockRejectedValue(
      new CalderynError({ code: "not_demo_shop", status: 409, message: "Demo reset is only available on demo shops." }),
    );
    const res = (await action({ request: post(), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_demo_shop");
  });
});
