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
  originalRole: string | null;
  originalTabIndex: string | null;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableElements(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hidden);
}

export function createOverlayManager(root: HTMLElement): OverlayManager {
  const document = root.ownerDocument;
  const portal = document.createElement("div");
  portal.setAttribute("data-cd-overlay-portal", "");
  portal.setAttribute("role", "presentation");
  document.body.append(portal);
  const openSurfaces = new Map<string, OpenSurface>();
  const stack: string[] = [];
  const rootWasInert = root.hasAttribute("inert");

  const localElement = (targetId: string, opener: HTMLElement | null): HTMLElement => {
    if (!isCompilerIssuedId(targetId)) throw new RuntimeManifestError("Overlay target is not compiler-issued");
    const instance = opener?.dataset.cdInstance;
    const scopedId = instance && isCompilerIssuedId(`${targetId}-${instance}`) ? `${targetId}-${instance}` : targetId;
    const element = document.getElementById(scopedId) ?? [...root.querySelectorAll<HTMLElement>("[id]")].find(
      (candidate) => candidate.id === targetId || candidate.id.startsWith(`${targetId}-`),
    );
    if (!(element instanceof HTMLElement) || (!root.contains(element) && !portal.contains(element))) {
      throw new RuntimeManifestError(`Overlay target ${targetId} is outside the bundle root`);
    }
    return element;
  };

  const restore = (targetId: string, restoreFocus: boolean): void => {
    const surface = openSurfaces.get(targetId);
    if (!surface) return;
    surface.element.hidden = true;
    if (surface.originalRole === null) surface.element.removeAttribute("role");
    else surface.element.setAttribute("role", surface.originalRole);
    if (surface.originalTabIndex === null) surface.element.removeAttribute("tabindex");
    else surface.element.setAttribute("tabindex", surface.originalTabIndex);
    surface.placeholder.replaceWith(surface.element);
    surface.presentation.remove();
    openSurfaces.delete(targetId);
    const index = stack.lastIndexOf(targetId);
    if (index >= 0) stack.splice(index, 1);
    if (openSurfaces.size === 0 && !rootWasInert) root.removeAttribute("inert");
    if (restoreFocus && surface.opener?.isConnected) surface.opener.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const targetId = stack.at(-1);
    if (!targetId) return;
    if (event.key === "Escape") {
      event.preventDefault();
      restore(targetId, true);
      return;
    }
    if (event.key !== "Tab") return;
    const surface = openSurfaces.get(targetId)?.element;
    if (!surface) return;
    const focusable = focusableElements(surface);
    if (focusable.length === 0) {
      event.preventDefault();
      surface.focus();
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
  document.addEventListener("keydown", onKeyDown);

  return {
    open(targetId, opener) {
      const element = localElement(targetId, opener);
      const concreteId = element.id;
      if (openSurfaces.has(concreteId)) return;
      const placeholder = document.createComment(`cd-overlay:${concreteId}`);
      element.replaceWith(placeholder);
      const presentation = document.createElement("div");
      presentation.setAttribute("data-cd-overlay-presentation", concreteId);
      const bundleNamespace = targetId.split("-")[1];
      if (bundleNamespace) presentation.setAttribute("data-cd-bundle", bundleNamespace);
      presentation.append(element);
      portal.append(presentation);
      const openSurface: OpenSurface = {
        element,
        presentation,
        placeholder,
        opener,
        originalRole: element.getAttribute("role"),
        originalTabIndex: element.getAttribute("tabindex"),
      };
      openSurfaces.set(concreteId, openSurface);
      stack.push(concreteId);
      root.setAttribute("inert", "");
      element.hidden = false;
      if (!element.hasAttribute("role")) element.setAttribute("role", "dialog");
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
      (focusableElements(element)[0] ?? element).focus();
    },
    close(targetId, opener) {
      const instance = opener?.dataset.cdInstance;
      const concreteId = instance ? `${targetId}-${instance}` : [...openSurfaces.keys()].find(
        (candidate) => candidate === targetId || candidate.startsWith(`${targetId}-`),
      ) ?? targetId;
      restore(concreteId, true);
    },
    toggle(targetId, opener) {
      const instance = opener?.dataset.cdInstance;
      const concreteId = instance ? `${targetId}-${instance}` : [...openSurfaces.keys()].find(
        (candidate) => candidate === targetId || candidate.startsWith(`${targetId}-`),
      );
      if (concreteId && openSurfaces.has(concreteId)) restore(concreteId, true);
      else this.open(targetId, opener);
    },
    isOpen(targetId) {
      return [...openSurfaces.keys()].some((candidate) => candidate === targetId || candidate.startsWith(`${targetId}-`));
    },
    teardown() {
      for (const targetId of [...stack].reverse()) restore(targetId, false);
      document.removeEventListener("keydown", onKeyDown);
      if (!rootWasInert) root.removeAttribute("inert");
      portal.remove();
    },
  };
}
