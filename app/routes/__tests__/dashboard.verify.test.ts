import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeVerifyToken = vi.fn();
const markEmailVerified = vi.fn().mockResolvedValue(undefined);
const peekVerifyToken = vi.fn();
vi.mock("~/lib/auth/verify.server", () => ({ consumeVerifyToken, markEmailVerified, peekVerifyToken }));
const getSessionFromRequest = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
}));
vi.mock("~/lib/dashboard/http.server", () => ({ checkSameOrigin: () => null }));

beforeEach(() => {
  getSessionFromRequest.mockReset().mockResolvedValue(null);
  consumeVerifyToken.mockReset();
  peekVerifyToken.mockReset();
  markEmailVerified.mockClear();
});

function get(t: string) { return new Request(`https://app.x/dashboard/verify?t=${t}`); }
function post(token: string) {
  return new Request("https://app.x/dashboard/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

describe("verify route (POST-confirm, scanner-safe)", () => {
  it("GET only PEEKS a valid token (never consumes) and renders a confirm page", async () => {
    peekVerifyToken.mockResolvedValue(true);
    const { loader } = await import("../dashboard.verify");
    const res = await loader({ request: get("good") } as never);
    expect(res).toEqual({ ok: true, token: "good", hasSession: false });
    expect(consumeVerifyToken).not.toHaveBeenCalled();
  });

  it("POST consumes the token, marks verified, and redirects to /dashboard", async () => {
    consumeVerifyToken.mockResolvedValue({ userId: "u1" });
    const { action } = await import("../dashboard.verify");
    const res = (await action({ request: post("good") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(consumeVerifyToken).toHaveBeenCalledWith("good");
    expect(markEmailVerified).toHaveBeenCalledWith("u1");
  });

  it("GET on an expired link with no session reports hasSession:false (cross-device)", async () => {
    peekVerifyToken.mockResolvedValue(false);
    getSessionFromRequest.mockResolvedValue(null);
    const { loader } = await import("../dashboard.verify");
    const res = await loader({ request: get("bad") } as never);
    expect(res).toEqual({ ok: false, token: "", hasSession: false });
  });

  it("GET on an expired link in a signed-in browser reports hasSession:true", async () => {
    peekVerifyToken.mockResolvedValue(false);
    getSessionFromRequest.mockResolvedValue({ sessionId: "s1", userId: "u1", shopId: "sh1", emailVerified: false });
    const { loader } = await import("../dashboard.verify");
    const res = await loader({ request: get("bad") } as never);
    expect(res).toEqual({ ok: false, token: "", hasSession: true });
  });

  it("POST on an already-consumed token does not redirect or re-verify", async () => {
    consumeVerifyToken.mockResolvedValue(null);
    getSessionFromRequest.mockResolvedValue(null);
    const { action } = await import("../dashboard.verify");
    const res = await action({ request: post("bad") } as never);
    expect((res as Response).status ?? 0).not.toBe(302);
    expect(markEmailVerified).not.toHaveBeenCalled();
  });
});
