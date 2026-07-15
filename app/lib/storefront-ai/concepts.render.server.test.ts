import { describe, expect, it, vi } from "vitest";
import { createConcept, createContext } from "./__fixtures__/deterministic";
import { compileConceptCandidate, renderConceptWithMerchantData } from "./concepts.server";

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock("../browser/chromium.server", () => ({ launchChromium: launchMock }));

describe("concept Chromium render lifecycle", () => {
  it("captures readable overview and catalog evidence at desktop and mobile sizes", async () => {
    const screenshot = vi.fn(async () => new Uint8Array([1]));
    const page = {
      setContent: vi.fn(async () => undefined),
      setViewport: vi.fn(async () => undefined),
      evaluate: vi.fn()
        .mockResolvedValueOnce({ contentHeight: 12_000, catalogTop: 2_400 })
        .mockResolvedValueOnce({ contentHeight: 8_000, catalogTop: 1_600 }),
      screenshot,
    };
    launchMock.mockResolvedValueOnce({ close: vi.fn(async () => undefined), newPage: vi.fn(async () => page) });
    const candidate = { ...compileConceptCandidate(createConcept(0)), strategy: "asymmetric-commerce" as const };

    await renderConceptWithMerchantData({ candidate, context: createContext() });

    expect(page.setContent).toHaveBeenCalledWith(
      expect.stringContaining('data-cd-bundle="shell"'),
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(screenshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clip: { x: 0, y: 0, width: 1440, height: 800 },
      captureBeyondViewport: true,
    }));
    expect(screenshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clip: { x: 0, y: 2_200, width: 1440, height: 800 },
      captureBeyondViewport: true,
    }));
    expect(screenshot).toHaveBeenNthCalledWith(3, expect.objectContaining({
      clip: { x: 0, y: 0, width: 390, height: 844 },
      captureBeyondViewport: true,
    }));
    expect(screenshot).toHaveBeenNthCalledWith(4, expect.objectContaining({
      clip: { x: 0, y: 1_389, width: 390, height: 844 },
      captureBeyondViewport: true,
    }));
  });

  it("closes a browser that finishes launching after cancellation without opening a page", async () => {
    let finishLaunch!: (browser: { close: ReturnType<typeof vi.fn>; newPage: ReturnType<typeof vi.fn> }) => void;
    const close = vi.fn(async () => undefined);
    const newPage = vi.fn();
    launchMock.mockReturnValueOnce(new Promise((resolve) => { finishLaunch = resolve; }));
    const controller = new AbortController();
    const candidate = { ...compileConceptCandidate(createConcept(0)), strategy: "asymmetric-commerce" as const };

    const rendering = renderConceptWithMerchantData({ candidate, context: createContext(), signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    finishLaunch({ close, newPage });

    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(newPage).not.toHaveBeenCalled();
  });
});
