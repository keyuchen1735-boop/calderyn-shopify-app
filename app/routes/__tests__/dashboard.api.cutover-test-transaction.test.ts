import { describe, it, expect, vi, beforeEach } from "vitest";

import { action } from "../dashboard.api.cutover-test-transaction";

const h = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  startTestTransaction: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: h.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("~/lib/dashboard/http.server");
  return { ...actual, requireSameOrigin: h.requireSameOrigin };
});
vi.mock("~/lib/cutover/test-transaction.server", () => ({ startTestTransaction: h.startTestTransaction }));

describe("POST /dashboard/api/cutover-test-transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requireDashboardSession.mockResolvedValue({ shopId: "shop-1" });
    h.startTestTransaction.mockResolvedValue({ url: "https://stripe/pay" });
  });

  it("returns the stripe checkout url", async () => {
    const req = new Request("http://x/dashboard/api/cutover-test-transaction", { method: "POST" });
    const res = await action({ request: req } as never);
    expect(await res.json()).toEqual({ url: "https://stripe/pay" });
  });

  it("returns 405 for non-POST", async () => {
    const req = new Request("http://x/dashboard/api/cutover-test-transaction", { method: "GET" });
    const res = await action({ request: req } as never);
    expect(res.status).toBe(405);
  });

  it("maps a guard failure to a 400 carrying the message", async () => {
    h.startTestTransaction.mockRejectedValue(new Error("Connect Stripe before running a test transaction."));
    const req = new Request("http://x/dashboard/api/cutover-test-transaction", { method: "POST" });
    const res = await action({ request: req } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/Connect Stripe/);
  });
});
