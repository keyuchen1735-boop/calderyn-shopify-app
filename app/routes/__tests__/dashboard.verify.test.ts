import { describe, it, expect, vi } from "vitest";

const consumeVerifyToken = vi.fn();
const markEmailVerified = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/auth/verify.server", () => ({ consumeVerifyToken, markEmailVerified }));

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
});
