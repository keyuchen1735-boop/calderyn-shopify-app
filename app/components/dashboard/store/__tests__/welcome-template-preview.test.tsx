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
  it("shows a merchant-bound interactive recipe and honest original-build expectations", () => {
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

    clickButton(host, /Create something original/i);
    expect(host.textContent).toMatch(/Concept exploration.*visual judging.*browser proof/i);
    expect(host.textContent).toMatch(/Uses one AI design run/i);
    expect(host.querySelector(".cd-template-live__frame")).toBeNull();
    act(() => root.unmount());
  });
});
