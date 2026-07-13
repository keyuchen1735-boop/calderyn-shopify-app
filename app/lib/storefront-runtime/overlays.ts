import { isCompilerIssuedId, RuntimeManifestError } from "./state";

export interface OverlayManager {
  open(targetId: string, opener: HTMLElement | null): void;
  close(targetId: string, opener: HTMLElement | null): void;
  toggle(targetId: string, opener: HTMLElement | null): void;
  isOpen(targetId: string): boolean;
  teardown(): void;
}

interface OpenSurface {
  element: HTMLElement;
  presentation: HTMLElement;
  placeholder: Comment;
  opener: HTMLElement | null;
  originalHidden: boolean;
  originalRole: string | null;
  originalTabIndex: string | null;
  originalAriaModal: string | null;
}

interface BackgroundState {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

const FOCUSABLE = [
  "button:not([disabled])", "a[href]", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableElements(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hidden);
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

export function createOverlayManager(root: HTMLElement): OverlayManager {
  const document = root.ownerDocument;
  const portal = document.createElement("div");
  portal.setAttribute("data-cd-overlay-portal", "");
  portal.setAttribute("role", "presentation");
  Object.assign(portal.style, {
    position: "fixed", inset: "0", zIndex: "2147483000", pointerEvents: "none",
  });
  const backdrop = document.createElement("div");
  backdrop.setAttribute("data-cd-overlay-backdrop", "");
  backdrop.setAttribute("aria-hidden", "true");
  Object.assign(backdrop.style, {
    position: "absolute", inset: "0", pointerEvents: "auto",
    background: "var(--cd-overlay-backdrop, rgba(0, 0, 0, 0.48))",
  });
  portal.append(backdrop);
  portal.hidden = true;
  document.body.append(portal);

  const openSurfaces = new Map<string, OpenSurface>();
  const stack: string[] = [];
  let background: BackgroundState[] | null = null;
  let originalBodyOverflow = "";

  const acquireBackground = (): void => {
    if (background) return;
    originalBodyOverflow = document.body.style.overflow;
    background = [...document.body.children].flatMap((element) => {
      if (!(element instanceof HTMLElement) || element === portal) return [];
      const state: BackgroundState = {
        element,
        inert: element.hasAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      };
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
      return [state];
    });
    document.body.style.overflow = "hidden";
    portal.hidden = false;
  };

  const releaseBackground = (): void => {
    if (!background) return;
    for (const state of background) {
      if (state.inert) state.element.setAttribute("inert", "");
      else state.element.removeAttribute("inert");
      restoreAttribute(state.element, "aria-hidden", state.ariaHidden);
    }
    background = null;
    document.body.style.overflow = originalBodyOverflow;
    portal.hidden = true;
  };

  const localElement = (targetId: string, opener: HTMLElement | null): HTMLElement => {
    if (!isCompilerIssuedId(targetId)) throw new RuntimeManifestError("Overlay target is not compiler-issued");
    const instance = opener?.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance;
    const scopedId = instance ? `${targetId}-${instance}` : targetId;
    const element = document.getElementById(scopedId);
    if (!(element instanceof HTMLElement) || (!root.contains(element) && !portal.contains(element))) {
      throw new RuntimeManifestError(`Overlay target ${scopedId} is outside the bundle root`);
    }
    return element;
  };

  const focusSurface = (surface: HTMLElement): void => {
    (focusableElements(surface)[0] ?? surface).focus();
  };

  const openId = (targetId: string, opener: HTMLElement | null): string => {
    const instance = opener?.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance;
    if (instance) return `${targetId}-${instance}`;
    return stack.find((candidate) => candidate === targetId) ?? targetId;
  };

  const restore = (concreteId: string, restoreFocus: boolean, teardown: boolean): void => {
    const surface = openSurfaces.get(concreteId);
    if (!surface) return;
    const wasTop = stack.at(-1) === concreteId;
    surface.element.hidden = teardown ? surface.originalHidden : true;
    restoreAttribute(surface.element, "role", surface.originalRole);
    restoreAttribute(surface.element, "tabindex", surface.originalTabIndex);
    restoreAttribute(surface.element, "aria-modal", surface.originalAriaModal);
    surface.placeholder.replaceWith(surface.element);
    surface.presentation.remove();
    openSurfaces.delete(concreteId);
    const index = stack.lastIndexOf(concreteId);
    if (index >= 0) stack.splice(index, 1);

    const nextTop = openSurfaces.get(stack.at(-1) ?? "");
    if (!nextTop) releaseBackground();
    if (!restoreFocus || !wasTop) return;
    if (nextTop) {
      if (surface.opener?.isConnected && nextTop.element.contains(surface.opener)) surface.opener.focus();
      else focusSurface(nextTop.element);
    } else if (surface.opener?.isConnected && !surface.opener.hidden) {
      surface.opener.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const top = openSurfaces.get(stack.at(-1) ?? "");
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      restore(top.element.id, true, false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(top.element);
    if (focusable.length === 0) {
      event.preventDefault();
      top.element.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onFocusIn = (event: FocusEvent): void => {
    const top = openSurfaces.get(stack.at(-1) ?? "");
    if (top && event.target instanceof Node && !top.element.contains(event.target)) focusSurface(top.element);
  };
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);

  return {
    open(targetId, opener) {
      const element = localElement(targetId, opener);
      const concreteId = element.id;
      if (openSurfaces.has(concreteId)) return;
      acquireBackground();
      const placeholder = document.createComment(`cd-overlay:${concreteId}`);
      element.replaceWith(placeholder);
      const presentation = document.createElement("div");
      presentation.setAttribute("data-cd-overlay-presentation", concreteId);
      presentation.setAttribute("role", "presentation");
      const bundleNamespace = targetId.split("-")[1];
      if (bundleNamespace) presentation.setAttribute("data-cd-bundle", bundleNamespace);
      presentation.style.pointerEvents = "auto";
      presentation.style.setProperty("--cd-overlay-surface", "Canvas");
      presentation.style.setProperty("--cd-overlay-foreground", "CanvasText");
      presentation.append(element);
      portal.append(presentation);
      openSurfaces.set(concreteId, {
        element, presentation, placeholder, opener,
        originalHidden: element.hidden,
        originalRole: element.getAttribute("role"),
        originalTabIndex: element.getAttribute("tabindex"),
        originalAriaModal: element.getAttribute("aria-modal"),
      });
      stack.push(concreteId);
      element.hidden = false;
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
      focusSurface(element);
    },
    close(targetId, opener) {
      restore(openId(targetId, opener), true, false);
    },
    toggle(targetId, opener) {
      const concreteId = openId(targetId, opener);
      if (openSurfaces.has(concreteId)) restore(concreteId, true, false);
      else this.open(targetId, opener);
    },
    isOpen(targetId) {
      return openSurfaces.has(targetId) || [...openSurfaces.keys()].some((id) => {
        const instance = openSurfaces.get(id)?.element.dataset.cdInstance;
        return instance ? id === `${targetId}-${instance}` : false;
      });
    },
    teardown() {
      for (const concreteId of [...stack].reverse()) restore(concreteId, false, true);
      releaseBackground();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      portal.remove();
    },
  };
}
