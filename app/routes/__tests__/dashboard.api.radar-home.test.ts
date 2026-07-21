import { beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "11111111-2222-3333-4444-555555555555";
const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  listMoves: vi.fn(),
  readRadarState: vi.fn(),
  stampRadarState: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  parseJsonObjectBody: async (request: Request) => request.json().catch(() => null),
}));
vi.mock("~/lib/radar/store.server", () => ({
  listMoves: mocks.listMoves,
  readRadarState: mocks.readRadarState,
  stampRadarState: mocks.stampRadarState,
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader, action } from "../dashboard.api.radar-home";

function get() {
  return { request: new Request("https://x/dashboard/api/radar-home"), params: {}, context: {} } as never;
}
function post(body: unknown) {
  return {
    request: new Request("https://x/dashboard/api/radar-home", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    params: {}, context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  mocks.stampRadarState.mockResolvedValue(undefined);
});

describe("loader", () => {
  it("counts ready moves; an old dismissal is beaten by a newer move", async () => {
    mocks.listMoves.mockResolvedValue([
      { createdAt: "2026-07-20T09:00:00Z" }, { createdAt: "2026-07-19T09:00:00Z" },
    ]);
    mocks.readRadarState.mockResolvedValue({ homeCardDismissedAt: "2026-07-19T12:00:00Z", lastCollectedAt: null, lastDraftedAt: null });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 2, dismissed: false });
  });
  it("stays dismissed while nothing newer arrived", async () => {
    mocks.listMoves.mockResolvedValue([{ createdAt: "2026-07-19T09:00:00Z" }]);
    mocks.readRadarState.mockResolvedValue({ homeCardDismissedAt: "2026-07-19T12:00:00Z", lastCollectedAt: null, lastDraftedAt: null });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 1, dismissed: true });
  });
  it("returns zero for demo shops without reads", async () => {
    mocks.requireDashboardSession.mockResolvedValue({ shopId: "demo-shop", userId: "u1" });
    const body = await ((await loader(get())) as Response).json();
    expect(body).toEqual({ readyCount: 0, dismissed: false });
    expect(mocks.listMoves).not.toHaveBeenCalled();
  });
});

describe("action", () => {
  it("persists the dismissal", async () => {
    const res = (await action(post({ intent: "dismiss" }))) as Response;
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, { homeCardDismissedAt: expect.any(String) });
  });
  it("422s an unknown intent", async () => {
    const res = (await action(post({ intent: "nope" }))) as Response;
    expect(res.status).toBe(422);
    expect(mocks.stampRadarState).not.toHaveBeenCalled();
  });
});
