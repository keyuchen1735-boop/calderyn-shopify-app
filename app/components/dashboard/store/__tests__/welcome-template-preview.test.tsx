// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WelcomeOverlay from "../WelcomeOverlay";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn(), from: vi.fn() } }));
vi.mock("../../hero/hero-motion", () => ({ reduced: () => true }));

afterEach(() => {
  document.body.innerHTML = "";
});

function click(root: HTMLElement, label: RegExp) {
  const button = [...root.querySelectorAll("button")].find((candidate) => label.test(candidate.textContent ?? ""));
  expect(button).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("welcome visual direction", () => {
  it("sends the default non-empty prompt through the same command callback", () => {
    const onBuildPrompt = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(
      <WelcomeOverlay
        branch={{ kind: "ready" }}
        importRun={null}
        buildPhase={null}
        productCount={3}
        onBuildPrompt={onBuildPrompt}
        onAddProduct={() => undefined}
      />,
    ));

    click(host, /Let's build my store/i);
    expect(onBuildPrompt).toHaveBeenCalledWith("Build my store");
    expect(host.textContent).not.toMatch(/recipe|template|compiler|runtime|custom-derived/i);
    expect(host.querySelector('iframe[src*="template="]')).toBeNull();
    act(() => root.unmount());
  });

  it("sends the merchant's visual-direction prompt without exposing registry choices", () => {
    const onBuildPrompt = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(
      <WelcomeOverlay
        branch={{ kind: "ready" }}
        importRun={null}
        buildPhase={null}
        productCount={3}
        onBuildPrompt={onBuildPrompt}
        onAddProduct={() => undefined}
      />,
    ));
    click(host, /How should it look/i);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Describe your store\'s visual direction"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Quiet editorial skincare");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(host, /Build my store/i);
    expect(onBuildPrompt).toHaveBeenCalledWith("Quiet editorial skincare");
    expect(host.querySelectorAll("iframe")).toHaveLength(0);
    act(() => root.unmount());
  });
});
