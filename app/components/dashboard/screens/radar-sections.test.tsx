// @vitest-environment jsdom
// Ported from the retired standalone Radar screen's tests: the queue behaviors
// now live in Autopilot's OvernightMoves section and the observational pieces
// in Analytics > Live's LiveRadarSignals block.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OvernightMoves, LiveRadarSignals } from "./radar-sections";
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
  return { toast: vi.fn(), relTime: vi.fn((_ts: number) => "3h ago"), navigate: vi.fn() };
}

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return { host, root };
}

const renderMoves = async (app = dashboardApp()) => {
  const r = await render(<OvernightMoves app={app as never} />);
  return { app, ...r };
};

const renderSignals = async (app = dashboardApp()) => {
  const r = await render(<LiveRadarSignals app={app as never} />);
  return { app, ...r };
};

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

describe("OvernightMoves evidence chips", () => {
  it("never warns about duplicate React keys when two chips share the same text", async () => {
    fetchRadar.mockResolvedValue(overview([move({ chips: ["down 20%", "down 20%"] })]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, root } = await renderMoves();
    const keyWarning = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("same key")));
    expect(keyWarning).toBe(false);
    expect(host.textContent).toContain("down 20%");
    await act(async () => root.unmount());
    errorSpy.mockRestore();
  });
});

describe("OvernightMoves deep-link navigation", () => {
  it("ignores a deepLink that does not point into the dashboard", async () => {
    const restore = stubLocation();
    fetchRadar.mockResolvedValue(overview([
      move({ reviewOnly: true, deepLink: "https://attacker.example/phish" }),
    ]));
    const { host, root } = await renderMoves();
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
    const { host, root } = await renderMoves();
    const reviewBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Review")!;
    await act(async () => reviewBtn.click());
    expect(window.location.href).toBe("/dashboard/products/p1");
    await act(async () => root.unmount());
    restore();
  });
});

describe("OvernightMoves approve/dismiss", () => {
  it("approves a drafted move via the radar apply action", async () => {
    applyRadarMove.mockResolvedValue({ move: move({ status: "applied" }) });
    fetchRadar.mockResolvedValue(overview([move()]));
    const { app, host, root } = await renderMoves();
    const approveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await act(async () => approveBtn.click());
    expect(applyRadarMove).toHaveBeenCalledWith("m1");
    expect(app.toast).toHaveBeenCalledWith("Applied — your store page was updated.", "check");
    await act(async () => root.unmount());
  });

  it("dismisses a drafted move via the radar dismiss action", async () => {
    dismissRadarMove.mockResolvedValue({ move: move({ status: "dismissed" }) });
    fetchRadar.mockResolvedValue(overview([move()]));
    const { app, host, root } = await renderMoves();
    const dismissBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!;
    await act(async () => dismissBtn.click());
    expect(dismissRadarMove).toHaveBeenCalledWith("m1");
    expect(app.toast).toHaveBeenCalledWith("Dismissed.", "check");
    await act(async () => root.unmount());
  });

  it("keeps the generic receipt for a kind outside the store-page family", async () => {
    applyRadarMove.mockResolvedValue({ move: move({ status: "applied" }) });
    fetchRadar.mockResolvedValue(overview([move({ kind: "competitor_counter" })]));
    const { app, host, root } = await renderMoves();
    const approveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await act(async () => approveBtn.click());
    expect(app.toast).toHaveBeenCalledWith("Applied. You can undo it anytime.", "check");
    await act(async () => root.unmount());
  });
});

describe("OvernightMoves revert flow", () => {
  it("shows recently applied moves with a Revert button and arms it on a 409 revert_conflict", async () => {
    const { DashboardApiError } = await import("~/lib/dashboard/client");
    revertRadarMove
      .mockRejectedValueOnce(new DashboardApiError(409, "revert_conflict", "That page changed since."))
      .mockResolvedValueOnce({ move: move({ status: "draft" }) });
    fetchRadar.mockResolvedValue(
      overview([], { history: [move({ id: "h1", status: "applied", canRevert: true, appliedAt: "2026-07-19T10:00:00Z" })] }),
    );
    const { app, host, root } = await renderMoves();
    expect(host.textContent).toContain("Recently applied");

    const revertBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Revert")!;
    await act(async () => revertBtn.click());
    expect(revertRadarMove).toHaveBeenCalledWith("h1", false);
    expect(app.toast).toHaveBeenCalledWith(
      expect.stringContaining("Click Revert again to continue."), "warn", "critical",
    );

    const armed = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Revert (overwrites newer edits)",
    )!;
    await act(async () => armed.click());
    expect(revertRadarMove).toHaveBeenLastCalledWith("h1", true);
    expect(app.toast).toHaveBeenCalledWith("Reverted.", "check");
    await act(async () => root.unmount());
  });
});

describe("OvernightMoves instant check on open", () => {
  it("auto-triggers exactly one refresh and shows a banner while stale data is loaded", async () => {
    refreshRadar.mockImplementation(() => new Promise(() => {})); // never resolves within this test
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: null }));
    const { host, root } = await renderMoves();
    expect(host.textContent).toContain(
      "Taking a fresh look at your store. New moves will show up here in a moment.",
    );
    expect(refreshRadar).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("clears the banner and refetches once a stale refresh actually ran", async () => {
    refreshRadar.mockResolvedValue({ refreshed: true, drafted: 1 });
    fetchRadar
      .mockResolvedValueOnce(overview([], { stale: true, lastCheckedAt: null }))
      .mockResolvedValueOnce(overview([], { stale: false, lastCheckedAt: "2026-07-20T10:00:00Z" }));
    const { host, root } = await renderMoves();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Taking a fresh look at your store");
    expect(fetchRadar).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("clears the banner and refetches once too when the refresh reports fresh (picks up another session's newer refresh)", async () => {
    refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: "2026-07-20T09:50:00Z" }));
    const { host, root } = await renderMoves();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Taking a fresh look at your store");
    expect(fetchRadar).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("only ever auto-refreshes once even though the fresh branch now also refetches", async () => {
    refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: "2026-07-20T09:50:00Z" }));
    const { root } = await renderMoves();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshRadar).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("does not auto-refresh (or show a banner) when the overview is not stale", async () => {
    fetchRadar.mockResolvedValue(overview([], { stale: false, lastCheckedAt: "2026-07-20T09:50:00Z" }));
    const { host, root } = await renderMoves();
    expect(refreshRadar).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Taking a fresh look at your store");
    await act(async () => root.unmount());
  });

  it("renders a Check now button", async () => {
    const { host, root } = await renderMoves();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Check now")).toBe(true);
    await act(async () => root.unmount());
  });

  it("Check now toasts when the check just ran and mentions new moves", async () => {
    refreshRadar.mockResolvedValue({ refreshed: true, drafted: 2 });
    const { app, host, root } = await renderMoves();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check now")!;
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshRadar).toHaveBeenCalledTimes(1);
    expect(app.toast).toHaveBeenCalledWith(expect.stringContaining("Just checked your store"), "check");
    expect(app.toast.mock.calls[0][0]).toContain("2");
    await act(async () => root.unmount());
  });

  it("Check now toasts a plain message when the store was already checked recently, using a registered icon", async () => {
    refreshRadar.mockResolvedValue({ refreshed: false, reason: "fresh" });
    const { app, host, root } = await renderMoves();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check now")!;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    // "info" is not a registered CD_ICONS name - it must be one that exists.
    expect(app.toast).toHaveBeenCalledWith("Already checked recently", "clock");
    await act(async () => root.unmount());
  });

  it("disables Check now while the stale auto-refresh banner is in flight, so a click can't fire a concurrent refresh", async () => {
    refreshRadar.mockImplementation(() => new Promise(() => {})); // never resolves in this test
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: null }));
    const { host, root } = await renderMoves();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check now") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => root.unmount());
  });
});

describe("OvernightMoves empty states", () => {
  it("shows an all-clear line with the checked-ago caption when the queue is empty and fresh", async () => {
    fetchRadar.mockResolvedValue(overview([], { stale: false, lastCheckedAt: "2026-07-20T09:00:00Z" }));
    const { app, host, root } = await renderMoves();
    expect(host.textContent).toContain("Nothing needs your attention right now.");
    expect(host.textContent).toContain("Checked 3h ago.");
    expect(app.relTime).toHaveBeenCalledWith(Date.parse("2026-07-20T09:00:00Z"));
    await act(async () => root.unmount());
  });

  it("does not claim all-clear when there are moves to review", async () => {
    fetchRadar.mockResolvedValue(overview([move()]));
    const { host, root } = await renderMoves();
    expect(host.textContent).not.toContain("Nothing needs your attention right now.");
    await act(async () => root.unmount());
  });

  it("does not claim all-clear while stale (the instant check is still pending)", async () => {
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: null }));
    refreshRadar.mockImplementation(() => new Promise(() => {})); // never resolves in this test
    const { host, root } = await renderMoves();
    expect(host.textContent).not.toContain("Nothing needs your attention right now.");
    await act(async () => root.unmount());
  });
});

describe("LiveRadarSignals tiles", () => {
  it("renders the AI-assistant and Google tiles from the overview signals", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        signals: {
          traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
          google: { connected: true, lastCapturedDate: "2026-07-19", slippingCount: 2 },
          aiAssistants: { hitsLast7: 9, hitsPrior7: 4 },
          competitors: { watching: 0, suggested: 0, changesLast7: 0, lastChangeAt: null },
        },
      }),
    );
    const { host, root } = await renderSignals();
    expect(host.textContent).toContain("AI assistant visits");
    expect(host.textContent).toContain("9");
    expect(host.textContent).toContain("4 the week before");
    expect(host.textContent).toContain("2 pages slipping");
    expect(host.textContent).toContain("Data through 2026-07-19");
    await act(async () => root.unmount());
  });

  it("points a disconnected Google tile at Store > Preferences", async () => {
    const { host, root } = await renderSignals();
    expect(host.textContent).toContain("Not connected");
    expect(host.textContent).toContain("Connect Google in Store > Preferences");
    await act(async () => root.unmount());
  });

  it("never triggers the instant check - that behavior lives with the Autopilot queue", async () => {
    fetchRadar.mockResolvedValue(overview([], { stale: true, lastCheckedAt: null }));
    const { root } = await renderSignals();
    expect(refreshRadar).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

describe("LiveRadarSignals competitor watch", () => {
  it("shows the empty state when there are no suggested or watched competitors", async () => {
    const { host, root } = await renderSignals();
    expect(host.textContent).toContain("Competitor watch");
    expect(host.textContent).toContain("Nothing is watched until you confirm it.");
    await act(async () => root.unmount());
  });

  it("confirms a suggested competitor and reloads the list", async () => {
    confirmRadarCompetitor.mockResolvedValue({ competitors: { suggested: [], watching: [], watchLimit: 5 } });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const { app, host, root } = await renderSignals();
    expect(host.textContent).toContain("Northwind Goods");
    expect(host.textContent).toContain("northwindgoods.com");
    expect(host.textContent).toContain("Sells similar products");

    fetchRadar.mockResolvedValue(overview([]));
    const watchBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Watch this store")!;
    await act(async () => watchBtn.click());
    expect(confirmRadarCompetitor).toHaveBeenCalledWith("c1");
    expect(app.toast).toHaveBeenCalledWith("Watching. Calderyn checks it nightly.", "check");
    expect(fetchRadar).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("tells the merchant about the first look when the confirm response says so", async () => {
    confirmRadarCompetitor.mockResolvedValue({
      competitors: { suggested: [], watching: [], watchLimit: 5 },
      firstLook: true,
    });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const { app, host, root } = await renderSignals();
    fetchRadar.mockResolvedValue(overview([]));
    const watchBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Watch this store")!;
    await act(async () => watchBtn.click());
    expect(app.toast).toHaveBeenCalledWith("Watching. Calderyn took its first look at their site.", "check");
    await act(async () => root.unmount());
  });

  it("dismisses a suggested competitor", async () => {
    dismissRadarCompetitor.mockResolvedValue({ competitors: { suggested: [], watching: [], watchLimit: 5 } });
    fetchRadar.mockResolvedValue(
      overview([], { competitors: { suggested: [competitor()], watching: [], watchLimit: 5 } }),
    );
    const { app, host, root } = await renderSignals();
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
    const { app, host, root } = await renderSignals();
    expect(host.textContent).toContain("Watching (1/5)");
    expect(host.textContent).toContain("new headline");
    expect(host.textContent).toContain("prices changed");

    const stopBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Stop watching")!;
    await act(async () => stopBtn.click());
    expect(dismissRadarCompetitor).toHaveBeenCalledWith("c1");
    expect(app.toast).toHaveBeenCalledWith("Stopped watching.", "check");
    await act(async () => root.unmount());
  });

  it("renders a change day using the UTC calendar date, never shifting a day earlier west of UTC", async () => {
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
    const { host, root } = await renderSignals();
    expect(host.textContent).toContain("Jul 20");
    expect(host.textContent).not.toContain("Jul 19");
    await act(async () => root.unmount());
  });

  it("tells the merchant Stop watching is permanent (copy only, no re-add flow)", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: { suggested: [], watching: [competitor({ status: "watching" })], watchLimit: 5 },
      }),
    );
    const { host, root } = await renderSignals();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Stop watching")).toBe(true);
    expect(host.textContent).toContain("Calderyn will stop watching this competitor and won't suggest it again.");
    await act(async () => root.unmount());
  });

  it("shows a no-changes-yet note for a watched competitor with no changes", async () => {
    fetchRadar.mockResolvedValue(
      overview([], {
        competitors: { suggested: [], watching: [competitor({ status: "watching", changes: [] })], watchLimit: 5 },
      }),
    );
    const { host, root } = await renderSignals();
    expect(host.textContent).toContain("No changes spotted yet. Checked nightly.");
    await act(async () => root.unmount());
  });
});
