import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
}));
const latestImport = vi.fn();
const startImport = vi.fn();
const kickDrainSoon = vi.fn(async () => undefined);
vi.mock("~/lib/import/run.server", () => ({ latestImport, startImport, kickDrainSoon }));

describe("import route", () => {
  it("GET returns the latest run for the shop", async () => {
    latestImport.mockResolvedValue({ id: "r1", state: "done", counts: null, report: null, error: null, startedAt: "t", finishedAt: "t" });
    const { loader } = await import("../dashboard.api.import");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: expect.objectContaining({ id: "r1", state: "done" }) });
    expect(latestImport).toHaveBeenCalledWith("shop1");
  });

  it("POST starts an import for the shop", async () => {
    startImport.mockResolvedValue({ importId: "imp_9" });
    const { action } = await import("../dashboard.api.import");
    const res = (await action({ request: new Request("https://app.x/x", { method: "POST" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ importId: "imp_9" });
    expect(startImport).toHaveBeenCalledWith("shop1");
    // The manual button gets the same instant-drain nudge as the OAuth connect.
    expect(kickDrainSoon).toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const { action } = await import("../dashboard.api.import");
    const res = (await action({ request: new Request("https://app.x/x", { method: "DELETE" }) } as never)) as Response;
    expect(res.status).toBe(405);
  });
});
