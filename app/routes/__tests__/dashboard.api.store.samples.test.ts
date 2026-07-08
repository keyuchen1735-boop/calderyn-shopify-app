import { describe, it, expect, vi, beforeEach } from "vitest";

const clearMock = vi.hoisted(() => vi.fn());

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: async () => ({ shopId: "3f0e8f5e-0000-4000-8000-000000000000" }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: () => "app",
  dashboardJson: async (fn: () => Promise<unknown>) =>
    new Response(JSON.stringify(await fn()), { status: 200, headers: { "content-type": "application/json" } }),
}));
vi.mock("~/lib/storegen/seed.server", () => ({ clearSampleProducts: clearMock }));

// eslint-disable-next-line import/first -- vitest hoists the vi.mock calls above this import
import { action } from "../dashboard.api.store.samples";

const req = () => new Request("http://x/dashboard/api/store/samples", { method: "POST" });

beforeEach(() => clearMock.mockReset());

describe("clear samples action", () => {
  it("archives the session shop's samples and returns the removed count", async () => {
    clearMock.mockResolvedValue(2);
    const res = await action({ request: req(), params: {}, context: {} } as never);
    expect(await (res as Response).json()).toEqual({ removed: 2 });
    // Tenant comes from the session, never the request body.
    expect(clearMock).toHaveBeenCalledWith("3f0e8f5e-0000-4000-8000-000000000000");
  });
  // Failure shaping (a thrown clear → clean error, never a false success) is dashboardJson's
  // contract, covered by the catalog-route tests; clearSampleProducts throwing on a tag-query
  // error is covered in app/lib/storegen/seed.server.test.ts (rule 12).
});
