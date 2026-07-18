// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingTour } from "../OnboardingTour";

describe("OnboardingTour", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("walks forward and back while announcing progress", () => {
    act(() => root.render(<OnboardingTour open onOutcome={() => {}} />));
    expect(host.textContent).toContain("Meet your command center.");
    expect(host.textContent).toContain("places you'll use every day");
    expect(
      host.querySelector(".cd-tour-progress")?.getAttribute("aria-label"),
    ).toBe("Step 1 of 7");

    act(() =>
      host.querySelector<HTMLButtonElement>(".cd-tour-btn--primary")?.click(),
    );
    expect(host.textContent).toContain("Start here.");
    expect(host.textContent).toContain("your setup steps and today's numbers");
    expect(
      host.querySelector(".cd-tour-progress")?.getAttribute("aria-label"),
    ).toBe("Step 2 of 7");

    act(() =>
      host.querySelector<HTMLButtonElement>(".cd-tour-btn--secondary")?.click(),
    );
    expect(host.textContent).toContain("Meet your command center.");
  });

  it("opens the real assistant demo only for the Ask Calderyn step", async () => {
    const onAssistantDemo = vi.fn();
    act(() =>
      root.render(
        <OnboardingTour
          open
          onOutcome={() => {}}
          onAssistantDemo={onAssistantDemo}
        />,
      ),
    );
    const advance = () => {
      act(() =>
        host.querySelector<HTMLButtonElement>(".cd-tour-btn--primary")?.click(),
      );
    };
    advance();
    advance();
    expect(host.textContent).toContain("Say what you need.");
    expect(host.querySelector(".cd-tour-chat-demo")).toBeNull();
    await vi.waitFor(() => expect(onAssistantDemo).toHaveBeenCalledWith(true));
  });

  it("sends a skip outcome from Skip for now", () => {
    const onOutcome = vi.fn();
    act(() => root.render(<OnboardingTour open onOutcome={onOutcome} />));
    act(() => host.querySelector<HTMLButtonElement>(".cd-tour-skip")?.click());
    expect(onOutcome).toHaveBeenCalledWith("skip");
  });

  it("finishes only after the final step", () => {
    const onOutcome = vi.fn();
    act(() => root.render(<OnboardingTour open onOutcome={onOutcome} />));
    const advance = () => {
      act(() =>
        host.querySelector<HTMLButtonElement>(".cd-tour-btn--primary")?.click(),
      );
    };
    for (let index = 0; index < 6; index += 1) {
      advance();
    }
    expect(host.textContent).toContain("Your first three moves.");
    expect(onOutcome).not.toHaveBeenCalled();
    advance();
    expect(onOutcome).toHaveBeenCalledWith("complete");
  });
});
