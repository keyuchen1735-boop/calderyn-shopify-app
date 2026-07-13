import type {
  InteractionManifestV1,
  PublicDataRef,
  RouteArtifact,
  RuntimeActionSpec,
  RuntimeCapability,
  TrustedSlotManifest,
} from "~/lib/storefront-bundle/types";
import { isPublicBindingPath } from "~/lib/storefront-bundle/types";
import {
  executeRuntimeAction,
  type CommerceIntent,
  type RuntimeActionContext,
  type RuntimeAdapters,
} from "./actions";
import { createOverlayManager } from "./overlays";
import {
  createInitialRuntimeState,
  isCompilerIssuedId,
  RuntimeManifestError,
  type RuntimeState,
} from "./state";

const SUPPORTED_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
  "navigation", "localState", "overlay", "catalogFiltering", "catalogSearch", "commerce",
]);
const SUPPORTED_ACTIONS: ReadonlySet<RuntimeActionSpec["type"]> = new Set([
  "state.set", "state.increment", "state.decrement", "surface.open", "surface.close", "surface.toggle",
  "tabs.select", "accordion.toggle", "gallery.select", "carousel.previous", "carousel.next",
  "collection.filter", "collection.sort", "collection.view", "collection.page", "search.update", "search.submit",
  "search.clear", "scroll.to", "navigate",
]);

export interface HydrateStorefrontOptions {
  root: HTMLElement;
  artifact: Pick<RouteArtifact, "requiredCapabilities" | "interactions" | "trustedSlots">;
  adapters?: RuntimeAdapters;
}

export interface StorefrontRuntimeHandle {
  readonly hydrated: boolean;
  readonly error?: RuntimeManifestError;
  getState(): RuntimeState;
  teardown(): void;
}

const mounted = new WeakMap<HTMLElement, StorefrontRuntimeHandle>();
const active = new Set<StorefrontRuntimeHandle>();
const closedCommerceRoots = new WeakMap<HTMLElement, ShadowRoot>();

function localElements(root: HTMLElement, id: string): HTMLElement[] {
  if (!isCompilerIssuedId(id)) throw new RuntimeManifestError(`ID ${JSON.stringify(id)} is not compiler-issued`);
  return [...root.querySelectorAll<HTMLElement>("[id]")].filter((element) => {
    if (element.id === id) return true;
    const instanceId = element.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance;
    return Boolean(instanceId) && element.id === `${id}-${instanceId}`;
  });
}

function instanceElement(root: HTMLElement, id: string, instanceId?: string): HTMLElement[] {
  if (!instanceId) {
    const element = root.ownerDocument.getElementById(id);
    return element instanceof HTMLElement && root.contains(element) ? [element] : [];
  }
  const element = root.ownerDocument.getElementById(`${id}-${instanceId}`);
  return element instanceof HTMLElement && root.contains(element) &&
    element.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance === instanceId ? [element] : [];
}

function actionTarget(action: RuntimeActionSpec): string | null {
  if ("surfaceId" in action) return action.surfaceId;
  if ("targetId" in action) return action.targetId;
  return null;
}

function validRef(ref: unknown, state: RuntimeState): ref is PublicDataRef {
  if (ref === null || typeof ref !== "object") return false;
  const candidate = ref as Record<string, unknown>;
  if (candidate.kind === "literal") {
    return candidate.value === null || ["string", "number", "boolean"].includes(typeof candidate.value);
  }
  if (candidate.kind === "state") return typeof candidate.stateId === "string" && Object.hasOwn(state, candidate.stateId);
  if (candidate.kind === "event") return ["value", "checked", "key", "progress01"].includes(String(candidate.field));
  return candidate.kind === "data" && typeof candidate.scopeId === "string" &&
    (candidate.scopeId === "root" || isCompilerIssuedId(candidate.scopeId)) && isPublicBindingPath(candidate.path);
}

function validAction(action: RuntimeActionSpec, state: RuntimeState): boolean {
  if (action.type === "state.set") return Object.hasOwn(state, action.stateId) && validRef(action.value, state);
  if (action.type === "state.increment" || action.type === "state.decrement") return Object.hasOwn(state, action.stateId);
  if (action.type === "tabs.select" || action.type === "accordion.toggle" || action.type === "gallery.select") {
    return isCompilerIssuedId(action.targetId) && validRef(action.value, state);
  }
  if (action.type === "collection.filter") {
    return typeof action.facetId === "string" && action.facetId.length <= 80 && validRef(action.value, state);
  }
  if (action.type === "collection.sort" || action.type === "collection.view") return validRef(action.value, state);
  if (action.type === "collection.page") return validRef(action.cursor, state);
  if (action.type === "search.update" || action.type === "search.submit") return validRef(action.query, state);
  if (action.type === "navigate") {
    if (!["home", "collection", "product", "search", "cart", "checkout", "account", "policy"].includes(action.target.routeId)) return false;
    return Object.entries(action.target.params).every(([key, ref]) =>
      ["handle", "query", "policyId"].includes(key) && validRef(ref, state),
    );
  }
  if (action.type === "surface.open" || action.type === "surface.close" || action.type === "surface.toggle") {
    return isCompilerIssuedId(action.surfaceId);
  }
  if (action.type === "carousel.previous" || action.type === "carousel.next" || action.type === "scroll.to") {
    return isCompilerIssuedId(action.targetId);
  }
  return action.type === "search.clear";
}

function validateArtifact(
  root: HTMLElement,
  artifact: HydrateStorefrontOptions["artifact"],
  adapters: RuntimeAdapters,
): RuntimeState {
  if (artifact.requiredCapabilities.some((capability) => !SUPPORTED_CAPABILITIES.has(capability))) {
    throw new RuntimeManifestError("Storefront requires an unsupported runtime capability");
  }
  if (artifact.requiredCapabilities.includes("catalogFiltering") && !adapters.collection) {
    throw new RuntimeManifestError("Catalog filtering requires a trusted adapter");
  }
  if (artifact.requiredCapabilities.includes("catalogSearch") && !adapters.search) {
    throw new RuntimeManifestError("Catalog search requires a trusted adapter");
  }
  if (artifact.requiredCapabilities.includes("commerce") && !adapters.commerce) {
    throw new RuntimeManifestError("Commerce requires a trusted adapter");
  }
  if ((artifact.requiredCapabilities.includes("navigation") ||
    artifact.interactions.transitions.some((transition) => transition.action.type === "navigate")) && !adapters.navigate) {
    throw new RuntimeManifestError("Navigation requires a trusted adapter");
  }
  const manifest = artifact.interactions;
  if (manifest.version !== 1 || manifest.bindings.length > 256 || manifest.transitions.length > 256) {
    throw new RuntimeManifestError("Interaction manifest version or size is unsupported");
  }
  const state = createInitialRuntimeState(manifest);
  for (const binding of manifest.bindings) {
    if (!isCompilerIssuedId(binding.stateId) || !Object.hasOwn(state, binding.stateId)) {
      throw new RuntimeManifestError("Binding state is unresolved");
    }
    if (localElements(root, binding.targetId).length === 0) throw new RuntimeManifestError("Binding target is unresolved");
  }
  for (const transition of manifest.transitions) {
    if (!SUPPORTED_ACTIONS.has(transition.action.type)) throw new RuntimeManifestError("Interaction action is unsupported");
    if (!validAction(transition.action, state)) throw new RuntimeManifestError("Interaction action was not compiler-validated");
    if (localElements(root, transition.sourceId).length === 0) throw new RuntimeManifestError("Transition source is unresolved");
    const target = actionTarget(transition.action);
    if (target && localElements(root, target).length === 0) throw new RuntimeManifestError("Action target is unresolved");
  }
  const slotIds = new Set<string>();
  for (const slot of artifact.trustedSlots) {
    if (!isCompilerIssuedId(slot.id) || slotIds.has(slot.id)) throw new RuntimeManifestError("Trusted slot ID is invalid");
    if (slot.kind === "cartLineControls" && (!slot.scopeId || slot.scopeId === "root" || !isCompilerIssuedId(slot.scopeId))) {
      throw new RuntimeManifestError("cartLineControls requires an exact compiler-issued cartLine repeat scope");
    }
    slotIds.add(slot.id);
    const hosts = localElements(root, slot.id);
    if (hosts.length === 0 || hosts.some((host) => host.dataset.cdTrustedSlot !== slot.kind)) {
      throw new RuntimeManifestError("Trusted slot host is unresolved or mismatched");
    }
    if (slot.kind === "cartLineControls" && hosts.some((host) =>
      host.dataset.cdSlotScope !== slot.scopeId || !host.closest<HTMLElement>("[data-cd-instance]"))) {
      throw new RuntimeManifestError("cartLineControls host is outside its exact repeated cartLine instance");
    }
  }
  return state;
}

interface ElementSnapshot {
  attributes: Array<[string, string]>;
  value?: string;
}

class DomMutationJournal {
  private readonly snapshots = new Map<HTMLElement, ElementSnapshot>();

  capture(element: HTMLElement): void {
    if (this.snapshots.has(element)) return;
    this.snapshots.set(element, {
      attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
      value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : undefined,
    });
  }

  restore(): void {
    const errors: unknown[] = [];
    for (const [element, snapshot] of this.snapshots) {
      for (const attribute of [...element.attributes]) {
        try { element.removeAttribute(attribute.name); } catch (error) { errors.push(error); }
      }
      for (const [name, value] of snapshot.attributes) {
        try { element.setAttribute(name, value); } catch (error) { errors.push(error); }
      }
      try {
        if (snapshot.value !== undefined && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          element.value = snapshot.value;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    this.snapshots.clear();
    if (errors.length > 0) throw new AggregateError(errors, "Failed to restore storefront DOM mutations");
  }
}

function applyBindings(
  root: HTMLElement,
  manifest: InteractionManifestV1,
  stateFor: (instanceId?: string) => RuntimeState,
  journal: DomMutationJournal,
  onlyInstanceId?: string,
): void {
  for (const binding of manifest.bindings) {
    const targets = onlyInstanceId === undefined
      ? localElements(root, binding.targetId)
      : instanceElement(root, binding.targetId, onlyInstanceId);
    for (const target of targets) {
      const instanceId = target.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance;
      const value = stateFor(instanceId)[binding.stateId];
      journal.capture(target);
      if (binding.property === "hidden") target.hidden = Boolean(value);
      else if (binding.property === "expanded") target.setAttribute("aria-expanded", String(Boolean(value)));
      else if (binding.property === "selected") {
        if (typeof value === "boolean") target.setAttribute("aria-selected", String(value));
        else target.setAttribute("data-cd-active-value", String(value));
      } else if (binding.property === "activeIndex") {
        target.setAttribute("data-cd-active-index", String(value));
        [...target.children].forEach((child, index) => {
          if (child instanceof HTMLElement) {
            journal.capture(child);
            child.hidden = index !== value;
          }
        });
      } else if (binding.property === "textQuery") {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.value = String(value);
        else target.setAttribute("data-cd-query", String(value));
      } else if (binding.property === "classToken") {
        target.setAttribute("data-cd-class-token", String(value));
      } else if (binding.property === "progress01") {
        const progress = typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
        target.style.setProperty("--cd-progress", String(progress));
      }
    }
  }
}

function commerceIntentAllowed(slot: TrustedSlotManifest, intent: CommerceIntent): boolean {
  if (intent.type === "variant.select") return slot.kind === "variantPicker" || slot.kind === "quickViewCommerce";
  if (intent.type === "cart.add") return slot.kind === "addToCart" || slot.kind === "quickViewCommerce";
  if (intent.type === "cart.quantity" || intent.type === "cart.remove") return slot.kind === "cartLineControls" || slot.kind === "cartDrawer";
  return slot.kind === "cartSummary" || slot.kind === "cartDrawer";
}

function validCommerceIntent(intent: CommerceIntent): boolean {
  if (intent.type === "cart.clear" || intent.type === "checkout.start") {
    return typeof intent.cartId === "string" && intent.cartId.length > 0 && intent.cartId.length <= 160;
  }
  if (intent.type === "variant.select") {
    return typeof intent.productId === "string" && intent.productId.length > 0 && intent.productId.length <= 160 &&
      typeof intent.variantId === "string" && intent.variantId.length > 0 && intent.variantId.length <= 160;
  }
  if (intent.type === "cart.add") {
    return typeof intent.productId === "string" && intent.productId.length > 0 && intent.productId.length <= 160 &&
      typeof intent.variantId === "string" && intent.variantId.length > 0 && intent.variantId.length <= 160 &&
      Number.isSafeInteger(intent.quantity) && intent.quantity >= 1 && intent.quantity <= 100;
  }
  if (typeof intent.lineId !== "string" || intent.lineId.length === 0 || intent.lineId.length > 160) return false;
  return intent.type === "cart.remove" || (Number.isSafeInteger(intent.quantity) && intent.quantity >= 0 && intent.quantity <= 100);
}

function commerceIntentMatchesAuthority(authorityKey: string, intent: CommerceIntent): boolean {
  const separator = authorityKey.indexOf(":");
  if (separator <= 0) return false;
  const kind = authorityKey.slice(0, separator);
  const id = authorityKey.slice(separator + 1);
  if (!id || id.length > 200) return false;
  if (kind === "product") return (intent.type === "variant.select" || intent.type === "cart.add") && intent.productId === id;
  if (kind === "variant") return (intent.type === "variant.select" || intent.type === "cart.add") && intent.variantId === id;
  if (kind === "cartLine") return (intent.type === "cart.quantity" || intent.type === "cart.remove") && intent.lineId === id;
  if (kind === "cart") return (intent.type === "cart.clear" || intent.type === "checkout.start") && intent.cartId === id;
  return false;
}

function mountCommerce(
  root: HTMLElement,
  slots: readonly TrustedSlotManifest[],
  adapters: RuntimeAdapters,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const committed: Array<{ host: HTMLElement; shadowRoot: ShadowRoot }> = [];
  if (slots.length === 0) return cleanups;
  const commerce = adapters.commerce;
  if (!commerce) throw new RuntimeManifestError("Commerce capability requires a trusted adapter");
  for (const slot of slots) {
    for (const host of localElements(root, slot.id)) {
      const authorityKey = host.dataset.cdAuthorityKey;
      if (!authorityKey || authorityKey.length > 240) throw new RuntimeManifestError("Trusted commerce authority is missing");
      if (host.shadowRoot) throw new RuntimeManifestError("Trusted commerce host uses an untrusted open root");
      const reset = (): HTMLStyleElement => {
        const style = host.ownerDocument.createElement("style");
        style.textContent = ":host{box-sizing:border-box;contain:content}*,*::before,*::after{box-sizing:border-box}";
        return style;
      };
      const markUnavailable = (targetHost: HTMLElement, targetRoot: ShadowRoot): void => {
        const unavailable = targetHost.ownerDocument.createElement("span");
        unavailable.setAttribute("data-cd-commerce-unavailable", "");
        unavailable.setAttribute("role", "status");
        unavailable.textContent = "Commerce unavailable";
        targetRoot.replaceChildren(reset(), unavailable);
      };
      const provisionalHost = host.ownerDocument.createElement("div");
      const provisionalRoot = provisionalHost.attachShadow({ mode: "closed" });
      provisionalRoot.append(reset());
      let cleanup: void | (() => void);
      try {
        cleanup = commerce.mount({
          shadowRoot: provisionalRoot,
          host: provisionalHost,
          slot,
          authorityKey,
          bridge(intent) {
            if (!validCommerceIntent(intent) || !commerceIntentAllowed(slot, intent) ||
              !commerceIntentMatchesAuthority(authorityKey, intent)) {
              throw new RuntimeManifestError("Trusted commerce bridge rejected intent authority");
            }
            commerce.dispatch({ authorityKey, slotKind: slot.kind, intent });
          },
        });
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          const shadowRoot = closedCommerceRoots.get(host) ?? host.attachShadow({ mode: "closed" });
          closedCommerceRoots.set(host, shadowRoot);
          markUnavailable(host, shadowRoot);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        rollbackErrors.push(...runCleanups(cleanups));
        for (const mounted of committed) {
          try { markUnavailable(mounted.host, mounted.shadowRoot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "Commerce mount and rollback failed");
        }
        throw error;
      }
      const shadowRoot = closedCommerceRoots.get(host) ?? host.attachShadow({ mode: "closed" });
      closedCommerceRoots.set(host, shadowRoot);
      shadowRoot.replaceChildren(...provisionalRoot.childNodes);
      committed.push({ host, shadowRoot });
      cleanups.push(() => {
        const errors: unknown[] = [];
        if (cleanup) {
          try { cleanup(); } catch (error) { errors.push(error); }
        }
        try { shadowRoot.replaceChildren(reset()); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, `Failed to cleanup commerce host ${host.id}`);
      });
    }
  }
  return cleanups;
}

function failedHandle(error: RuntimeManifestError): StorefrontRuntimeHandle {
  return { hydrated: false, error, getState: () => Object.freeze({}), teardown() {} };
}

function runCleanups(cleanups: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanups.length = 0;
  return errors;
}

export function hydrateStorefront(options: HydrateStorefrontOptions): StorefrontRuntimeHandle {
  const existing = mounted.get(options.root);
  if (existing) return existing;
  const adapters = options.adapters ?? {};
  let initialState: RuntimeState;
  try {
    initialState = validateArtifact(options.root, options.artifact, adapters);
  } catch (error) {
    return failedHandle(error instanceof RuntimeManifestError ? error : new RuntimeManifestError("Storefront hydration validation failed"));
  }

  const overlays = createOverlayManager(options.root);
  let state = initialState;
  const instanceStates = new Map<string, RuntimeState>();
  const journal = new DomMutationJournal();
  const removers: Array<() => void> = [];
  let tornDown = false;
  const stateFor = (instanceId?: string): RuntimeState => {
    if (!instanceId) return state;
    const existing = instanceStates.get(instanceId);
    if (existing) return existing;
    instanceStates.set(instanceId, initialState);
    return initialState;
  };
  const context: RuntimeActionContext = {
    root: options.root,
    manifest: options.artifact.interactions,
    state,
    getState: stateFor,
    setState(next, instanceId) {
      if (instanceId) instanceStates.set(instanceId, next);
      else {
        state = next;
        context.state = next;
      }
    },
    applyBindings(instanceId) {
      applyBindings(options.root, options.artifact.interactions, stateFor, journal, instanceId);
    },
    snapshotElement(element) { journal.capture(element); },
    adapters,
    overlays,
  };

  const reducedMotion = options.root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  context.reducedMotion = reducedMotion;
  try {
    applyBindings(options.root, options.artifact.interactions, stateFor, journal);
    removers.push(...mountCommerce(options.root, options.artifact.trustedSlots, adapters));
    for (const transition of options.artifact.interactions.transitions) {
      for (const source of localElements(options.root, transition.sourceId)) {
        if (transition.on === "scrollProgress") {
          const update = (): void => {
            const rect = source.getBoundingClientRect();
            const viewport = options.root.ownerDocument.defaultView?.innerHeight ?? 0;
            const progress01 = reducedMotion ? 1 : Math.min(1, Math.max(0, (viewport - rect.top) / Math.max(1, viewport + rect.height)));
            const event = new Event("scrollProgress") as Event & { progress01: number };
            event.progress01 = progress01;
            executeRuntimeAction(context, transition.action, event, source);
          };
          options.root.ownerDocument.defaultView?.addEventListener("scroll", update, { passive: true });
          removers.push(() => options.root.ownerDocument.defaultView?.removeEventListener("scroll", update));
          update();
          continue;
        }
        if (transition.on === "inview") {
          const Observer = options.root.ownerDocument.defaultView?.IntersectionObserver;
          if (!Observer) continue;
          const observer = new Observer((entries) => {
            if (entries.some((entry) => entry.target === source && entry.isIntersecting)) {
              executeRuntimeAction(context, transition.action, new Event("inview"), source);
            }
          });
          observer.observe(source);
          removers.push(() => observer.disconnect());
          continue;
        }
        const eventName = transition.on;
        const listener = (event: Event): void => executeRuntimeAction(context, transition.action, event, source);
        source.addEventListener(eventName, listener);
        removers.push(() => source.removeEventListener(eventName, listener));
      }
    }
  } catch (error) {
    const rollbackErrors = runCleanups(removers);
    try {
      overlays.teardown();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      journal.restore();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    const message = error instanceof RuntimeManifestError ? error.message : "Storefront hydration failed";
    const failure = new RuntimeManifestError(rollbackErrors.length > 0
      ? `${message}; rollback reported ${rollbackErrors.length} restoration error(s)`
      : message);
    if (rollbackErrors.length > 0) {
      Object.defineProperty(failure, "cause", {
        value: new AggregateError([error, ...rollbackErrors], "Storefront hydration and rollback failed"),
      });
    }
    return failedHandle(failure);
  }

  const handle: StorefrontRuntimeHandle = {
    hydrated: true,
    getState: () => state,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      const errors = runCleanups(removers);
      try {
        overlays.teardown();
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          journal.restore();
        } catch (error) {
          errors.push(error);
        }
        mounted.delete(options.root);
        active.delete(handle);
      }
      if (errors.length) throw new AggregateError(errors, "Storefront runtime teardown failed");
    },
  };
  mounted.set(options.root, handle);
  active.add(handle);
  return handle;
}

export function teardownStorefront(root?: HTMLElement): void {
  if (root) mounted.get(root)?.teardown();
  else {
    const errors: unknown[] = [];
    for (const handle of [...active]) {
      try {
        handle.teardown();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Storefront runtime teardown failed");
  }
}
