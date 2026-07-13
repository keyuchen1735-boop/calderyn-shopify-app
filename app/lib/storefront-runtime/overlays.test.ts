// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { createOverlayManager } from "./overlays";

afterEach(() => {
  document.body.innerHTML = "";
});

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

  it("protects trusted commerce in place without changing its layout parent or order", () => {
    document.body.innerHTML = `<main id="root"><section id="cd-home-a"><div id="row"><span id="before"></span><div id="slot" data-cd-trusted-slot="addToCart"></div><div id="cover"></div></div></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const surface = document.getElementById("cd-home-a") as HTMLElement;
    const slot = document.getElementById("slot") as HTMLElement;
    const row = document.getElementById("row") as HTMLElement;
    const before = document.getElementById("before") as HTMLElement;
    const cover = document.getElementById("cover") as HTMLElement;
    const manager = createOverlayManager(root);
    manager.open(surface.id, null);
    const presentation = document.querySelector<HTMLElement>("[data-cd-overlay-presentation]")!;
    const commerceWrapper = slot.parentElement as HTMLElement;
    expect(commerceWrapper.hasAttribute("data-cd-overlay-commerce")).toBe(true);
    expect(commerceWrapper.parentElement).toBe(row);
    expect(commerceWrapper.previousElementSibling).toBe(before);
    expect(commerceWrapper.nextElementSibling).toBe(cover);
    expect(presentation.contains(slot)).toBe(true);
    expect(commerceWrapper.style.display).toBe("contents");
    expect(Number(slot.style.zIndex)).toBeGreaterThan(Number(cover.style.zIndex));
    expect(slot.style.isolation).toBe("isolate");
    expect(cover.style.isolation).toBe("isolate");
    expect(slot.style.pointerEvents).toBe("auto");
    manager.close(surface.id, null);
    expect(slot.parentElement).toBe(row);
    expect(slot.previousElementSibling).toBe(before);
    expect(slot.nextElementSibling).toBe(cover);
    expect(document.querySelector("[data-cd-overlay-commerce]")).toBeNull();
    expect(cover.getAttribute("style")).toBeNull();
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
