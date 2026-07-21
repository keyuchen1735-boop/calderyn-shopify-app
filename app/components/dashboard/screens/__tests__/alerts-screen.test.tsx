// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGSAP } from "@gsap/react";
import type { DashboardCtx } from "../../context";
import type { AlertVM } from "../../view-models";
import Alerts from "../Alerts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const matchMediaMock = vi.fn().mockReturnValue({ matches: true });

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: matchMediaMock,
});

const { timelineMock, useGSAPMock } = vi.hoisted(() => ({
  timelineMock: vi.fn(),
  useGSAPMock: vi.fn(() => ({ contextSafe: (fn: () => void) => fn })),
}));

vi.mock("@gsap/react", () => ({
  useGSAP: useGSAPMock,
}));

vi.mock("gsap", () => ({
  default: {
    registerPlugin: vi.fn(),
    killTweensOf: vi.fn(),
    timeline: timelineMock,
  },
}));

const alert = (overrides: Partial<AlertVM> = {}): AlertVM => ({
  id: "alert-1",
  detector_id: "reorder_timing",
  severity: "high",
  status: "open",
  claude_rank: 1,
  dollar_impact: 123_400,
  created_at: "2026-07-20T12:00:00.000Z",
  title: "Ridgeline Hoodie — L",
  campaign: null,
  campaign_id: null,
  sku: "PP-RIDGELINE-HOODIE-L",
  narrative: "Lead time is longer than the stock currently on hand.",
  evidence: {},
  actions: ["create_po_draft", "snooze_alert"],
  recommended: "create_po_draft",
  rec_detail: "Repeated recommendation copy should stay out of the compact detail.",
  remediation: null,
  ...overrides,
});

function makeApp(alerts: AlertVM[], expandedId: string | null = null): DashboardCtx {
  return {
    alerts,
    nav: { screen: "alerts", param: expandedId, sub: null },
    navigate: vi.fn(),
    loading: false,
    shopDomain: null,
    executeAction: vi.fn(),
    weatherIntent: vi.fn(),
    toast: vi.fn(),
  } as unknown as DashboardCtx;
}

let host: HTMLDivElement;
let root: Root;

function render(app: DashboardCtx) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Alerts app={app} />));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  matchMediaMock.mockReturnValue({ matches: true });
  timelineMock.mockReset();
  vi.mocked(useGSAP).mockClear();
});

describe("Alerts screen", () => {
  it("leaves whole-screen transitions to the dashboard shell", () => {
    render(makeApp([alert()]));

    expect(useGSAP).toHaveBeenCalledTimes(1);
  });

  it("keeps the list concise while preserving accessible impact context", () => {
    const app = makeApp([
      alert(),
      alert({ id: "alert-2", status: "resolved", title: "Resolved alert" }),
    ]);
    render(app);

    expect(host.textContent).toContain("1 open · $1,234 at risk over 30 days");
    expect(host.textContent).not.toContain("PP-RIDGELINE-HOODIE-L");
    expect(host.textContent).not.toContain("at risk if left alone");
    expect(host.textContent).toContain("12 detectors · refreshed every 15 min");
    expect(host.querySelector(".cd-alert-impact")?.textContent).toBe("$1,234");

    const row = host.querySelector<HTMLButtonElement>(".cd-alert-row");
    expect(row?.getAttribute("aria-label")).toContain("At risk $1,234 over 30 days");
    act(() => row?.click());
    expect(app.navigate).toHaveBeenCalledWith("alerts", "alert-1", null, {
      preserveScroll: true,
    });
  });

  it("shows one clear recommendation instead of repeating the same action", () => {
    const app = makeApp([alert()], "alert-1");
    render(app);

    expect(host.textContent).toContain("Lead time is longer than the stock currently on hand.");
    expect(host.textContent).toContain("PP-RIDGELINE-HOODIE-L");
    expect(host.textContent?.match(/Create PO draft/g)).toHaveLength(1);
    expect(host.textContent).not.toContain("Repeated recommendation copy");
    expect(host.textContent).not.toContain("Fix");
    expect(
      host.querySelector("[aria-label='Create PO draft, recommended']"),
    ).not.toBeNull();

    act(() => host.querySelector<HTMLButtonElement>(".cd-alert-row")?.click());
    expect(app.navigate).toHaveBeenCalledWith("alerts", null, null, {
      preserveScroll: true,
    });
  });

  it("finishes an interrupted close transition", () => {
    matchMediaMock.mockReturnValue({ matches: false });
    timelineMock.mockImplementation((options: { onInterrupt?: () => void }) => {
      const timeline = {
        to: vi.fn(() => {
          options.onInterrupt?.();
          return timeline;
        }),
      };
      return timeline;
    });
    const app = makeApp([alert()], "alert-1");
    render(app);

    act(() => host.querySelector<HTMLButtonElement>(".cd-alert-row")?.click());

    expect(app.navigate).toHaveBeenCalledTimes(1);
    expect(app.navigate).toHaveBeenCalledWith("alerts", null, null, {
      preserveScroll: true,
    });
  });
});
