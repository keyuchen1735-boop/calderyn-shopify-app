import { describe, it, expect, vi, beforeEach } from "vitest";
import { jwtVerify } from "jose";

const requireDashboardSession = vi.fn();
vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));

import { loader } from "../../../routes/dashboard.api.realtime-token";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = "super-secret-jwt-key-for-tests-32chars";
  requireDashboardSession.mockResolvedValue({
    shopId: "11111111-2222-3333-4444-555555555555",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/realtime-token", () => {
  it("mints a 1h authenticated JWT carrying the shop_id claim", async () => {
    const res = (await loader({
      request: new Request("https://calderyncompany.com/dashboard/api/realtime-token"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };

    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET),
    );
    expect(payload.role).toBe("authenticated");
    expect(payload.shop_id).toBe("11111111-2222-3333-4444-555555555555");
    const ttlMs = (payload.exp! * 1000) - Date.now();
    expect(ttlMs).toBeGreaterThan(55 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60_000);
    expect(new Date(expires_at).getTime()).toBeCloseTo(payload.exp! * 1000, -3);
  });

  it("503s when SUPABASE_JWT_SECRET is not configured", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const res = (await loader({
      request: new Request("https://calderyncompany.com/dashboard/api/realtime-token"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(503);
  });
});
