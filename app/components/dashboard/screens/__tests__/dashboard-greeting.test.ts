// Regression test for the dashboard hydration mismatch (React #418/#423/#425):
// the header greeting was computed from `new Date().getHours()` DURING render,
// so the server (UTC) and the client's first paint (user TZ) produced different
// <h1> text — React then tore down and re-rendered the whole root, breaking the
// layout. The fix renders a clock-independent header on the server + first paint
// and resolves the time-based greeting only after mount (in a useEffect).
//
// Verifies the behaviour at the seam that actually broke: the server render must
// NOT depend on the wall clock. The hydration audit confirmed the greeting is
// the only clock-dependent value that reaches the DOM at initial load, so two
// SSR renders at different times must be byte-identical.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import Dashboard from "../Dashboard";
import type { DashboardCtx } from "../../context";

// Minimal context matching the dashboard's initial (pre-fetch) state — exactly
// what both the server render and the client's first/hydration render see.
const ctx: DashboardCtx = {
  t: {},
  nav: { screen: "dashboard", param: null },
  navigate: () => {},
  alerts: [],
  campaigns: [],
  audit: [],
  guardrails: null,
  integrations: [],
  consent: null,
  overview: null,
  calibration: null,
  actionQueue: [],
  learnedRules: [],
  liveEngine: null,
  feed: [],
  liveOn: true,
  setLiveOn: () => {},
  executeAction: async () => null,
  undoAction: () => {},
  pushAdDraft: () => {},
  toast: () => {},
  relTime: () => "",
  refresh: () => {},
  loading: true,
};

describe("dashboard greeting — hydration safety", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("server-renders a clock-independent header (no SSR↔client mismatch)", () => {
    vi.setSystemTime(new Date("2026-06-19T09:00:00Z")); // morning bucket
    const morning = renderToString(h(Dashboard, { app: ctx }));
    vi.setSystemTime(new Date("2026-06-19T21:00:00Z")); // evening bucket
    const evening = renderToString(h(Dashboard, { app: ctx }));
    expect(morning).toBe(evening);
  });
});
