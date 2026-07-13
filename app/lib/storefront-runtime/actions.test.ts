// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { RuntimeActionSpec } from "~/lib/storefront-bundle/types";
import { executeRuntimeAction, type RuntimeActionContext } from "./actions";
import { createInitialRuntimeState } from "./state";

function setup() {
  document.body.innerHTML = `
    <main id="runtime-root">
      <section id="cd-home-tabs" role="tablist"></section>
      <section id="cd-home-gallery"></section>
      <section id="cd-home-carousel"><article>A</article><article>B</article></section>
      <section id="cd-home-scroll"></section>
    </main>`;
  const manifest = {
    version: 1 as const,
    state: [
      { id: "cd-home-state-tab", type: "enum" as const, initial: "one", allowedValues: ["one", "two"] },
      { id: "cd-home-state-slide", type: "index" as const, initial: 0, min: 0, max: 1 },
    ],
    bindings: [
      { targetId: "cd-home-tabs", property: "selected" as const, stateId: "cd-home-state-tab" },
      { targetId: "cd-home-carousel", property: "activeIndex" as const, stateId: "cd-home-state-slide" },
    ],
    transitions: [],
  };
  const intents: unknown[] = [];
  const context: RuntimeActionContext = {
    root: document.getElementById("runtime-root") as HTMLElement,
    manifest,
    state: createInitialRuntimeState(manifest),
    setState(next) { context.state = next; },
    applyBindings: vi.fn(),
    adapters: {
      collection: (intent) => intents.push(intent),
      search: (intent) => intents.push(intent),
      navigate: (intent) => intents.push(intent),
    },
    overlays: {
      open: vi.fn(), close: vi.fn(), toggle: vi.fn(), teardown: vi.fn(), isOpen: vi.fn(),
    },
  };
  return { context, intents };
}

describe("trusted runtime action dispatch", () => {
  it.each([
    ["surface.open", "open"],
    ["surface.close", "close"],
    ["surface.toggle", "toggle"],
  ] as const)("dispatches %s only to the platform overlay manager", (type, method) => {
    const { context } = setup();
    executeRuntimeAction(context, { type, surfaceId: "cd-home-gallery" }, new Event("click"), null);
    expect(context.overlays[method]).toHaveBeenCalledWith("cd-home-gallery", null);
  });

  it("selects tabs and gallery values and advances a bounded carousel", () => {
    const { context } = setup();
    executeRuntimeAction(context, {
      type: "tabs.select", targetId: "cd-home-tabs", value: { kind: "literal", value: "two" },
    }, new Event("click"), null);
    executeRuntimeAction(context, {
      type: "gallery.select", targetId: "cd-home-gallery", value: { kind: "literal", value: "media-2" },
    }, new Event("click"), null);
    executeRuntimeAction(context, {
      type: "carousel.next", targetId: "cd-home-carousel",
    }, new Event("click"), null);
    expect(context.state["cd-home-state-tab"]).toBe("two");
    expect(document.getElementById("cd-home-gallery")?.getAttribute("data-cd-active-value")).toBe("media-2");
    expect(context.state["cd-home-state-slide"]).toBe(1);
  });

  it("sends search, filter, sort, page, and navigation intents through injected adapters", () => {
    const { context, intents } = setup();
    const actions: RuntimeActionSpec[] = [
      { type: "collection.filter", facetId: "color", value: { kind: "literal", value: "red" } },
      { type: "collection.sort", value: { kind: "literal", value: "price-asc" } },
      { type: "collection.page", cursor: { kind: "literal", value: "cursor-2" } },
      { type: "search.update", query: { kind: "literal", value: "linen" } },
      { type: "search.submit", query: { kind: "literal", value: "linen" } },
      { type: "search.clear" },
      { type: "navigate", target: { routeId: "search", params: { query: { kind: "literal", value: "linen" } } } },
    ];
    actions.forEach((action) => executeRuntimeAction(context, action, new Event("click"), null));
    expect(intents).toEqual([
      { type: "filter", facetId: "color", value: "red" },
      { type: "sort", value: "price-asc" },
      { type: "page", cursor: "cursor-2" },
      { type: "update", query: "linen" },
      { type: "submit", query: "linen" },
      { type: "clear" },
      { routeId: "search", params: { query: "linen" } },
    ]);
  });

  it("rejects non-compiler targets and unsupported action objects", () => {
    const { context } = setup();
    expect(() => executeRuntimeAction(context, {
      type: "scroll.to", targetId: "body > *",
    }, new Event("click"), null)).toThrow(/compiler-issued/i);
    expect(() => executeRuntimeAction(context, {
      type: "cart.add",
    } as unknown as RuntimeActionSpec, new Event("click"), null)).toThrow(/unsupported/i);
  });
});
