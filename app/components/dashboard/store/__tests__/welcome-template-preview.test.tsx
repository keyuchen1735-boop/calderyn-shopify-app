// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WelcomeOverlay from "../WelcomeOverlay";

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn(), from: vi.fn(), set: vi.fn(), timeline: vi.fn() } }));
vi.mock("../../hero/hero-motion", () => ({ reduced: () => true }));
vi.mock("~/lib/dashboard/store-client", () => ({ resolveStudioDesign: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = "";
});

function clickButton(root: HTMLElement, label: RegExp) {
  const button = [...root.querySelectorAll("button")].find((candidate) => label.test(candidate.textContent ?? ""));
  expect(button).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("welcome template selection", () => {
  it("shows a merchant-bound first recipe and reserves full redesign for a follow-up prompt", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(
      <WelcomeOverlay
        branch={{ kind: "ready" }}
        importRun={null}
        buildPhase={null}
        productCount={3}
        onBuildPlain={() => undefined}
        onBuildDesign={() => undefined}
        onAddProduct={() => undefined}
      />,
    ));

    clickButton(host, /How should it look/i);
    clickButton(host, /Commons Index/i);
    const frame = host.querySelector<HTMLIFrameElement>('iframe[title*="Commons Index"]');
    expect(frame?.getAttribute("src")).toBe("/dashboard/store/preview?template=commons-index&route=home");
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(host.textContent).toMatch(/with your store data/i);
    expect(host.textContent).toMatch(/no AI design credit/i);

    expect([...host.querySelectorAll("button")].some((button) => /Create something original/i.test(button.textContent ?? ""))).toBe(false);
    expect(host.textContent).toMatch(/full redesign.*after.*first draft/i);
    act(() => root.unmount());
  });
});
