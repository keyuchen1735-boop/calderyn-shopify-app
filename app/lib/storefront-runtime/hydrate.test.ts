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

afterEach(() => {
  teardownStorefront();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("declarative storefront hydration", () => {
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

  it("rejects a cart-line mutation outside the trusted host authority", () => {
    document.body.innerHTML = `<main id="root"><div id="cd-cart-slot-1" data-cd-trusted-slot="cartLineControls" data-cd-authority-key="cartLine:line-1"></div></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const dispatch = vi.fn();
    const mount = vi.fn(({ bridge }) => {
      expect(() => bridge({ type: "cart.quantity", lineId: "line-2", quantity: 2 })).toThrow(/authority/i);
    });
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{ id: "cd-cart-slot-1", kind: "cartLineControls", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount, dispatch } },
    });
    expect(runtime.hydrated).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
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
    const before = root.innerHTML;
    const runtime = hydrateStorefront({
      root,
      artifact: artifact({
        requiredCapabilities: ["localState", "commerce"],
        trustedSlots: [{ id: "cd-product-slot-1", kind: "addToCart", scopeId: "root", hostSize: "block", themeTokenIds: [] }],
      }),
      adapters: { commerce: { mount: () => { throw new Error("mount failed"); }, dispatch: vi.fn() } },
    });
    expect(runtime.hydrated).toBe(false);
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
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

  it("keeps repeated state, bindings, and scroll targets inside the current compiler instance", () => {
    document.body.innerHTML = `<main id="root">
      <div data-cd-instance="one"><button id="cd-home-toggle-one" data-cd-instance="one">One</button><aside id="cd-home-drawer-one" data-cd-instance="one"></aside><div id="cd-home-scroll-one" data-cd-instance="one"></div></div>
      <div data-cd-instance="two"><button id="cd-home-toggle-two" data-cd-instance="two">Two</button><aside id="cd-home-drawer-two" data-cd-instance="two"></aside><div id="cd-home-scroll-two" data-cd-instance="two"></div></div>
    </main>`;
    const root = document.getElementById("root") as HTMLElement;
    const scrollOne = vi.fn();
    const scrollTwo = vi.fn();
    Object.defineProperty(document.getElementById("cd-home-scroll-one"), "scrollIntoView", { value: scrollOne });
    Object.defineProperty(document.getElementById("cd-home-scroll-two"), "scrollIntoView", { value: scrollTwo });
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
    document.getElementById("cd-home-toggle-two")?.click();
    expect((document.getElementById("cd-home-drawer-one") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("cd-home-drawer-two") as HTMLElement).hidden).toBe(true);
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
