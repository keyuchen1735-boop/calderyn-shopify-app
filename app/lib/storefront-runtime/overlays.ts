import { isCompilerIssuedId, RuntimeManifestError } from "./state";
import { trustedCommerceRoot } from "./trusted-roots";

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
  commerce: Array<{ host: HTMLElement; wrapper: HTMLElement }>;
  styled: Array<{ element: HTMLElement; originalStyle: string | null }>;
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
  const focusable: HTMLElement[] = [];
  const visit = (parent: ParentNode): void => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.matches(FOCUSABLE) && !child.hidden) focusable.push(child);
      const trustedRoot = trustedCommerceRoot(child);
      if (trustedRoot) visit(trustedRoot);
      visit(child);
    }
  };
  visit(surface);
  return focusable;
}

function deepActiveElement(document: Document): Element | null {
  let active = document.activeElement;
  while (active instanceof HTMLElement) {
    const shadowActive = trustedCommerceRoot(active)?.activeElement;
    if (!shadowActive) break;
    active = shadowActive;
  }
  return active;
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

  const attempt = (errors: unknown[], action: () => void): void => {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  };

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

  const releaseBackground = (): unknown[] => {
    const errors: unknown[] = [];
    if (!background) return errors;
    for (const state of background) {
      attempt(errors, () => {
        if (state.inert) state.element.setAttribute("inert", "");
        else state.element.removeAttribute("inert");
      });
      attempt(errors, () => restoreAttribute(state.element, "aria-hidden", state.ariaHidden));
    }
    background = null;
    attempt(errors, () => { document.body.style.overflow = originalBodyOverflow; });
    attempt(errors, () => { portal.hidden = true; });
    return errors;
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

  const syncStackOwnership = (errors: unknown[] = []): unknown[] => {
    const topId = stack.at(-1);
    for (const [id, surface] of openSurfaces) {
      const active = id === topId;
      attempt(errors, () => {
        if (active) surface.presentation.removeAttribute("inert");
        else surface.presentation.setAttribute("inert", "");
      });
      attempt(errors, () => restoreAttribute(surface.presentation, "aria-hidden", active ? null : "true"));
      attempt(errors, () => {
        if (active) surface.element.setAttribute("aria-modal", "true");
        else surface.element.removeAttribute("aria-modal");
      });
    }
    return errors;
  };

  const restore = (concreteId: string, restoreFocus: boolean): void => {
    const surface = openSurfaces.get(concreteId);
    if (!surface) return;
    const errors: unknown[] = [];
    const wasTop = stack.at(-1) === concreteId;
    attempt(errors, () => { surface.element.hidden = surface.originalHidden; });
    attempt(errors, () => restoreAttribute(surface.element, "role", surface.originalRole));
    attempt(errors, () => restoreAttribute(surface.element, "tabindex", surface.originalTabIndex));
    attempt(errors, () => restoreAttribute(surface.element, "aria-modal", surface.originalAriaModal));
    attempt(errors, () => surface.placeholder.replaceWith(surface.element));
    for (const protection of surface.commerce) {
      attempt(errors, () => protection.wrapper.replaceWith(protection.host));
    }
    for (const snapshot of surface.styled) {
      attempt(errors, () => restoreAttribute(snapshot.element, "style", snapshot.originalStyle));
    }
    attempt(errors, () => surface.presentation.remove());
    openSurfaces.delete(concreteId);
    const index = stack.lastIndexOf(concreteId);
    if (index >= 0) stack.splice(index, 1);

    syncStackOwnership(errors);
    const nextTop = openSurfaces.get(stack.at(-1) ?? "");
    if (!nextTop) errors.push(...releaseBackground());
    if (restoreFocus && wasTop) {
      if (nextTop) {
        attempt(errors, () => {
          if (surface.opener?.isConnected && nextTop.element.contains(surface.opener)) surface.opener.focus();
          else focusSurface(nextTop.element);
        });
      } else if (surface.opener?.isConnected && !surface.opener.hidden) {
        attempt(errors, () => surface.opener!.focus());
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to restore overlay ${concreteId}`);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const top = openSurfaces.get(stack.at(-1) ?? "");
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      restore(top.element.id, true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(top.element);
    if (focusable.length === 0) {
      event.preventDefault();
      top.element.focus();
      return;
    }
    event.preventDefault();
    const active = deepActiveElement(document);
    const currentIndex = focusable.findIndex((element) => element === active);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    focusable[nextIndex]!.focus();
  };

  const onFocusIn = (event: FocusEvent): void => {
    const top = openSurfaces.get(stack.at(-1) ?? "");
    if (top && event.target instanceof Node && !top.element.contains(event.target) &&
      !focusableElements(top.element).includes(deepActiveElement(document) as HTMLElement)) {
      focusSurface(top.element);
    }
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
      presentation.style.position = "relative";
      presentation.style.zIndex = "1";
      presentation.style.setProperty("--cd-overlay-surface", "Canvas");
      presentation.style.setProperty("--cd-overlay-foreground", "CanvasText");
      presentation.append(element);
      portal.append(presentation);
      const commerce = [...element.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")].map((host) => {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-cd-overlay-commerce", concreteId);
        wrapper.style.setProperty("display", "contents", "important");
        wrapper.style.setProperty("pointer-events", "none", "important");
        host.replaceWith(wrapper);
        wrapper.append(host);
        return { host, wrapper };
      });
      const commerceHosts = new Set(commerce.map(({ host }) => host));
      const commerceWrappers = new Set<HTMLElement>(commerce.map(({ wrapper }) => wrapper));
      const protectedBranches = new Set<HTMLElement>();
      for (const { wrapper } of commerce) {
        let branch = wrapper.parentElement;
        while (branch && branch !== element) {
          protectedBranches.add(branch);
          branch = branch.parentElement;
        }
      }
      const styled = [element, ...element.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
        if (commerceWrappers.has(candidate)) return [];
        const snapshot = { element: candidate, originalStyle: candidate.getAttribute("style") };
        candidate.style.setProperty("isolation", "isolate", "important");
        if (candidate !== element) {
          if (candidate.ownerDocument.defaultView?.getComputedStyle(candidate).position === "static") {
            candidate.style.setProperty("position", "relative", "important");
          }
          candidate.style.setProperty("z-index", commerceHosts.has(candidate) ? "2" : protectedBranches.has(candidate) ? "1" : "0", "important");
        }
        if (commerceHosts.has(candidate)) candidate.style.setProperty("pointer-events", "auto", "important");
        return [snapshot];
      });
      openSurfaces.set(concreteId, {
        element, presentation, commerce, styled, placeholder, opener,
        originalHidden: element.hidden,
        originalRole: element.getAttribute("role"),
        originalTabIndex: element.getAttribute("tabindex"),
        originalAriaModal: element.getAttribute("aria-modal"),
      });
      stack.push(concreteId);
      element.hidden = false;
      element.setAttribute("role", "dialog");
      if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
      syncStackOwnership();
      focusSurface(element);
    },
    close(targetId, opener) {
      restore(openId(targetId, opener), true);
    },
    toggle(targetId, opener) {
      const concreteId = openId(targetId, opener);
      if (openSurfaces.has(concreteId)) restore(concreteId, true);
      else this.open(targetId, opener);
    },
    isOpen(targetId) {
      return openSurfaces.has(targetId) || [...openSurfaces.keys()].some((id) => {
        const instance = openSurfaces.get(id)?.element.dataset.cdInstance;
        return instance ? id === `${targetId}-${instance}` : false;
      });
    },
    teardown() {
      const errors: unknown[] = [];
      for (const concreteId of [...stack].reverse()) attempt(errors, () => restore(concreteId, false));
      errors.push(...releaseBackground());
      attempt(errors, () => document.removeEventListener("keydown", onKeyDown));
      attempt(errors, () => document.removeEventListener("focusin", onFocusIn));
      attempt(errors, () => portal.remove());
      if (errors.length > 0) throw new AggregateError(errors, "Failed to teardown overlay manager");
    },
  };
}
