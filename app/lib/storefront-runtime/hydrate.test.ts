// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { RouteArtifact } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "./hydrate";

function artifact(overrides: Partial<RouteArtifact> = {}): RouteArtifact {
  return {
    html: "", tree: [], bindings: [], css: "", requiredData: [],
    requiredCapabilities: ["localState"], trustedSlots: [],
    interactions: {
      version: 1,
      state: [
        { id: "cd-home-state-open", type: "boolean", initial: false },
        { id: "cd-home-state-progress", type: "boundedNumber", initial: 0, min: 0, max: 1 },
      ],
      bindings: [
        { targetId: "cd-home-drawer", property: "hidden", stateId: "cd-home-state-open" },
        { targetId: "cd-home-progress", property: "progress01", stateId: "cd-home-state-progress" },
      ],
      transitions: [
        { on: "click", sourceId: "cd-home-toggle", action: { type: "state.set", stateId: "cd-home-state-open", value: { kind: "literal", value: true } } },
        { on: "scrollProgress", sourceId: "cd-home-progress-source", action: { type: "state.set", stateId: "cd-home-state-progress", value: { kind: "event", field: "progress01" } } },
      ],
    },
    ...overrides,
  };
}

function rootMarkup() {
  document.body.innerHTML = `
    <main id="root">
      <button id="cd-home-toggle">Toggle</button>
      <aside id="cd-home-drawer">Fallback content</aside>
      <div id="cd-home-progress-source"></div>
      <div id="cd-home-progress"></div>
    </main>`;
  return document.getElementById("root") as HTMLElement;
}

function installWebGl(): void {
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    NO_ERROR: 0,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getError: vi.fn(() => 0),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => ({ name })),
    uniform3fv: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    viewport: vi.fn(),
    drawArrays: vi.fn(),
    getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
  } as unknown as WebGLRenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as never);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

afterEach(() => {
  teardownStorefront();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("declarative storefront hydration", () => {
  it("pauses recipe video off screen and resumes it on return", async () => {
    document.body.innerHTML = `<main id="root"><video data-cd-video autoplay muted loop playsinline poster="/poster.webp"></video></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const video = root.querySelector("video")!;
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    let callback: IntersectionObserverCallback = () => undefined;
    const disconnect = vi.fn();
    class Observer {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() { disconnect(); }
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    hydrateStorefront({ root, artifact: artifact({ requiredCapabilities: [], interactions: { version: 1, state: [], bindings: [], transitions: [] } }) });

    callback([{ target: video, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(pause).toHaveBeenCalledOnce();
    callback([{ target: video, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
  });

  it("pins recipe video to its poster under reduced motion", () => {
    document.body.innerHTML = `<main id="root"><video data-cd-video autoplay muted loop playsinline poster="/poster.webp"></video></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const video = root.querySelector("video")!;
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });

    hydrateStorefront({ root, artifact: artifact({ requiredCapabilities: [], interactions: { version: 1, state: [], bindings: [], transitions: [] } }) });

    expect(video.autoplay).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    expect(video.poster).toContain("/poster.webp");
  });

  it("retains the poster when recipe video playback fails", async () => {
    document.body.innerHTML = `<main id="root"><video data-cd-video autoplay poster="/poster.webp"></video></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const video = root.querySelector("video")!;
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    vi.spyOn(video, "play").mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    let callback: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    });
    hydrateStorefront({ root, artifact: artifact({ requiredCapabilities: [], interactions: { version: 1, state: [], bindings: [], transitions: [] } }) });

    callback([{ target: video, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    await Promise.resolve();
    await Promise.resolve();
    expect(video.poster).toContain("/poster.webp");
    expect(video.dataset.cdVideoFallback).toBe("poster");
  });

  it("disconnects and pauses recipe video during teardown", () => {
    document.body.innerHTML = `<main id="root"><video data-cd-video autoplay poster="/poster.webp"></video></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const video = root.querySelector("video")!;
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() { disconnect(); } });
    const runtime = hydrateStorefront({ root, artifact: artifact({ requiredCapabilities: [], interactions: { version: 1, state: [], bindings: [], transitions: [] } }) });

    runtime.teardown();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it("mounts a typed visual only at the server-issued host and restores the fallback", () => {
    installWebGl();
    document.body.innerHTML = `<main id="root">
      <figure data-cd-visual-host><img data-cd-asset-key="hero" data-cd-visual-fallback></figure>
      <figure data-cd-visual-slot="visual:unregistered" data-fx-shader="void main(){}"></figure>
    </main>`;
    const root = document.getElementById("root") as HTMLElement;
    const fallback = root.querySelector<HTMLElement>("[data-cd-asset-key='hero']")!;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: [],
        interactions: { version: 1, state: [], bindings: [], transitions: [] },
      }),
      visualLayer: {
        kind: "fragment_shader",
        source: "void main(){gl_FragColor=vec4(1.0);}",
        colors: ["#000000", "#111111", "#222222"],
      },
    });

    expect(runtime.hydrated).toBe(true);
    expect(root.querySelector("[data-cd-visual-host] canvas")).not.toBeNull();
    expect(root.querySelector("[data-cd-visual-slot='visual:unregistered'] canvas")).toBeNull();
    expect(fallback.style.visibility).toBe("hidden");

    runtime.teardown();
    expect(root.querySelector("canvas")).toBeNull();
    expect(fallback.style.visibility).toBe("");
  });

  it("does not let shell hydration mount a visual owned by the nested route", () => {
    installWebGl();
    document.body.innerHTML = `<main data-cd-bundle-shell="home">
      <section data-cd-bundle-route="home">
        <figure data-cd-visual-host><img data-cd-asset-key="hero" data-cd-visual-fallback></figure>
      </section>
    </main>`;
    const shell = document.querySelector<HTMLElement>("[data-cd-bundle-shell]")!;
    const route = document.querySelector<HTMLElement>("[data-cd-bundle-route]")!;
    const visualLayer = {
      kind: "fragment_shader" as const,
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"] as [string, string, string],
    };
    const emptyArtifact = artifact({
      requiredCapabilities: [],
      interactions: { version: 1, state: [], bindings: [], transitions: [] },
    });

    hydrateStorefront({ root: shell, artifact: emptyArtifact, visualLayer });
    expect(shell.querySelector("canvas")).toBeNull();
    hydrateStorefront({ root: route, artifact: emptyArtifact, visualLayer });
    expect(route.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("hydrates compiler-issued transitions and applies bounded scroll progress", () => {
    const root = rootMarkup();
    const source = document.getElementById("cd-home-progress-source") as HTMLElement;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      x: 0, y: -50, top: -50, left: 0, right: 100, bottom: 50, width: 100, height: 100, toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });
    const runtime = hydrateStorefront({ root, artifact: artifact() });
    expect(runtime.hydrated).toBe(true);
    document.getElementById("cd-home-toggle")?.click();
    expect((document.getElementById("cd-home-drawer") as HTMLElement).hidden).toBe(true);
    window.dispatchEvent(new Event("scroll"));
    expect(document.getElementById("cd-home-progress")?.style.getPropertyValue("--cd-progress")).toBe("0.75");
  });

  it("fixes progress effects at rest when reduced motion is requested", () => {
    const root = rootMarkup();
    const matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    hydrateStorefront({ root, artifact: artifact() });
    expect(document.getElementById("cd-home-progress")?.style.getPropertyValue("--cd-progress")).toBe("1");
  });

  it("mounts compiler-authorized commerce hosts in closed Shadow DOM with only the trusted bridge", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const host = document.getElementById("cd-product-slot-1") as HTMLElement;
    const dispatch = vi.fn();
    let bridge: ((intent: unknown) => void) | undefined;
    const mount = vi.fn(({ shadowRoot, bridge: trustedBridge }) => {
      bridge = trustedBridge;
      const button = document.createElement("button");
      button.addEventListener("click", () => trustedBridge({ type: "cart.add", productId: "p1", variantId: "v1", quantity: 1 }));
      shadowRoot.append(button);
      button.click();
    });
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"],
        interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount, dispatch } },
    });
    expect(runtime.hydrated).toBe(true);
    expect(mount).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      authorityKey: "product:p1",
      slotKind: "addToCart",
      intent: { type: "cart.add", productId: "p1", variantId: "v1", quantity: 1 },
    });
    expect(() => bridge?.({ type: "cart.add", productId: "p2", variantId: "v2", quantity: 1 })).toThrow(/authority/i);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(host.shadowRoot).toBeNull();
  });

  it("rejects unbounded personalization before trusted commerce dispatch", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    let bridge: ((intent: unknown) => void) | undefined;
    const dispatch = vi.fn();
    hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"],
        interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{
          id: "cd-product-slot-1", kind: "addToCart", hostSize: "block", themeTokenIds: [],
          personalizationFields: ["engraving"],
        }],
      }),
      adapters: { commerce: {
        mount: ({ bridge: trustedBridge }) => { bridge = trustedBridge as (intent: unknown) => void; },
        dispatch,
      } },
    });

    bridge?.({
      type: "cart.add", productId: "p1", variantId: "v1", quantity: 1,
      personalization: { engraving: "Always" },
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ personalization: { engraving: "Always" } }),
    }));
    expect(() => bridge?.({
      type: "cart.add", productId: "p1", variantId: "v1", quantity: 1,
      personalization: { engraving: "x".repeat(241) },
    })).toThrow(/authority/i);
    expect(() => bridge?.({
      type: "cart.add", productId: "p1", variantId: "v1", quantity: 1,
      personalization: { giftWrap: "gold" },
    })).toThrow(/authority/i);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("mounts on the retained live host and root so async updates and cleanup stay live", async () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const liveHost = document.getElementById("cd-product-slot-1") as HTMLElement;
    let retainedHost: HTMLElement | undefined;
    let retainedRoot: ShadowRoot | undefined;
    let cleanupSawAsyncUpdate = false;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: {
        mount: ({ host, shadowRoot }) => {
          retainedHost = host;
          retainedRoot = shadowRoot;
          expect(host).toBe(liveHost);
          expect(host.isConnected).toBe(true);
          expect(host.hidden).toBe(true);
          expect(host.getAttribute("data-cd-commerce-state")).toBe("pending");
          shadowRoot.innerHTML = `<button id="live-buy">Buy</button>`;
          queueMicrotask(() => {
            const asyncUpdate = document.createElement("span");
            asyncUpdate.setAttribute("data-async-update", "");
            shadowRoot.append(asyncUpdate);
          });
          return () => {
            cleanupSawAsyncUpdate = shadowRoot.querySelector("[data-async-update]") !== null;
            shadowRoot.querySelector("[data-async-update]")?.remove();
          };
        },
        dispatch: vi.fn(),
      } },
    });
    expect(runtime.hydrated).toBe(true);
    expect(retainedHost).toBe(liveHost);
    expect(liveHost.hidden).toBe(false);
    expect(liveHost.hasAttribute("data-cd-commerce-state")).toBe(false);
    await Promise.resolve();
    expect(retainedRoot?.querySelector("[data-async-update]")).not.toBeNull();
    runtime.teardown();
    expect(cleanupSawAsyncUpdate).toBe(true);
    expect(retainedRoot?.querySelector("[data-async-update]")).toBeNull();
  });

  it("rejects a cart-line mutation outside the trusted host authority", () => {
    document.body.innerHTML = `<main id="root"><div data-cd-instance="i-cart-line-1"><div id="cd-cart-slot-1-i-cart-line-1" data-cd-instance="i-cart-line-1" data-cd-trusted-slot="cartLineControls" data-cd-slot-scope="cd-cart-scope-1" data-cd-authority-key="cartLine:line-1"></div></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const dispatch = vi.fn();
    const mount = vi.fn(({ bridge }) => {
      expect(() => bridge({ type: "cart.quantity", lineId: "line-2", quantity: 2 })).toThrow(/authority/i);
    });
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-cart-slot-1", kind: "cartLineControls", scopeId: "cd-cart-scope-1", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount, dispatch } },
    });
    expect(runtime.hydrated).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails runtime validation for root-scoped cart-line controls", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-cart-slot-1" data-cd-trusted-slot="cartLineControls" data-cd-slot-scope="root" data-cd-authority-key="cartLine:line-1"></div></main>`;
    const mount = vi.fn();
    const runtime = hydrateStorefront({
      root: document.getElementById("root") as HTMLElement,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-cart-slot-1", kind: "cartLineControls", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount, dispatch: vi.fn() } },
    });
    expect(runtime.hydrated).toBe(false);
    expect(runtime.error?.message).toMatch(/cartLine.*scope/i);
    expect(mount).not.toHaveBeenCalled();
  });

  it("is idempotent, tears down cleanly, and can hydrate again", () => {
    const root = rootMarkup();
    const before = root.innerHTML;
    const first = hydrateStorefront({ root, artifact: artifact() });
    const second = hydrateStorefront({ root, artifact: artifact() });
    expect(second).toBe(first);
    first.teardown();
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
    const third = hydrateStorefront({ root, artifact: artifact() });
    expect(third).not.toBe(first);
    expect(third.hydrated).toBe(true);
  });

  it("rolls back binding mutations when trusted mounting fails", () => {
    const root = rootMarkup();
    root.insertAdjacentHTML("beforeend", `<div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div>`);
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["localState", "commerce"],
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount: () => { throw new Error("mount failed"); }, dispatch: vi.fn() } },
    });
    expect(runtime.hydrated).toBe(false);
    expect((document.getElementById("cd-home-drawer") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("cd-home-progress")?.getAttribute("style")).toBeNull();
    expect((document.getElementById("cd-product-slot-1") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("cd-product-slot-1")?.getAttribute("data-cd-commerce-state")).toBe("unavailable");
    expect(document.getElementById("cd-product-slot-1")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
  });

  it("never exposes partial commerce UI when a closed-shadow mount throws", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const host = document.getElementById("cd-product-slot-1") as HTMLElement;
    const nativeAttach = host.attachShadow.bind(host);
    let actualShadow: ShadowRoot | undefined;
    vi.spyOn(host, "attachShadow").mockImplementation((init) => {
      actualShadow = nativeAttach(init);
      return actualShadow;
    });
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: {
        mount: ({ shadowRoot }) => {
          expect(host.hidden).toBe(true);
          expect(host.getAttribute("data-cd-commerce-state")).toBe("pending");
          shadowRoot.innerHTML = `<button data-partial-commerce>Buy</button>`;
          throw new Error("mount failed after mutation");
        },
        dispatch: vi.fn(),
      } },
    });
    expect(runtime.hydrated).toBe(false);
    expect(actualShadow).toBeDefined();
    expect(actualShadow?.querySelector("[data-partial-commerce]")).toBeNull();
    const unavailable = actualShadow?.querySelector<HTMLElement>("[data-cd-commerce-unavailable]");
    expect(unavailable?.getAttribute("role")).toBe("status");
    expect(unavailable?.getAttribute("aria-live")).toBe("polite");
    expect(unavailable?.textContent).toMatch(/commerce unavailable/i);
    expect(host.shadowRoot).toBeNull();
    expect(host.hidden).toBe(false);
    expect(host.getAttribute("data-cd-commerce-state")).toBe("unavailable");
    expect(host.getAttribute("aria-disabled")).toBe("true");
    expect(host.getAttribute("data-cd-commerce-state")).not.toBe("pending");
  });

  it("tabs through generated and trusted closed-shadow controls in DOM order", () => {
    document.body.innerHTML = `<main id="root">
      <button id="cd-home-open">Open</button>
      <section id="cd-home-drawer" hidden>
        <button id="before">Before</button>
        <div id="cd-home-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div>
        <button id="after">After</button>
      </section>
    </main>`;
    const root = document.getElementById("root") as HTMLElement;
    let trustedRoot: ShadowRoot | undefined;
    let trustedButton: HTMLButtonElement | undefined;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce", "overlay", "localState"],
        interactions: {
          version: 1, state: [], bindings: [],
          transitions: [{ on: "click", sourceId: "cd-home-open", action: { type: "surface.open", surfaceId: "cd-home-drawer" } }],
        },
        trustedSlots: [{ id: "cd-home-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: {
        mount: ({ shadowRoot }) => {
          trustedRoot = shadowRoot;
          trustedButton = document.createElement("button");
          trustedButton.id = "trusted";
          trustedButton.textContent = "Trusted";
          shadowRoot.append(trustedButton);
        },
        dispatch: vi.fn(),
      } },
    });
    expect(runtime.hydrated).toBe(true);
    document.getElementById("cd-home-open")?.click();
    expect(document.activeElement?.id).toBe("before");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(trustedRoot?.activeElement).toBe(trustedButton);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement?.id).toBe("after");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(trustedRoot?.activeElement).toBe(trustedButton);
  });

  it("exhausts hydration rollback and reports restoration errors", () => {
    const root = rootMarkup();
    root.insertAdjacentHTML("beforeend", `<div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div>`);
    const drawer = document.getElementById("cd-home-drawer") as HTMLElement;
    const nativeRemoveAttribute = drawer.removeAttribute.bind(drawer);
    vi.spyOn(drawer, "removeAttribute")
      .mockImplementationOnce(() => { throw new Error("attribute restore failed"); })
      .mockImplementation((name) => nativeRemoveAttribute(name));
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["localState", "commerce"],
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount: () => { throw new Error("mount failed"); }, dispatch: vi.fn() } },
    });
    expect(runtime.hydrated).toBe(false);
    expect(runtime.error?.message).toMatch(/rollback|restor/i);
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
    expect(document.getElementById("cd-home-progress")?.getAttribute("style")).toBeNull();
  });

  it("runs every cleanup and restores SSR state when one cleanup throws", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div><div id="cd-product-slot-2" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p2"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const before = root.innerHTML;
    const firstCleanup = vi.fn(() => { throw new Error("cleanup failed"); });
    const secondCleanup = vi.fn();
    const cleanups = [firstCleanup, secondCleanup];
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [
          { id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] },
          { id: "cd-product-slot-2", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] },
        ],
      }),
      adapters: { commerce: { mount: () => cleanups.shift()!, dispatch: vi.fn() } },
    });
    expect(() => runtime.teardown()).toThrow(AggregateError);
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).toHaveBeenCalledOnce();
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
  });

  it("can remount a trusted closed-shadow host after teardown", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-product-slot-1" data-cd-trusted-slot="addToCart" data-cd-authority-key="product:p1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const commerceArtifact = artifact({
      requiredCapabilities: ["commerce"],
      interactions: { version: 1, state: [], bindings: [], transitions: [] },
      trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
    });
    const mount = vi.fn();
    const adapters = { commerce: { mount, dispatch: vi.fn() } };
    const first = hydrateStorefront({ root, artifact: commerceArtifact, adapters });
    first.teardown();
    const second = hydrateStorefront({ root, artifact: commerceArtifact, adapters });
    expect(first.hydrated).toBe(true);
    expect(second.hydrated).toBe(true);
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it("allows a repeated trusted slot to have no host when the repeated data set is empty", () => {
    document.body.innerHTML = `<main id="root"></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const mount = vi.fn();
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"],
        interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{
          id: "cd-home-slot-1",
          kind: "quickViewCommerce",
          scopeId: "cd-home-scope-1",
          hostSize: "panel",
          themeTokenIds: ["ink", "paper"],
        }],
      }),
      adapters: { commerce: { mount, dispatch: vi.fn() } },
    });

    expect(runtime.hydrated).toBe(true);
    expect(mount).not.toHaveBeenCalled();
  });

  it("keeps repeated state, bindings, and scroll targets inside the current compiler instance", () => {
    document.body.innerHTML = `<main id="root">
      <div data-cd-instance="i-parent-a-child-same"><button id="cd-home-toggle-i-parent-a-child-same" data-cd-instance="i-parent-a-child-same">One</button><aside id="cd-home-drawer-i-parent-a-child-same" data-cd-instance="i-parent-a-child-same"></aside><div id="cd-home-scroll-i-parent-a-child-same" data-cd-instance="i-parent-a-child-same"></div></div>
      <div data-cd-instance="i-parent-b-child-same"><button id="cd-home-toggle-i-parent-b-child-same" data-cd-instance="i-parent-b-child-same">Two</button><aside id="cd-home-drawer-i-parent-b-child-same" data-cd-instance="i-parent-b-child-same"></aside><div id="cd-home-scroll-i-parent-b-child-same" data-cd-instance="i-parent-b-child-same"></div></div>
    </main>`;
    const root = document.getElementById("root") as HTMLElement;
    const scrollOne = vi.fn();
    const scrollTwo = vi.fn();
    Object.defineProperty(document.getElementById("cd-home-scroll-i-parent-a-child-same"), "scrollIntoView", { value: scrollOne });
    Object.defineProperty(document.getElementById("cd-home-scroll-i-parent-b-child-same"), "scrollIntoView", { value: scrollTwo });
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        interactions: {
          version: 1,
          state: [{ id: "cd-home-state-open", type: "boolean", initial: false }],
          bindings: [{ targetId: "cd-home-drawer", property: "hidden", stateId: "cd-home-state-open" }],
          transitions: [
            { on: "click", sourceId: "cd-home-toggle", action: { type: "state.set", stateId: "cd-home-state-open", value: { kind: "literal", value: true } } },
            { on: "click", sourceId: "cd-home-toggle", action: { type: "scroll.to", targetId: "cd-home-scroll" } },
          ],
        },
      }),
    });
    expect(runtime.hydrated).toBe(true);
    document.getElementById("cd-home-toggle-i-parent-b-child-same")?.click();
    expect((document.getElementById("cd-home-drawer-i-parent-a-child-same") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("cd-home-drawer-i-parent-b-child-same") as HTMLElement).hidden).toBe(true);
    expect(scrollOne).not.toHaveBeenCalled();
    expect(scrollTwo).toHaveBeenCalledOnce();
  });

  it("does not treat an unrelated ID prefix as a repeated compiler instance", () => {
    const root = rootMarkup();
    root.insertAdjacentHTML("beforeend", `<aside id="cd-home-drawer-extra"></aside>`);
    const unrelated = document.getElementById("cd-home-drawer-extra") as HTMLElement;
    const runtime = hydrateStorefront({ root, artifact: artifact() });
    expect(runtime.hydrated).toBe(true);
    document.getElementById("cd-home-toggle")?.click();
    expect((document.getElementById("cd-home-drawer") as HTMLElement).hidden).toBe(true);
    expect(unrelated.hidden).toBe(false);
  });

  it("preserves SSR markup and installs no listeners for unsupported capabilities or malformed IDs", () => {
    const root = rootMarkup();
    const before = root.innerHTML;
    const unsupported = hydrateStorefront({
      root,
      artifact: artifact({ requiredCapabilities: ["localState", "futureCapability"] as RouteArtifact["requiredCapabilities"] }),
    });
    expect(unsupported.hydrated).toBe(false);
    expect(root.innerHTML).toBe(before);
    expect(() => hydrateStorefront({
      root,
      artifact: artifact({
        interactions: {
          ...artifact().interactions,
          transitions: [{ on: "click", sourceId: "body > *", action: { type: "search.clear" } }],
        },
      }),
    })).not.toThrow();
    expect(root.innerHTML).toBe(before);
  });

  it("leaves the SSR route untouched when a required trusted adapter is absent", () => {
    const root = rootMarkup();
    const before = root.innerHTML;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["catalogFiltering"],
        interactions: { version: 1, state: [], bindings: [], transitions: [] },
      }),
    });
    expect(runtime.hydrated).toBe(false);
    expect(runtime.error?.message).toMatch(/adapter/i);
    expect(root.innerHTML).toBe(before);
  });

  it("fails closed before mutation when navigation has no trusted adapter", () => {
    const root = rootMarkup();
    const before = root.innerHTML;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({ requiredCapabilities: ["navigation", "localState"] }),
    });
    expect(runtime.hydrated).toBe(false);
    expect(runtime.error?.message).toMatch(/navigation.*adapter/i);
    expect(root.innerHTML).toBe(before);
  });

  it("rejects an unvalidated route target instead of forwarding an arbitrary destination", () => {
    const root = rootMarkup();
    const navigate = vi.fn();
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["navigation", "localState"],
        interactions: {
          version: 1,
          state: [],
          bindings: [],
          transitions: [{
            on: "click",
            sourceId: "cd-home-toggle",
            action: { type: "navigate", target: { routeId: "https://evil.example", params: {} } },
          }] as unknown as RouteArtifact["interactions"]["transitions"],
        },
      }),
      adapters: { navigate },
    });
    expect(runtime.hydrated).toBe(false);
    document.getElementById("cd-home-toggle")?.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("contains no arbitrary network or executable-code path", () => {
    const files = ["state.ts", "actions.ts", "overlays.ts", "hydrate.ts", "index.client.ts"];
    const source = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bFunction\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
