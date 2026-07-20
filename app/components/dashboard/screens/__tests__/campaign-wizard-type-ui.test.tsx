// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignWizard } from "../CampaignWizard";
import type { DashboardCtx } from "../../context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@gsap/react", () => ({ useGSAP: () => ({ contextSafe: (fn: unknown) => fn }) }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn(), timeline: () => ({ fromTo: vi.fn() }) } }));

afterEach(() => { document.body.innerHTML = ""; vi.clearAllMocks(); });

describe("campaign wizard type selection", () => {
  it("exposes Regular and Sales as a labelled single-choice group with fixed-window copy", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(
      <CampaignWizard
        app={{ storeLabel: "Test store", toast: vi.fn() } as unknown as DashboardCtx}
        prefill={{ id: "draft", name: "Draft", platform: "google", createdAt: "", updatedAt: "", state: null }}
        onExit={vi.fn()}
      />,
    ));

    const group = host.querySelector('[role="radiogroup"][aria-label="Campaign type"]')!;
    expect(group.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Regular");
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(host.textContent).toContain("7, 30, or 90-day reporting window");
    expect(host.textContent).not.toContain("promotion period");
    act(() => root.unmount());
  });
});
