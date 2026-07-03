import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeVerifyToken = vi.fn();
const markEmailVerified = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/auth/verify.server", () => ({ consumeVerifyToken, markEmailVerified }));
const getSessionFromRequest = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
}));

beforeEach(() => {
  getSessionFromRequest.mockReset().mockResolvedValue(null);
});

function get(t: string) { return new Request(`https://app.x/dashboard/verify?t=${t}`); }

describe("verify consume route", () => {
  it("redirects to /dashboard on a valid token and marks verified", async () => {
    consumeVerifyToken.mockResolvedValue({ userId: "u1" });
    const { loader } = await import("../dashboard.verify");
    const res = (await loader({ request: get("good") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(markEmailVerified).toHaveBeenCalledWith("u1");
  });

  it("renders an error (no redirect) for an invalid token", async () => {
    consumeVerifyToken.mockResolvedValue(null);
    const { loader } = await import("../dashboard.verify");
    const res = await loader({ request: get("bad") } as never);
    expect((res as { ok?: boolean }) && (res as Response).status).not.toBe(302);
  });

  it("reports hasSession:false for an expired link opened with no session (cross-device)", async () => {
    consumeVerifyToken.mockResolvedValue(null);
    getSessionFromRequest.mockResolvedValue(null);
    const { loader } = await import("../dashboard.verify");
    const res = (await loader({ request: get("bad") } as never)) as { ok: boolean; hasSession: boolean };
    expect(res).toEqual({ ok: false, hasSession: false });
  });

  it("reports hasSession:true for an expired link opened in a signed-in browser", async () => {
    consumeVerifyToken.mockResolvedValue(null);
    getSessionFromRequest.mockResolvedValue({ sessionId: "s1", userId: "u1", shopId: "sh1", emailVerified: false });
    const { loader } = await import("../dashboard.verify");
    const res = (await loader({ request: get("bad") } as never)) as { ok: boolean; hasSession: boolean };
    expect(res).toEqual({ ok: false, hasSession: true });
  });
});
