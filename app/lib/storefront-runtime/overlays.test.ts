// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverlayManager } from "./overlays";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("platform overlay portal", () => {
  it("traps focus, makes the background inert, closes on Escape, and restores focus", () => {
    document.body.innerHTML = `
      <main id="root"><button id="opener">Open</button><section id="cd-home-drawer" hidden><button id="first">First</button><button id="last">Last</button></section></main>
      <footer id="background" inert aria-hidden="false"><button id="outside">Outside</button></footer>`;
    const root = document.getElementById("root") as HTMLElement;
    const opener = document.getElementById("opener") as HTMLButtonElement;
    const drawer = document.getElementById("cd-home-drawer") as HTMLElement;
    const background = document.getElementById("background") as HTMLElement;
    document.body.style.overflow = "clip";
    opener.focus();
    const manager = createOverlayManager(root);
    manager.open(drawer.id, opener);
    expect(drawer.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(true);
    expect(drawer.parentElement?.getAttribute("data-cd-bundle")).toBe("home");
    expect(root.hasAttribute("inert")).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.id).toBe("first");

    (document.getElementById("outside") as HTMLButtonElement).focus();
    expect(document.activeElement?.id).toBe("first");

    const last = document.getElementById("last") as HTMLButtonElement;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement?.id).toBe("first");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.hidden).toBe(true);
    expect(drawer.parentElement).toBe(root);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(opener);
  });

  it("owns a fixed top layer, backdrop, and presentation surface around projected content", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-drawer"><p>Projected</p></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-drawer", null);
    const portal = document.querySelector<HTMLElement>("[data-cd-overlay-portal]")!;
    const backdrop = portal.querySelector<HTMLElement>("[data-cd-overlay-backdrop]")!;
    const presentation = portal.querySelector<HTMLElement>("[data-cd-overlay-presentation]")!;
    expect(portal.style.position).toBe("fixed");
    expect(portal.style.inset).toBe("0");
    expect(Number(portal.style.zIndex)).toBeGreaterThan(1_000_000);
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.style.position).toBe("absolute");
    expect(presentation.style.pointerEvents).toBe("auto");
    expect(presentation.style.getPropertyValue("--cd-overlay-surface")).not.toBe("");
    expect(presentation.querySelector("#cd-home-drawer")?.textContent).toContain("Projected");
    expect(portal.querySelectorAll(":scope > #cd-home-drawer")).toHaveLength(0);
    manager.teardown();
  });

  it("keeps focus and background ownership with the top overlay in a stack", () => {
    document.body.innerHTML = `
      <main id="root"><button id="root-opener">Open A</button><section id="cd-home-a" hidden><button id="a-opener">Open B</button></section><section id="cd-home-b" hidden><button id="b-focus">B</button></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const rootOpener = document.getElementById("root-opener") as HTMLButtonElement;
    const aOpener = document.getElementById("a-opener") as HTMLButtonElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", rootOpener);
    manager.open("cd-home-b", aOpener);
    const presentations = document.querySelectorAll<HTMLElement>("[data-cd-overlay-presentation]");
    const aPresentation = [...presentations].find((item) => item.contains(document.getElementById("cd-home-a")))!;
    const bPresentation = [...presentations].find((item) => item.contains(document.getElementById("cd-home-b")))!;
    expect(aPresentation.hasAttribute("inert")).toBe(true);
    expect(aPresentation.getAttribute("aria-hidden")).toBe("true");
    expect(document.getElementById("cd-home-a")?.getAttribute("aria-modal")).not.toBe("true");
    expect(bPresentation.hasAttribute("inert")).toBe(false);
    expect(bPresentation.hasAttribute("aria-hidden")).toBe(false);
    expect(document.getElementById("cd-home-b")?.getAttribute("aria-modal")).toBe("true");
    manager.close("cd-home-b", aOpener);
    expect(document.activeElement).toBe(aOpener);
    expect(aPresentation.hasAttribute("inert")).toBe(false);
    expect(aPresentation.hasAttribute("aria-hidden")).toBe(false);
    expect(document.getElementById("cd-home-a")?.getAttribute("aria-modal")).toBe("true");
    expect(root.hasAttribute("inert")).toBe(true);
    manager.close("cd-home-a", rootOpener);
    expect(document.activeElement).toBe(rootOpener);
    expect(root.hasAttribute("inert")).toBe(false);

    manager.open("cd-home-a", rootOpener);
    manager.open("cd-home-b", aOpener);
    manager.close("cd-home-a", rootOpener);
    expect(document.activeElement?.id).toBe("b-focus");
    expect(root.hasAttribute("inert")).toBe(true);
    manager.teardown();
  });

  it("restores the source surface's original visibility and ARIA state on close", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a" role="region" tabindex="2" aria-modal="false">Visible</section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const surface = document.getElementById("cd-home-a") as HTMLElement;
    const manager = createOverlayManager(root);
    manager.open(surface.id, null);
    manager.close(surface.id, null);
    expect(surface.hidden).toBe(false);
    expect(surface.getAttribute("role")).toBe("region");
    expect(surface.getAttribute("tabindex")).toBe("2");
    expect(surface.getAttribute("aria-modal")).toBe("false");
    manager.teardown();
  });

  it("projects commerce above generated stacking contexts with a measured flow placeholder", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div id="row"><span id="before"></span><div id="slot" data-cd-trusted-slot="addToCart" style="display: block; margin: 3px 4px 5px 6px;"></div><div id="cover" style="opacity: 0.5; transform: translateZ(0); z-index: 2147483647;"></div></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const surface = document.getElementById("cd-home-a") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    const row = document.getElementById("row") as HTMLElement;
    const before = document.getElementById("before") as HTMLElement;
    const cover = document.getElementById("cover") as HTMLElement;
    const originalSlotStyle = slot.getAttribute("style");
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(12, 34, 120, 40));
    const manager = createOverlayManager(root);
    manager.open(surface.id, null);
    const portal = document.querySelector<HTMLElement>("[data-cd-overlay-portal]")!;
    const presentation = document.querySelector<HTMLElement>("[data-cd-overlay-presentation]")!;
    const layer = portal.querySelector<HTMLElement>("[data-cd-overlay-commerce-layer]")!;
    const placeholder = row.querySelector<HTMLElement>("[data-cd-overlay-commerce-placeholder]")!;
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(portal);
    expect(Number(layer.style.zIndex)).toBeGreaterThan(Number(presentation.style.zIndex));
    expect(layer.contains(slot)).toBe(true);
    expect(presentation.contains(slot)).toBe(false);
    expect(placeholder.previousElementSibling).toBe(before);
    expect(placeholder.nextElementSibling).toBe(cover);
    expect(placeholder.style.display).toBe("block");
    expect(placeholder.style.width).toBe("120px");
    expect(placeholder.style.height).toBe("40px");
    expect(placeholder.style.margin).toBe("3px 4px 5px 6px");
    expect(slot.style.position).toBe("absolute");
    expect(slot.style.left).toBe("12px");
    expect(slot.style.top).toBe("34px");
    expect(cover.getAttribute("style")).toBe("opacity: 0.5; transform: translateZ(0); z-index: 2147483647;");
    expect(slot.style.pointerEvents).toBe("auto");
    manager.close(surface.id, null);
    expect(slot.parentElement).toBe(row);
    expect(slot.previousElementSibling).toBe(before);
    expect(slot.nextElementSibling).toBe(cover);
    expect(slot.getAttribute("style")).toBe(originalSlotStyle);
    expect(document.querySelector("[data-cd-overlay-commerce-layer]")).toBeNull();
    expect(document.querySelector("[data-cd-overlay-commerce-placeholder]")).toBeNull();
    manager.teardown();
  });

  it("syncs projected geometry on scroll, resize, and placeholder resize", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div id="slot" data-cd-trusted-slot="addToCart"></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(1, 2, 30, 40));
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    const placeholder = document.querySelector<HTMLElement>("[data-cd-overlay-commerce-placeholder]")!;
    expect(placeholder).not.toBeNull();
    const placeholderRect = vi.spyOn(placeholder, "getBoundingClientRect");
    placeholderRect.mockReturnValue(rect(11, 22, 130, 140));
    window.dispatchEvent(new Event("scroll"));
    expect(slot.style.left).toBe("11px");
    expect(slot.style.top).toBe("22px");
    expect(slot.style.width).toBe("130px");
    expect(slot.style.height).toBe("140px");
    placeholderRect.mockReturnValue(rect(21, 32, 230, 240));
    window.dispatchEvent(new Event("resize"));
    expect(slot.style.left).toBe("21px");
    resizeCallback?.([], {} as ResizeObserver);
    expect(observe).toHaveBeenCalledWith(placeholder);
    expect(slot.style.top).toBe("32px");
    manager.teardown();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("tracks transform-driven geometry each frame and stops when the overlay closes", () => {
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const runNextFrame = (): void => {
      const next = frames.entries().next().value;
      if (!next) throw new Error("Expected a pending animation frame");
      const [id, callback] = next;
      frames.delete(id);
      callback(0);
    };
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div id="slot" data-cd-trusted-slot="addToCart"></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(1, 2, 30, 40));
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    const placeholder = document.querySelector<HTMLElement>("[data-cd-overlay-commerce-placeholder]")!;
    const placeholderRect = vi.spyOn(placeholder, "getBoundingClientRect");

    placeholderRect.mockReturnValue(rect(11, 22, 30, 40));
    runNextFrame();
    expect(slot.style.left).toBe("11px");
    expect(slot.style.top).toBe("22px");
    placeholderRect.mockReturnValue(rect(31, 42, 30, 40));
    runNextFrame();
    expect(slot.style.left).toBe("31px");
    expect(slot.style.top).toBe("42px");
    expect(frames.size).toBe(1);

    manager.close("cd-home-a", null);
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    manager.teardown();
  });

  it("copies safe inherited presentation tokens onto the projected host", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div style="--commerce-accent: rebeccapurple; color: rgb(1, 2, 3); font-family: serif;"><div id="slot" data-cd-trusted-slot="addToCart"></div></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(0, 0, 100, 20));
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    expect(slot.style.getPropertyValue("--commerce-accent")).toBe("rebeccapurple");
    expect(slot.style.color).toBe("rgb(1, 2, 3)");
    expect(slot.style.fontFamily).toBe("serif");
    manager.teardown();
    expect(slot.getAttribute("style")).toBeNull();
  });

  it("lays out an initially hidden surface before measuring and atomically revealing commerce", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a" hidden><div id="slot" data-cd-trusted-slot="addToCart"></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const surface = document.getElementById("cd-home-a") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    const measurements: Array<{ hidden: boolean; visibility: string; pointerEvents: string }> = [];
    vi.spyOn(slot, "getBoundingClientRect").mockImplementation(() => {
      const presentation = document.querySelector<HTMLElement>("[data-cd-overlay-presentation]");
      measurements.push({
        hidden: surface.hidden,
        visibility: presentation?.style.visibility ?? "missing",
        pointerEvents: presentation?.style.pointerEvents ?? "missing",
      });
      return surface.hidden ? rect(0, 0, 0, 0) : rect(15, 25, 150, 45);
    });
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    const presentation = document.querySelector<HTMLElement>("[data-cd-overlay-presentation]")!;
    expect(measurements).toContainEqual({ hidden: false, visibility: "hidden", pointerEvents: "none" });
    expect(slot.style.width).toBe("150px");
    expect(slot.style.height).toBe("45px");
    expect(presentation.style.visibility).toBe("visible");
    expect(presentation.style.pointerEvents).toBe("auto");
    manager.teardown();
    expect(surface.hidden).toBe(true);
  });

  it("does not pin a transient zero measurement and recovers on the next frame", () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { nextFrame = callback; return 17; });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    document.body.innerHTML = `<main id="root"><section id="cd-home-a" hidden><div id="slot" data-cd-trusted-slot="addToCart"></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 0));
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    expect(slot.style.width).not.toBe("0px");
    expect(slot.style.height).not.toBe("0px");
    const placeholder = document.querySelector<HTMLElement>("[data-cd-overlay-commerce-placeholder]")!;
    vi.spyOn(placeholder, "getBoundingClientRect").mockReturnValue(rect(5, 6, 70, 80));
    nextFrame?.(0);
    expect(slot.style.width).toBe("70px");
    expect(slot.style.height).toBe("80px");
    manager.teardown();
    expect(cancelFrame).toHaveBeenCalledWith(17);
  });

  it("restores the exact source and background when hidden-surface projection fails", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a" hidden aria-modal="false"><div id="slot" data-cd-trusted-slot="addToCart" style="color: red;"></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    const before = root.innerHTML;
    document.body.style.overflow = "clip";
    vi.spyOn(slot, "getBoundingClientRect").mockImplementation(() => { throw new Error("measure failed"); });
    const manager = createOverlayManager(root);
    expect(() => manager.open("cd-home-a", null)).toThrow(/measure failed/);
    expect(root.innerHTML).toBe(before);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBeNull();
    expect(document.body.style.overflow).toBe("clip");
    expect(document.querySelector("[data-cd-overlay-presentation]")).toBeNull();
    expect(document.querySelector("[data-cd-overlay-commerce-layer]")).toBeNull();
    manager.teardown();
  });

  it("leaves unrelated static and absolute overlay geometry untouched while open", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div id="anchor" style="position: relative; width: 20rem;"><p id="static" style="margin: 1rem; color: red;">Copy</p><div id="slot" data-cd-trusted-slot="addToCart"></div><div id="absolute" style="position: absolute; inset: 0; pointer-events: none;"></div></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const anchor = document.getElementById("anchor") as HTMLElement;
    const staticChild = document.getElementById("static") as HTMLElement;
    const absoluteChild = document.getElementById("absolute") as HTMLElement;
    const anchorStyle = anchor.getAttribute("style");
    const staticStyle = staticChild.getAttribute("style");
    const absoluteStyle = absoluteChild.getAttribute("style");
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    expect(anchor.getAttribute("style")).toBe(anchorStyle);
    expect(staticChild.getAttribute("style")).toBe(staticStyle);
    expect(absoluteChild.getAttribute("style")).toBe(absoluteStyle);
    expect(absoluteChild.parentElement).toBe(anchor);
    expect(anchor.style.position).toBe("relative");
    expect(absoluteChild.style.position).toBe("absolute");
    manager.teardown();
  });

  it("exhaustively tears down overlays and background ownership when one restoration throws", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"></section><section id="cd-home-b"></section></main><footer id="outside"></footer>`;
    const root = document.getElementById("root") as HTMLElement;
    const outside = document.getElementById("outside") as HTMLElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    manager.open("cd-home-b", null);
    const presentation = document.querySelector<HTMLElement>("[data-cd-overlay-presentation]")!;
    const nativeRemove = presentation.remove.bind(presentation);
    presentation.remove = () => { nativeRemove(); throw new Error("presentation restore failed"); };
    expect(() => manager.teardown()).toThrow(AggregateError);
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
    expect(outside.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("cd-home-a")?.parentElement).toBe(root);
    expect(document.getElementById("cd-home-b")?.parentElement).toBe(root);
  });

  it("uses one portal and removes it and its listeners during teardown", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"></section><section id="cd-home-b"></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-a", null);
    manager.open("cd-home-b", null);
    expect(document.querySelectorAll("[data-cd-overlay-portal]")).toHaveLength(1);
    manager.teardown();
    expect(document.querySelector("[data-cd-overlay-portal]")).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("cd-home-a")?.parentElement).toBe(root);
    expect(document.getElementById("cd-home-b")?.parentElement).toBe(root);
    expect((document.getElementById("cd-home-a") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("cd-home-b") as HTMLElement).hidden).toBe(false);
  });

  it("resolves the compiler-issued target in the opener's repeated scope", () => {
    document.body.innerHTML = `
      <main id="root">
        <div><button id="cd-home-open-i-parent-a-child-same" data-cd-instance="i-parent-a-child-same">Open</button><section id="cd-home-drawer-i-parent-a-child-same" data-cd-instance="i-parent-a-child-same"></section></div>
        <div><button id="cd-home-open-i-parent-b-child-same" data-cd-instance="i-parent-b-child-same">Open</button><section id="cd-home-drawer-i-parent-b-child-same" data-cd-instance="i-parent-b-child-same"></section></div>
      </main>`;
    const root = document.getElementById("root") as HTMLElement;
    const opener = document.getElementById("cd-home-open-i-parent-b-child-same") as HTMLButtonElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-drawer", opener);
    expect(document.getElementById("cd-home-drawer-i-parent-b-child-same")?.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(true);
    expect(document.getElementById("cd-home-drawer-i-parent-a-child-same")?.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(false);
    manager.teardown();
  });
});
