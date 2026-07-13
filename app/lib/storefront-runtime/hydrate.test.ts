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
    const mount = vi.fn(({ shadowRoot, bridge }) => {
      const button = document.createElement("button");
      button.addEventListener("click", () => bridge({ type: "cart.add", variantId: "v1", quantity: 1 }));
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
    expect(dispatch).toHaveBeenCalledWith({ type: "cart.add", variantId: "v1", quantity: 1 });
    expect(host.shadowRoot).toBeNull();
  });

  it("is idempotent, tears down cleanly, and can hydrate again", () => {
    const root = rootMarkup();
    const first = hydrateStorefront({ root, artifact: artifact() });
    const second = hydrateStorefront({ root, artifact: artifact() });
    expect(second).toBe(first);
    first.teardown();
    const third = hydrateStorefront({ root, artifact: artifact() });
    expect(third).not.toBe(first);
    expect(third.hydrated).toBe(true);
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
