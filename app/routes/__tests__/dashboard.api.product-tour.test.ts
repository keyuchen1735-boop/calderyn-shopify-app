import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { action } from "../dashboard.api.product-tour";

const { sessionMock, recordMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...args: unknown[]) => sessionMock(...args),
}));
vi.mock("~/lib/dashboard/product-tour.server", () => ({
  recordProductTourOutcome: (...args: unknown[]) => recordMock(...args),
}));

const ORIGIN = "https://calderyncompany.com";

function post(intent: unknown, origin = ORIGIN, method = "POST") {
  return new Request(`${ORIGIN}/dashboard/api/product-tour`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ intent }),
  });
}

function run(request: Request) {
  return action({
    request,
    params: {},
    context: {},
  } as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  sessionMock.mockReset().mockResolvedValue({ userId: "u1", shopId: "s1" });
  recordMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /dashboard/api/product-tour", () => {
  it.each(["complete", "skip"] as const)(
    "records a %s outcome for the signed-in user",
    async (intent) => {
      const response = await run(post(intent));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(recordMock).toHaveBeenCalledWith("u1", intent);
    },
  );

  it("rejects unknown outcomes", async () => {
    const response = await run(post("later"));
    expect(response.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects legacy shop sessions", async () => {
    sessionMock.mockResolvedValueOnce({ userId: null, shopId: "s1" });
    const response = await run(post("complete"));
    expect(response.status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes", async () => {
    const response = await run(post("skip", "https://evil.example")).catch(
      (error) => error as Response,
    );
    expect(response.status).toBe(403);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("surfaces persistence failures", async () => {
    recordMock.mockRejectedValueOnce(new Error("db unavailable"));
    const response = await run(post("skip"));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("save_failed");
  });
});
