// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { createOverlayManager } from "./overlays";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("platform overlay portal", () => {
  it("traps focus, makes the background inert, closes on Escape, and restores focus", () => {
    document.body.innerHTML = `
      <main id="root"><button id="opener">Open</button><section id="cd-home-drawer" hidden><button id="first">First</button><button id="last">Last</button></section></main>`;
    const root = document.getElementById("root") as HTMLElement;
    const opener = document.getElementById("opener") as HTMLButtonElement;
    const drawer = document.getElementById("cd-home-drawer") as HTMLElement;
    opener.focus();
    const manager = createOverlayManager(root);
    manager.open(drawer.id, opener);
    expect(drawer.parentElement?.hasAttribute("data-cd-overlay-presentation")).toBe(true);
    expect(drawer.parentElement?.getAttribute("data-cd-bundle")).toBe("home");
    expect(root.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.id).toBe("first");

    const last = document.getElementById("last") as HTMLButtonElement;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement?.id).toBe("first");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.hidden).toBe(true);
    expect(drawer.parentElement).toBe(root);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
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
