import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SHOP = "11111111-2222-3333-4444-555555555555";
const MOVE_ID = "99999999-1111-2222-3333-444444444444";
const COMP_ID = "77777777-8888-9999-0000-111122223333";

const mocks = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  listMoves: vi.fn(),
  readRadarState: vi.fn(),
  applyMove: vi.fn(),
  dismissMove: vi.fn(),
  revertMove: vi.fn(),
  listCompetitors: vi.fn(),
  setCompetitorStatus: vi.fn(),
  listSnapshotTimeline: vi.fn(),
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: mocks.requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify({ error: e, message: m }), { status: s }),
}));
vi.mock("~/lib/radar/store.server", () => ({ listMoves: mocks.listMoves, readRadarState: mocks.readRadarState }));
vi.mock("~/lib/radar/apply.server", async () => {
  const { RadarApplyError } = await import("../../lib/radar/apply-seo.server");
  return {
    applyMove: mocks.applyMove,
    dismissMove: mocks.dismissMove,
    revertMove: mocks.revertMove,
    RadarApplyError,
  };
});
vi.mock("~/lib/radar/apply-seo.server", async (importActual) => (await importActual()) as Record<string, unknown>);
vi.mock("~/lib/radar/competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompetitors: mocks.listCompetitors,
  setCompetitorStatus: mocks.setCompetitorStatus,
  listSnapshotTimeline: mocks.listSnapshotTimeline,
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader, action } from "../dashboard.api.radar";
// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { RadarApplyError } from "../../lib/radar/apply-seo.server";

function moveRow(patch: Record<string, unknown> = {}) {
  return {
    id: MOVE_ID, shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "Make it worth the click", rationale: "Plain words.",
    evidence: { chips: ["spot #5"], facts: {} },
    payload: { applyMode: "publish_meta", handle: "mug", focusQuery: "mug" },
    dedupKey: "d", priorState: null, appliedStateHash: null,
    createdAt: "2026-07-20T00:00:00Z", appliedAt: null, resolvedAt: null, expiresAt: "e",
    ...patch,
  };
}

function competitorRow(status: "suggested" | "watching", patch: Record<string, unknown> = {}) {
  return {
    id: COMP_ID, shopId: SHOP, url: "https://rivalgear.example/", name: "Rival Gear", status,
    discoveryEvidence: { reason: "Sells hiking boots and packs" },
    createdAt: "2026-07-14T08:00:00Z", updatedAt: "2026-07-14T08:00:00Z",
    ...patch,
  };
}

function get() {
  return { request: new Request("https://app.x/dashboard/api/radar"), params: {}, context: {} } as never;
}
function post(body: unknown) {
  return {
    request: new Request("https://app.x/dashboard/api/radar", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    params: {}, context: {},
  } as never;
}

// Chainable stub for the signals reads.
function tableStub(result: { data: unknown; error: null }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt", "order", "limit"]) q[m] = vi.fn().mockReturnValue(q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardSession.mockResolvedValue({ shopId: SHOP, userId: "u1" });
  mocks.listMoves.mockResolvedValue([]);
  mocks.readRadarState.mockResolvedValue({ lastCollectedAt: "2026-07-20T10:00:00Z", lastDraftedAt: null, homeCardDismissedAt: null });
  mocks.fromMock.mockImplementation((table: string) => {
    if (table === "radar_traffic_daily") {
      return tableStub({ data: [{ day: "2026-07-19", views: 40 }, { day: "2026-07-18", views: 60 }], error: null });
    }
    if (table === "seo_settings") return tableStub({ data: { gsc_connected: true }, error: null });
    if (table === "seo_ai_crawl_daily") {
      return tableStub({ data: [{ day: "2026-07-19", hits: 2 }, { day: "2026-07-05", hits: 7 }], error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
  mocks.rpcMock.mockResolvedValue({ data: { slipping: [{}], lastCapturedDate: "2026-07-18" }, error: null });
  mocks.listCompetitors.mockResolvedValue([]);
  mocks.listSnapshotTimeline.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loader", () => {
  it("shapes the VM field-by-field and never leaks the internal noun", async () => {
    mocks.listMoves
      .mockResolvedValueOnce([moveRow()])
      .mockResolvedValueOnce([moveRow({ status: "dismissed", payload: { applyMode: "publish_meta", reverted: true }, priorState: { kind: "seo_meta" } })]);
    const res = (await loader(get())) as Response;
    const text = await res.text();
    expect(text).not.toMatch(/ploy/i);
    const body = JSON.parse(text);
    expect(body.moves[0]).toMatchObject({
      id: MOVE_ID, kind: "seo_meta_rewrite", headline: "Make it worth the click",
      chips: ["spot #5"], reviewOnly: false, canRevert: false, reverted: false,
    });
    expect(body.moves[0].payload).toBeUndefined();
    expect(body.moves[0].dedupKey).toBeUndefined();
    expect(body.history[0]).toMatchObject({ status: "dismissed", reverted: true });
    expect(body.signals.traffic).toEqual({ yesterdayViews: 40, weeklyAverage: expect.any(Number), lastCheckedAt: "2026-07-20T10:00:00Z" });
    expect(body.signals.google).toEqual({ connected: true, lastCapturedDate: "2026-07-18", slippingCount: 1 });
    expect(body.signals.aiAssistants).toEqual({ hitsLast7: expect.any(Number), hitsPrior7: expect.any(Number) });
    expect(body.signals.competitors).toEqual({ watching: 0, suggested: 0, changesLast7: 0, lastChangeAt: null });
  });
  it("marks review moves and surfaces their deep link", async () => {
    mocks.listMoves
      .mockResolvedValueOnce([moveRow({ payload: { applyMode: "review", deepLink: "/dashboard/products/p1" } })])
      .mockResolvedValueOnce([]);
    const body = await ((await loader(get())) as Response).json();
    expect(body.moves[0]).toMatchObject({ reviewOnly: true, deepLink: "/dashboard/products/p1" });
  });
  it("returns an empty VM for demo shops without touching the DB", async () => {
    mocks.requireDashboardSession.mockResolvedValue({ shopId: "demo-shop", userId: "u1" });
    const body = await ((await loader(get())) as Response).json();
    expect(body.moves).toEqual([]);
    expect(body.competitors).toEqual({ suggested: [], watching: [], watchLimit: 5 });
    expect(mocks.listMoves).not.toHaveBeenCalled();
    expect(mocks.fromMock).not.toHaveBeenCalled();
    expect(mocks.listCompetitors).not.toHaveBeenCalled();
  });
  it("excludes today's partial-day row from the traffic tile (matches the collect.server read boundary)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T09:00:00Z"));
    mocks.fromMock.mockImplementation((table: string) => {
      if (table === "radar_traffic_daily") {
        return tableStub({
          data: [
            { day: "2026-07-20", views: 5 }, // today, partial - must be excluded
            { day: "2026-07-19", views: 40 },
            { day: "2026-07-18", views: 60 },
          ],
          error: null,
        });
      }
      if (table === "seo_settings") return tableStub({ data: { gsc_connected: true }, error: null });
      if (table === "seo_ai_crawl_daily") return tableStub({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const body = await ((await loader(get())) as Response).json();
    expect(body.signals.traffic.yesterdayViews).toBe(40);
    vi.useRealTimers();
  });
  it("keeps the screen alive when a signals read fails", async () => {
    mocks.rpcMock.mockRejectedValue(new Error("summary down"));
    const res = (await loader(get())) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals.google).toEqual({ connected: true, lastCapturedDate: null, slippingCount: 0 });
  });
});

describe("action", () => {
  it("applies after the same-origin gate and returns the move VM", async () => {
    mocks.applyMove.mockResolvedValue(moveRow({ status: "applied", priorState: { kind: "seo_meta" }, appliedAt: "t" }));
    const res = (await action(post({ action: "apply", moveId: MOVE_ID }))) as Response;
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(mocks.applyMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1" });
    const body = await res.json();
    expect(body.move).toMatchObject({ status: "applied", canRevert: true });
    expect(JSON.stringify(body)).not.toMatch(/ploy/i);
  });
  it("dismisses and reverts (forwarding confirm)", async () => {
    mocks.dismissMove.mockResolvedValue(moveRow({ status: "dismissed" }));
    await action(post({ action: "dismiss", moveId: MOVE_ID }));
    expect(mocks.dismissMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID });
    mocks.revertMove.mockResolvedValue(moveRow({ status: "dismissed", payload: { applyMode: "publish_meta", reverted: true } }));
    await action(post({ action: "revert", moveId: MOVE_ID, confirm: true }));
    expect(mocks.revertMove).toHaveBeenCalledWith({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1", confirm: true });
  });
  it("maps RadarApplyError onto its status/code and 422s bad input", async () => {
    mocks.applyMove.mockRejectedValue(new RadarApplyError("revert_conflict", "Edited since.", 409));
    const res = (await action(post({ action: "apply", moveId: MOVE_ID }))) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "revert_conflict" });
    const bad = (await action(post({ action: "nope", moveId: MOVE_ID }))) as Response;
    expect(bad.status).toBe(422);
    const noId = (await action(post({ action: "apply" }))) as Response;
    expect(noId.status).toBe(422);
  });
});

describe("loader competitors block", () => {
  it("ships suggested + watching VMs and a live competitors tile", async () => {
    mocks.listCompetitors.mockImplementation(async (_shop: string, statuses: string[]) =>
      statuses.includes("suggested") ? [competitorRow("suggested")]
        : statuses.includes("watching") ? [competitorRow("watching")] : []);
    mocks.listSnapshotTimeline.mockResolvedValue([{
      competitorId: COMP_ID, url: "https://rivalgear.example/", capturedAt: "2026-07-20T00:00:00Z",
      diff: { titleChanged: { from: "a", to: "b" }, newHeadings: ["Sale"], removedHeadings: [], newPrices: ["$9.00"], removedPrices: ["$12.00"] },
    }]);
    const res = (await loader(get())) as Response;
    const body = await res.json();
    expect(body.competitors.suggested[0]).toMatchObject({
      id: COMP_ID, name: "Rival Gear", host: "rivalgear.example", reason: "Sells hiking boots and packs",
    });
    expect(body.competitors.watching[0].changes[0].chips).toEqual(
      expect.arrayContaining(["new headline", "prices changed"]),
    );
    expect(body.competitors.watchLimit).toBe(5);
    expect(body.signals.competitors).toMatchObject({ watching: 1, suggested: 1, changesLast7: 1 });
    expect(JSON.stringify(body)).not.toMatch(/ploy/i);
  });
  it("excludes a dismissed/no-longer-watching competitor's snapshots from the changesLast7 tile (FIX 10)", async () => {
    // listSnapshotTimeline is unfiltered by status - a competitor that was
    // dismissed still has old snapshot rows. The tile must only count
    // snapshots for competitors currently in the watching set, matching what
    // the per-card timelines already show.
    mocks.listCompetitors.mockImplementation(async (_shop: string, statuses: string[]) =>
      statuses.includes("watching") ? [competitorRow("watching")] : []);
    mocks.listSnapshotTimeline.mockResolvedValue([
      {
        competitorId: COMP_ID, // watching - should count
        url: "https://rivalgear.example/", capturedAt: new Date().toISOString(),
        diff: { titleChanged: null, newHeadings: [], removedHeadings: [], newPrices: ["$9"], removedPrices: ["$12"] },
      },
      {
        competitorId: "dismissed-competitor-id", // not in the watching set - must not count
        url: "https://old-rival.example/", capturedAt: new Date().toISOString(),
        diff: { titleChanged: null, newHeadings: [], removedHeadings: [], newPrices: ["$1"], removedPrices: ["$2"] },
      },
    ]);
    const res = (await loader(get())) as Response;
    const body = await res.json();
    expect(body.signals.competitors.changesLast7).toBe(1);
  });
  it("keeps the screen alive when the competitors read fails", async () => {
    mocks.listCompetitors.mockRejectedValue(new Error("db down"));
    const res = (await loader(get())) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.competitors).toEqual({ suggested: [], watching: [], watchLimit: 5 });
  });
});

describe("competitor actions", () => {
  it("confirm flips a suggestion to watching", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("updated");
    const res = (await action(post({ action: "competitor_confirm", competitorId: COMP_ID }))) as Response;
    expect(res.status).toBe(200);
    expect(mocks.requireSameOrigin).toHaveBeenCalled();
    expect(mocks.setCompetitorStatus).toHaveBeenCalledWith(SHOP, COMP_ID, "watching");
  });
  it("surfaces the 5-competitor watch limit as a 422 with plain copy", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("limit_reached");
    const res = (await action(post({ action: "competitor_confirm", competitorId: COMP_ID }))) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("watch_limit");
  });
  it("dismiss works for suggested and watching rows; missing rows 404", async () => {
    mocks.setCompetitorStatus.mockResolvedValue("updated");
    const ok = (await action(post({ action: "competitor_dismiss", competitorId: COMP_ID }))) as Response;
    expect(ok.status).toBe(200);
    expect(mocks.setCompetitorStatus).toHaveBeenCalledWith(SHOP, COMP_ID, "dismissed");
    mocks.setCompetitorStatus.mockResolvedValue("not_found");
    const nf = (await action(post({ action: "competitor_dismiss", competitorId: COMP_ID }))) as Response;
    expect(nf.status).toBe(404);
  });
  it("rejects competitor actions without a competitorId", async () => {
    const res = (await action(post({ action: "competitor_confirm" }))) as Response;
    expect(res.status).toBe(422);
  });
  it("still requires moveId for move actions (unaffected by the competitor branch)", async () => {
    const res = (await action(post({ action: "apply" }))) as Response;
    expect(res.status).toBe(422);
    expect(mocks.setCompetitorStatus).not.toHaveBeenCalled();
  });
});
