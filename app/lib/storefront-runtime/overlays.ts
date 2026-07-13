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
  commerceLayer: HTMLElement | null;
  commerce: CommerceProjection[];
  placeholder: Comment;
  opener: HTMLElement | null;
  originalHidden: boolean;
  originalRole: string | null;
  originalTabIndex: string | null;
  originalAriaModal: string | null;
}

interface CommerceProjection {
  host: HTMLElement;
  placeholder: HTMLElement;
  originalHostStyle: string | null;
  stopSync(): void;
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

function focusableElements(surface: HTMLElement, commerce: readonly CommerceProjection[] = []): HTMLElement[] {
  const focusable: HTMLElement[] = [];
  const projectedHosts = new Map(commerce.map((projection) => [projection.placeholder, projection.host]));
  const visit = (parent: ParentNode): void => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      const current = projectedHosts.get(child) ?? child;
      if (current.matches(FOCUSABLE) && !current.hidden) focusable.push(current);
      const trustedRoot = trustedCommerceRoot(current);
      if (trustedRoot) visit(trustedRoot);
      visit(current);
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

const INHERITED_PRESENTATION_PROPERTIES = [
  "color", "font-family", "font-size", "font-style", "font-weight", "font-stretch",
  "line-height", "letter-spacing", "text-align", "text-transform", "direction", "writing-mode",
] as const;

function safeCustomPropertyValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return !normalized.includes("url(") && !normalized.includes("expression(") && !normalized.includes("@import");
}

function copyPresentationContext(host: HTMLElement, computed: CSSStyleDeclaration): void {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = host.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
  for (const property of INHERITED_PRESENTATION_PROPERTIES) {
    const value = computed.getPropertyValue(property) || [...ancestors].reverse()
      .map((ancestor) => ancestor.style.getPropertyValue(property))
      .find(Boolean) || "";
    if (value) host.style.setProperty(property, value);
  }
  for (const source of [...ancestors.map((ancestor) => ancestor.style), computed]) {
    for (let index = 0; index < source.length; index += 1) {
      const property = source.item(index);
      if (!property.startsWith("--")) continue;
      const value = source.getPropertyValue(property);
      if (safeCustomPropertyValue(value)) host.style.setProperty(property, value.trim());
    }
  }
}

function setProjectedRect(host: HTMLElement, rect: DOMRect): void {
  host.style.setProperty("left", `${rect.left}px`, "important");
  host.style.setProperty("top", `${rect.top}px`, "important");
  if (rect.width > 0) host.style.setProperty("width", `${rect.width}px`, "important");
  if (rect.height > 0) host.style.setProperty("height", `${rect.height}px`, "important");
}

function projectCommerceHost(host: HTMLElement, layer: HTMLElement): CommerceProjection {
  const originalHostStyle = host.getAttribute("style");
  const view = host.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(host);
  const initialRect = host.getBoundingClientRect();
  const placeholder = host.ownerDocument.createElement("div");
  placeholder.setAttribute("data-cd-overlay-commerce-placeholder", host.id);
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.display = computed?.display || "block";
  placeholder.style.boxSizing = computed?.boxSizing || "border-box";
  if (initialRect.width > 0) placeholder.style.width = `${initialRect.width}px`;
  if (initialRect.height > 0) placeholder.style.height = `${initialRect.height}px`;
  placeholder.style.marginTop = computed?.marginTop || "0px";
  placeholder.style.marginRight = computed?.marginRight || "0px";
  placeholder.style.marginBottom = computed?.marginBottom || "0px";
  placeholder.style.marginLeft = computed?.marginLeft || "0px";
  placeholder.style.visibility = "hidden";
  placeholder.style.pointerEvents = "none";
  if (computed) {
    placeholder.style.flex = computed.flex;
    placeholder.style.alignSelf = computed.alignSelf;
    placeholder.style.order = computed.order;
    placeholder.style.gridArea = computed.gridArea;
    copyPresentationContext(host, computed);
  }
  let observer: ResizeObserver | null = null;
  let frameId: number | undefined;
  let stopped = false;
  let projectedRect = initialRect;
  const sync = (): void => {
    const nextRect = placeholder.getBoundingClientRect();
    if (nextRect.left === projectedRect.left && nextRect.top === projectedRect.top &&
      nextRect.width === projectedRect.width && nextRect.height === projectedRect.height) return;
    setProjectedRect(host, nextRect);
    projectedRect = nextRect;
  };
  const scheduleFrame = (): void => {
    if (stopped || !view?.requestAnimationFrame) return;
    frameId = view.requestAnimationFrame(() => {
      frameId = undefined;
      if (stopped || !host.isConnected || !placeholder.isConnected) return;
      sync();
      scheduleFrame();
    });
  };
  const stopSync = (): void => {
    stopped = true;
    view?.removeEventListener("scroll", sync, true);
    view?.removeEventListener("resize", sync);
    observer?.disconnect();
    if (frameId !== undefined) view?.cancelAnimationFrame(frameId);
    frameId = undefined;
  };
  try {
    host.replaceWith(placeholder);
    layer.append(host);
    host.style.setProperty("position", "absolute", "important");
    host.style.setProperty("margin", "0", "important");
    host.style.setProperty("box-sizing", "border-box", "important");
    host.style.setProperty("z-index", "1", "important");
    host.style.setProperty("pointer-events", "auto", "important");
    setProjectedRect(host, initialRect);
    view?.addEventListener("scroll", sync, true);
    view?.addEventListener("resize", sync);
    const Observer = view?.ResizeObserver;
    observer = Observer ? new Observer(sync) : null;
    observer?.observe(placeholder);
    scheduleFrame();
    return { host, placeholder, originalHostStyle, stopSync };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try { stopSync(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { if (placeholder.isConnected) placeholder.replaceWith(host); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { restoreAttribute(host, "style", originalHostStyle); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], `Failed to project commerce host ${host.id}`);
    throw error;
  }
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

  const focusSurface = (surface: HTMLElement, commerce: readonly CommerceProjection[] = []): void => {
    (focusableElements(surface, commerce)[0] ?? surface).focus();
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
      if (surface.commerceLayer) {
        attempt(errors, () => {
          if (active) surface.commerceLayer!.removeAttribute("inert");
          else surface.commerceLayer!.setAttribute("inert", "");
        });
        attempt(errors, () => restoreAttribute(surface.commerceLayer!, "aria-hidden", active ? null : "true"));
      }
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
    for (const projection of surface.commerce) {
      attempt(errors, projection.stopSync);
      attempt(errors, () => projection.placeholder.replaceWith(projection.host));
      attempt(errors, () => restoreAttribute(projection.host, "style", projection.originalHostStyle));
    }
    if (surface.commerceLayer) attempt(errors, () => surface.commerceLayer!.remove());
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
          else focusSurface(nextTop.element, nextTop.commerce);
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
    const focusable = focusableElements(top.element, top.commerce);
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
      !top.commerceLayer?.contains(event.target) &&
      !focusableElements(top.element, top.commerce).includes(deepActiveElement(document) as HTMLElement)) {
      focusSurface(top.element, top.commerce);
    }
  };
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);

  return {
    open(targetId, opener) {
      const element = localElement(targetId, opener);
      const concreteId = element.id;
      if (openSurfaces.has(concreteId)) return;
      const originalHidden = element.hidden;
      const originalRole = element.getAttribute("role");
      const originalTabIndex = element.getAttribute("tabindex");
      const originalAriaModal = element.getAttribute("aria-modal");
      const originalAttributes = [...element.attributes].map(({ name, value }) => [name, value] as const);
      const placeholder = document.createComment(`cd-overlay:${concreteId}`);
      let presentation: HTMLElement | null = null;
      let commerceLayer: HTMLElement | null = null;
      const commerce: CommerceProjection[] = [];
      let registered = false;
      const acquiredBackground = background === null;
      acquireBackground();
      try {
        element.replaceWith(placeholder);
        presentation = document.createElement("div");
        presentation.setAttribute("data-cd-overlay-presentation", concreteId);
        presentation.setAttribute("role", "presentation");
        const bundleNamespace = targetId.split("-")[1];
        if (bundleNamespace) presentation.setAttribute("data-cd-bundle", bundleNamespace);
        presentation.style.visibility = "hidden";
        presentation.style.pointerEvents = "none";
        presentation.style.position = "relative";
        presentation.style.zIndex = "1";
        presentation.style.isolation = "isolate";
        presentation.style.setProperty("--cd-overlay-surface", "Canvas");
        presentation.style.setProperty("--cd-overlay-foreground", "CanvasText");
        presentation.append(element);
        portal.append(presentation);

        element.hidden = false;
        element.setAttribute("role", "dialog");
        element.setAttribute("aria-modal", "true");
        if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
        void presentation.offsetWidth;

        const commerceHosts = [...element.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")];
        if (commerceHosts.length > 0) {
          commerceLayer = document.createElement("div");
          commerceLayer.setAttribute("data-cd-overlay-commerce-layer", concreteId);
          commerceLayer.setAttribute("role", "presentation");
          Object.assign(commerceLayer.style, {
            position: "absolute", inset: "0", zIndex: "2", pointerEvents: "none",
            isolation: "isolate", visibility: "hidden",
          });
          portal.append(commerceLayer);
          for (const host of commerceHosts) commerce.push(projectCommerceHost(host, commerceLayer));
        }

        openSurfaces.set(concreteId, {
          element, presentation, commerceLayer, commerce, placeholder, opener,
          originalHidden, originalRole, originalTabIndex, originalAriaModal,
        });
        stack.push(concreteId);
        registered = true;
        syncStackOwnership();
        presentation.style.visibility = "visible";
        presentation.style.pointerEvents = "auto";
        if (commerceLayer) commerceLayer.style.visibility = "visible";
        focusSurface(element, commerce);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (registered) {
          openSurfaces.delete(concreteId);
          const index = stack.lastIndexOf(concreteId);
          if (index >= 0) stack.splice(index, 1);
        }
        for (const projection of [...commerce].reverse()) {
          attempt(rollbackErrors, projection.stopSync);
          attempt(rollbackErrors, () => projection.placeholder.replaceWith(projection.host));
          attempt(rollbackErrors, () => restoreAttribute(projection.host, "style", projection.originalHostStyle));
        }
        if (commerceLayer) attempt(rollbackErrors, () => commerceLayer!.remove());
        attempt(rollbackErrors, () => {
          for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
          for (const [name, value] of originalAttributes) element.setAttribute(name, value);
        });
        attempt(rollbackErrors, () => { if (placeholder.isConnected) placeholder.replaceWith(element); });
        if (presentation) attempt(rollbackErrors, () => presentation!.remove());
        syncStackOwnership(rollbackErrors);
        if (acquiredBackground) rollbackErrors.push(...releaseBackground());
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], `Failed to open overlay ${concreteId}`);
        }
        throw error;
      }
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
