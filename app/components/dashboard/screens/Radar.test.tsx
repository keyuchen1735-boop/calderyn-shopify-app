// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Radar from "./Radar";
import type { RadarCompetitorVM, RadarMoveVM, RadarOverviewVM } from "~/lib/dashboard/radar-client";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const {
  fetchRadar,
  applyRadarMove,
  dismissRadarMove,
  revertRadarMove,
  confirmRadarCompetitor,
  dismissRadarCompetitor,
  refreshRadar,
} = vi.hoisted(() => ({
  fetchRadar: vi.fn(),
  applyRadarMove: vi.fn(),
  dismissRadarMove: vi.fn(),
  revertRadarMove: vi.fn(),
  confirmRadarCompetitor: vi.fn(),
  dismissRadarCompetitor: vi.fn(),
  refreshRadar: vi.fn(),
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
  confirmRadarCompetitor,
  dismissRadarCompetitor,
  refreshRadar,
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

function competitor(patch: Partial<RadarCompetitorVM> = {}): RadarCompetitorVM {
  return {
    id: "c1",
    name: "Northwind Goods",
    host: "northwindgoods.com",
    url: "https://northwindgoods.com",
    status: "suggested",
    reason: "Sells similar products",
    addedAt: "2026-07-20T00:00:00Z",
    changes: [],
    ...patch,
  };
}

function overview(
  moves: RadarMoveVM[],
  patch: Partial<RadarOverviewVM> = {},
): RadarOverviewVM {
  return {
    moves,
    history: [],
    signals: {
      traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
      google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
      aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
      competitors: { watching: 0, suggested: 0, changesLast7: 0, lastChangeAt: null },
    },
    competitors: { suggested: [], watching: [], watchLimit: 5 },
    lastCheckedAt: "2026-07-20T09:00:00Z",
    stale: false,
    ...patch,
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
  refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
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

describe("Radar competitors tile", () => {
  it("shows 'None yet' when there are no suggested or watched competitors", async () => {
    fetchRadar.mockResolvedValue(overview([]));
    const { host, root } = await renderRadar();
    expect(host.textContent).toContain("None yet");
    expect(host.textContent).toContain("Radar suggests stores weekly - confirm to watch");
    await act(async () => root.unmount());
  });

  it("shows a suggested count when nothing is watched yet", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        signals: {
          traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
          google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
          aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
          competitors: { watching: 0, suggested: 2, changesLast7: 0, lastChangeAt: null },
        },
        competitors: { suggested: [competitor(), competitor({ id: "c2" })], watching: [], watchLimit: 5 },
      }),
    );
    const { host, root } = await renderRadar();
    expect(host.textContent).toContain("2 suggested");
    await act(async () => root.unmount());
  });

  it("shows watched count and recent-change note when competitors are watched", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        signals: {
          traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
          google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
          aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
          competitors: { watching: 1, suggested: 0, changesLast7: 3, lastChangeAt: "2026-07-19T00:00:00Z" },
        },
        competitors: {
          suggested: [],
          watching: [competitor({ status: "watching" })],
          watchLimit: 5,
        },
      }),
    );
    const { host, root } = await renderRadar();
    expect(host.textContent).toContain("1 watched");
    expect(host.textContent).toContain("3 changes this week");
    await act(async () => root.unmount());
  });
});

describe("Radar competitors tab", () => {
  it("adds a Competitors segmented option with a suggested count", async () => {
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor(), competitor({ id: "c2" })], watching: [], watchLimit: 5 } }),
    );
    const { host, root } = await renderRadar();
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    expect(tabBtn?.textContent).toBe("Competitors (2)");
    await act(async () => root.unmount());
  });

  it("shows the empty state when there are no suggested or watched competitors", async () => {
    fetchRadar.mockResolvedValue(overview([]));
    const { host, root } = await renderRadar();
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Competitors");
    await act(async () => tabBtn!.click());
    expect(host.textContent).toContain("No competitors yet");
    await act(async () => root.unmount());
  });

  it("confirms a suggested competitor and reloads the list", async () => {
    confirmRadarCompetitor.mockResolvedValue({ competitors: { suggested: [], watching: [], watchLimit: 5 } });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());
    expect(host.textContent).toContain("Northwind Goods");
    expect(host.textContent).toContain("northwindgoods.com");
    expect(host.textContent).toContain("Sells similar products");

    fetchRadar.mockResolvedValue(overview([]));
    const watchBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Watch this store")!;
    await act(async () => watchBtn.click());
    expect(confirmRadarCompetitor).toHaveBeenCalledWith("c1");
    expect(app.toast).toHaveBeenCalledWith("Watching. Radar checks it nightly.", "check");
    expect(fetchRadar).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("dismisses a suggested competitor", async () => {
    dismissRadarCompetitor.mockResolvedValue({ competitors: { suggested: [], watching: [], watchLimit: 5 } });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());

    fetchRadar.mockResolvedValue(overview([]));
    const dismissBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!;
    await act(async () => dismissBtn.click());
    expect(dismissRadarCompetitor).toHaveBeenCalledWith("c1");
    expect(app.toast).toHaveBeenCalledWith("Dismissed.", "check");
    await act(async () => root.unmount());
  });

  it("shows a watched competitor's recent-changes timeline and lets the merchant stop watching", async () => {
    dismissRadarCompetitor.mockResolvedValue({ competitors: { suggested: [], watching: [], watchLimit: 5 } });
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: {
          suggested: [],
          watching: [
            competitor({
              status: "watching",
              changes: [{ day: "2026-07-19", url: "https://northwindgoods.com", chips: ["new headline", "prices changed"] }],
            }),
          ],
          watchLimit: 5,
        },
      }),
    );
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());
    expect(host.textContent).toContain("Watching (1/5)");
    expect(host.textContent).toContain("new headline");
    expect(host.textContent).toContain("prices changed");

    const stopBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Stop watching")!;
    await act(async () => stopBtn.click());
    expect(dismissRadarCompetitor).toHaveBeenCalledWith("c1");
    expect(app.toast).toHaveBeenCalledWith("Stopped watching.", "check");
    await act(async () => root.unmount());
  });

  it("renders a change day using the UTC calendar date, never shifting a day earlier west of UTC (FIX 8)", async () => {
    // new Date("2026-07-20") is UTC midnight; in any timezone behind UTC
    // (e.g. the Americas), naively formatting it with the local timezone
    // renders the PRIOR day. The stored value is a plain YYYY-MM-DD date with
    // no time-of-day, so it must always format as that exact calendar date.
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: {
          suggested: [],
          watching: [
            competitor({
              status: "watching",
              changes: [{ day: "2026-07-20", url: "https://northwindgoods.com", chips: [] }],
            }),
          ],
          watchLimit: 5,
        },
      }),
    );
    const { host, root } = await renderRadar();
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());
    expect(host.textContent).toContain("Jul 20");
    expect(host.textContent).not.toContain("Jul 19");
    await act(async () => root.unmount());
  });

  it("tells the merchant Stop watching is permanent (FIX 11 - copy only, no re-add flow)", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: { suggested: [], watching: [competitor({ status: "watching" })], watchLimit: 5 },
      }),
    );
    const { host, root } = await renderRadar();
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());
    // Button label is unchanged; the permanence lives in nearby copy.
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Stop watching")).toBe(true);
    expect(host.textContent).toContain("Radar will stop watching this competitor and won't suggest it again.");
    await act(async () => root.unmount());
  });

  it("shows a no-changes-yet note for a watched competitor with no changes", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: { suggested: [], watching: [competitor({ status: "watching", changes: [] })], watchLimit: 5 },
      }),
    );
    const { host, root } = await renderRadar();
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());
    expect(host.textContent).toContain("No changes spotted yet. Radar checks nightly.");
    await act(async () => root.unmount());
  });
});

describe("Radar instant check on open", () => {
  it("auto-triggers exactly one refresh and shows a banner while stale data is loaded", async () => {
    refreshRadar.mockImplementation(() => new Promise(() => {})); // never resolves within this test
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: null }));
    const { host, root } = await renderRadar();
    expect(host.textContent).toContain(
      "Radar is taking a fresh look at your store. New moves will show up here in a moment.",
    );
    expect(refreshRadar).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("clears the banner and refetches once a stale refresh actually ran", async () => {
    refreshRadar.mockResolvedValue({ refreshed: true, drafted: 1 });
    fetchRadar
      .mockResolvedValueOnce(overview([], { stale: true, lastCheckedAt: null }))
      .mockResolvedValueOnce(overview([], { stale: false, lastCheckedAt: "2026-07-20T10:00:00Z" }));
    const { host, root } = await renderRadar();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Radar is taking a fresh look at your store");
    expect(fetchRadar).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("clears the banner without refetching when the refresh reports fresh", async () => {
    refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: "2026-07-20T09:50:00Z" }));
    const { host, root } = await renderRadar();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Radar is taking a fresh look at your store");
    expect(fetchRadar).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("does not auto-refresh (or show a banner) when the overview is not stale", async () => {
    fetchRadar.mockResolvedValue(overview([], { stale: false, lastCheckedAt: "2026-07-20T09:50:00Z" }));
    const { host, root } = await renderRadar();
    expect(refreshRadar).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Radar is taking a fresh look at your store");
    await act(async () => root.unmount());
  });

  it("renders a Check now button", async () => {
    const { host, root } = await renderRadar();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Check now")).toBe(true);
    await act(async () => root.unmount());
  });

  it("Check now toasts when Radar just checked and mentions new moves", async () => {
    refreshRadar.mockResolvedValue({ refreshed: true, drafted: 2 });
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check now")!;
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshRadar).toHaveBeenCalledTimes(1);
    expect(app.toast).toHaveBeenCalledWith(expect.stringContaining("Radar just checked your store"), "check");
    expect(app.toast.mock.calls[0][0]).toContain("2");
    await act(async () => root.unmount());
  });

  it("Check now toasts a plain message when Radar already checked recently", async () => {
    refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check now")!;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(app.toast).toHaveBeenCalledWith("Radar already checked recently", expect.any(String));
    await act(async () => root.unmount());
  });
});

describe("Radar competitor confirm first look", () => {
  it("tells the merchant Radar took its first look when the confirm response says so", async () => {
    confirmRadarCompetitor.mockResolvedValue({
      competitors: { suggested: [], watching: [], watchLimit: 5 },
      firstLook: true,
    });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const app = dashboardApp();
    const { host, root } = await renderRadar(app);
    const tabBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Competitors"));
    await act(async () => tabBtn!.click());

    fetchRadar.mockResolvedValue(overview([]));
    const watchBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Watch this store")!;
    await act(async () => watchBtn.click());
    expect(app.toast).toHaveBeenCalledWith("Watching. Radar took its first look at their site.", "check");
    await act(async () => root.unmount());
  });
});
