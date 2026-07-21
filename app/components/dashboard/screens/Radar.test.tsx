// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Radar from "./Radar";
import type { RadarMoveVM, RadarOverviewVM } from "~/lib/dashboard/radar-client";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { fetchRadar, applyRadarMove, dismissRadarMove, revertRadarMove } = vi.hoisted(() => ({
  fetchRadar: vi.fn(),
  applyRadarMove: vi.fn(),
  dismissRadarMove: vi.fn(),
  revertRadarMove: vi.fn(),
}));

vi.mock("~/lib/dashboard/screen-cache", () => ({
  SCREEN_CACHE_KEYS: { radar: "radar" },
  cachedScreenData: () => undefined,
  cacheScreenData: vi.fn(),
}));
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
vi.mock("~/lib/dashboard/radar-client", () => ({
  fetchRadar,
  applyRadarMove,
  dismissRadarMove,
  revertRadarMove,
  RADAR_KIND_LABELS: { section_refresh: "Store page" },
}));

function move(patch: Partial<RadarMoveVM> = {}): RadarMoveVM {
  return {
    id: "m1", kind: "section_refresh", status: "draft",
    headline: "Headline", rationale: "Rationale",
    chips: [], reviewOnly: false, deepLink: null,
    canRevert: false, reverted: false,
    createdAt: "2026-07-20T00:00:00Z", appliedAt: null, resolvedAt: null,
    ...patch,
  };
}

function overview(moves: RadarMoveVM[]): RadarOverviewVM {
  return {
    moves,
    history: [],
    signals: {
      traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
      google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
      aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
      competitors: { comingSoon: true },
    },
  };
}

function dashboardApp() {
  return { toast: vi.fn() };
}

async function renderRadar(app = dashboardApp()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Radar app={app as never} />);
    await Promise.resolve();
  });
  return { app, host, root };
}

function stubLocation(): () => void {
  const original = window.location;
  // @ts-expect-error - deliberately replacing jsdom's Location with a plain
  // stub so a real navigation attempt is observable without jsdom's
  // "not implemented" navigation noise.
  delete window.location;
  // @ts-expect-error - see above
  window.location = { href: "" };
  return () => {
    // @ts-expect-error - restore
    window.location = original;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchRadar.mockResolvedValue(overview([]));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Radar evidence chips", () => {
  it("never warns about duplicate React keys when two chips share the same text", async () => {
    fetchRadar.mockResolvedValue(overview([move({ chips: ["down 20%", "down 20%"] })]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, root } = await renderRadar();
    const keyWarning = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("same key")));
    expect(keyWarning).toBe(false);
    expect(host.textContent).toContain("down 20%");
    await act(async () => root.unmount());
    errorSpy.mockRestore();
  });
});

describe("Radar deep-link navigation", () => {
  it("ignores a deepLink that does not point into the dashboard", async () => {
    const restore = stubLocation();
    fetchRadar.mockResolvedValue(overview([
      move({ reviewOnly: true, deepLink: "https://attacker.example/phish" }),
    ]));
    const { host, root } = await renderRadar();
    const reviewBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Review")!;
    await act(async () => reviewBtn.click());
    expect(window.location.href).toBe("");
    await act(async () => root.unmount());
    restore();
  });
  it("navigates for a real dashboard deep link", async () => {
    const restore = stubLocation();
    fetchRadar.mockResolvedValue(overview([
      move({ reviewOnly: true, deepLink: "/dashboard/products/p1" }),
    ]));
    const { host, root } = await renderRadar();
    const reviewBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Review")!;
    await act(async () => reviewBtn.click());
    expect(window.location.href).toBe("/dashboard/products/p1");
    await act(async () => root.unmount());
    restore();
  });
});
