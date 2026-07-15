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

  it("renders deterministic placeholders for concept assets that are produced only after judging", async () => {
    const page = {
      setContent: vi.fn(async () => undefined),
      setViewport: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ contentHeight: 844, catalogTop: 0 })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
    };
    launchMock.mockResolvedValueOnce({ close: vi.fn(async () => undefined), newPage: vi.fn(async () => page) });
    const source = createConcept(0);
    source.home.html = `<main><img data-cd-asset="hero" alt="Editorial hero" width="1600" height="1000"></main>`;
    source.assetRequests = [{ key: "hero", purpose: "Original editorial hero", required: true }];
    const candidate = { ...compileConceptCandidate(source), strategy: "asymmetric-commerce" as const };

    await renderConceptWithMerchantData({ candidate, context: createContext() });

    expect(page.setContent).toHaveBeenCalledWith(
      expect.stringMatching(/<img[^>]+data-cd-asset-key="hero"[^>]+src="data:image\/svg\+xml,/),
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("places the global shell footer after home content in judge evidence", async () => {
    const page = {
      setContent: vi.fn(async (_html: string, _options: object) => undefined),
      setViewport: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ contentHeight: 844, catalogTop: 0 })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
    };
    launchMock.mockResolvedValueOnce({ close: vi.fn(async () => undefined), newPage: vi.fn(async () => page) });
    const source = createConcept(0);
    source.shell.html = `<header>Global header</header><footer>Global footer</footer>`;
    source.shell.css = `a{color:red}header~footer{color:green}`;
    source.home.html = `<main><h1>Home content</h1><a data-cd-route="search">Route action</a></main>`;
    const candidate = { ...compileConceptCandidate(source), strategy: "asymmetric-commerce" as const };

    await renderConceptWithMerchantData({ candidate, context: createContext() });

    const document = page.setContent.mock.calls[0]?.[0] ?? "";
    expect(document.indexOf("Global header")).toBeLessThan(document.indexOf("Home content"));
    expect(document.indexOf("Home content")).toBeLessThan(document.indexOf("Global footer"));
    expect(document).toContain("[data-cd-bundle=shell] a:not([data-cd-bundle-route]):not([data-cd-bundle-route] *)");
    expect(document).toContain("[data-cd-bundle=shell] header~footer:not([data-cd-bundle-route]):not([data-cd-bundle-route] *)");
    expect(document).not.toContain("@scope");
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
