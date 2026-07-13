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
    manager.close("cd-home-b", aOpener);
    expect(document.activeElement).toBe(aOpener);
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
        <div><button id="cd-home-open-one" data-cd-instance="one">Open</button><section id="cd-home-drawer-one" data-cd-instance="one"></section></div>
        <div><button id="cd-home-open-two" data-cd-instance="two">Open</button><section id="cd-home-drawer-two" data-cd-instance="two"></section></div>
      </main>`;
    const root = document.getElementById("root") as HTMLElement;
    const opener = document.getElementById("cd-home-open-two") as HTMLButtonElement;
    const manager = createOverlayManager(root);
    manager.open("cd-home-drawer", opener);
    expect(document.getElementById("cd-home-drawer-two")?.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(true);
    expect(document.getElementById("cd-home-drawer-one")?.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(false);
    manager.teardown();
  });
});
