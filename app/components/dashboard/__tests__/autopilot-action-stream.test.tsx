// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardCtx } from "../context";
import type * as DashboardUI from "../ui";
import type { QueueProposalVM } from "../view-models";
import { actionStreamWindow, CalibrationTrainer } from "../screens/Autopilot";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../ui", async () => {
  const actual = await vi.importActual<typeof DashboardUI>("../ui");
  return {
    ...actual,
    TickGauge: ({ pct }: { pct: number }) => <div data-testid="gauge">{pct}%</div>,
  };
});

describe("actionStreamWindow", () => {
  it("wraps only real queued actions so the next item can enter at the top", () => {
    const queue = ["a", "b", "c", "d", "e"];

    expect(actionStreamWindow(queue, 0, 4)).toEqual(["a", "b", "c", "d"]);
    expect(actionStreamWindow(queue, -1, 4)).toEqual(["e", "a", "b", "c"]);
    expect(actionStreamWindow(queue, 2, 9)).toEqual(["c", "d", "e", "a", "b"]);
  });

  it("returns an empty window for an empty queue", () => {
    expect(actionStreamWindow([], 4, 4)).toEqual([]);
  });
});

const proposal = (index: number): QueueProposalVM => ({
  alertId: `alert-${index}`,
  detector_id: "margin_guard",
  action_kind: "adjust_price",
  title: `Action ${index}`,
  dollar_impact: index * 32_000,
  confidence: 80 + index,
  reasoning: `Reason ${index}`,
});

describe("CalibrationTrainer action stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates real actions into the top and exposes the complete static list", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const app = {
      actionQueue: [1, 2, 3, 4, 5].map(proposal),
      alerts: [],
      executeAction: vi.fn(),
      refresh: vi.fn(),
      toast: vi.fn(),
      navigate: vi.fn(),
    } as unknown as DashboardCtx;

    act(() => {
      root.render(<CalibrationTrainer app={app} pct={46} onReview={vi.fn()} />);
    });

    expect(host.querySelectorAll(".cd-ap-stream-row")).toHaveLength(4);
    expect(host.textContent).toContain("46%");
    expect(host.textContent).toContain("$4.8k");

    act(() => vi.advanceTimersByTime(3_200));
    expect(host.querySelectorAll(".cd-ap-stream-row")).toHaveLength(5);
    expect(host.querySelector(".cd-ap-stream-row")?.getAttribute("data-alert-id")).toBe(
      "alert-5",
    );
    const exitingRow = host.querySelector(".cd-ap-stream-row[data-exiting='1']");
    expect(exitingRow?.hasAttribute("inert")).toBe(true);
    expect(exitingRow?.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(520));
    expect(host.querySelectorAll(".cd-ap-stream-row")).toHaveLength(4);

    act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Expand all actions']")?.click(),
    );
    expect(host.querySelector("[role='dialog']")?.textContent).toContain("All waiting actions");
    expect(host.querySelectorAll(".cd-ap-stream-static-row")).toHaveLength(5);

    act(() =>
      host
        .querySelector<HTMLButtonElement>(".cd-ap-stream-static-row .cd-apq-main")
        ?.click(),
    );
    act(() =>
      host.querySelector<HTMLButtonElement>("[aria-label='Close all actions']")?.click(),
    );
    act(() => vi.advanceTimersByTime(3_600));
    expect(host.querySelector(".cd-ap-stream-row")?.getAttribute("data-alert-id")).toBe(
      "alert-4",
    );

    act(() => root.unmount());
    host.remove();
  });
});
