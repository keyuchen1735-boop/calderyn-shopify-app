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
  return [...root.querySelectorAll<HTMLElement>("[id]")].filter(
    (element) => element.id === id || element.id.startsWith(`${id}-`),
  );
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
    slotIds.add(slot.id);
    const hosts = localElements(root, slot.id);
    if (hosts.length === 0 || hosts.some((host) => host.dataset.cdTrustedSlot !== slot.kind)) {
      throw new RuntimeManifestError("Trusted slot host is unresolved or mismatched");
    }
  }
  return state;
}

function applyBindings(root: HTMLElement, manifest: InteractionManifestV1, state: RuntimeState): void {
  for (const binding of manifest.bindings) {
    const value = state[binding.stateId];
    for (const target of localElements(root, binding.targetId)) {
      if (binding.property === "hidden") target.hidden = Boolean(value);
      else if (binding.property === "expanded") target.setAttribute("aria-expanded", String(Boolean(value)));
      else if (binding.property === "selected") {
        if (typeof value === "boolean") target.setAttribute("aria-selected", String(value));
        else target.setAttribute("data-cd-active-value", String(value));
      } else if (binding.property === "activeIndex") {
        target.setAttribute("data-cd-active-index", String(value));
        [...target.children].forEach((child, index) => {
          if (child instanceof HTMLElement) child.hidden = index !== value;
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
  if (intent.type === "cart.clear" || intent.type === "checkout.start") return true;
  if (intent.type === "variant.select") return typeof intent.variantId === "string" && intent.variantId.length > 0 && intent.variantId.length <= 160;
  if (intent.type === "cart.add") {
    return typeof intent.variantId === "string" && intent.variantId.length > 0 && intent.variantId.length <= 160 &&
      Number.isSafeInteger(intent.quantity) && intent.quantity >= 1 && intent.quantity <= 100;
  }
  if (typeof intent.lineId !== "string" || intent.lineId.length === 0 || intent.lineId.length > 160) return false;
  return intent.type === "cart.remove" || (Number.isSafeInteger(intent.quantity) && intent.quantity >= 0 && intent.quantity <= 100);
}

function mountCommerce(
  root: HTMLElement,
  slots: readonly TrustedSlotManifest[],
  adapters: RuntimeAdapters,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  if (slots.length === 0) return cleanups;
  const commerce = adapters.commerce;
  if (!commerce) throw new RuntimeManifestError("Commerce capability requires a trusted adapter");
  for (const slot of slots) {
    for (const host of localElements(root, slot.id)) {
      const authorityKey = host.dataset.cdAuthorityKey;
      if (!authorityKey || authorityKey.length > 240) throw new RuntimeManifestError("Trusted commerce authority is missing");
      if (host.shadowRoot) throw new RuntimeManifestError("Trusted commerce host uses an untrusted open root");
      const shadowRoot = closedCommerceRoots.get(host) ?? host.attachShadow({ mode: "closed" });
      closedCommerceRoots.set(host, shadowRoot);
      const reset = host.ownerDocument.createElement("style");
      reset.textContent = ":host{box-sizing:border-box;contain:content}*,*::before,*::after{box-sizing:border-box}";
      shadowRoot.replaceChildren(reset);
      const cleanup = commerce.mount({
        shadowRoot,
        host,
        slot,
        authorityKey,
        bridge(intent) {
          if (!validCommerceIntent(intent) || !commerceIntentAllowed(slot, intent)) {
            throw new RuntimeManifestError("Trusted commerce bridge rejected the intent");
          }
          commerce.dispatch(intent);
        },
      });
      if (cleanup) cleanups.push(cleanup);
    }
  }
  return cleanups;
}

function failedHandle(error: RuntimeManifestError): StorefrontRuntimeHandle {
  return { hydrated: false, error, getState: () => Object.freeze({}), teardown() {} };
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
  const removers: Array<() => void> = [];
  let tornDown = false;
  const context: RuntimeActionContext = {
    root: options.root,
    manifest: options.artifact.interactions,
    state,
    setState(next) { state = next; context.state = next; },
    applyBindings() { applyBindings(options.root, options.artifact.interactions, state); },
    adapters,
    overlays,
  };

  const reducedMotion = options.root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  try {
    applyBindings(options.root, options.artifact.interactions, state);
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
    for (const remove of removers.reverse()) remove();
    overlays.teardown();
    return failedHandle(error instanceof RuntimeManifestError ? error : new RuntimeManifestError("Storefront hydration failed"));
  }

  const handle: StorefrontRuntimeHandle = {
    hydrated: true,
    getState: () => state,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      for (const remove of removers.reverse()) remove();
      overlays.teardown();
      mounted.delete(options.root);
      active.delete(handle);
    },
  };
  mounted.set(options.root, handle);
  active.add(handle);
  return handle;
}

export function teardownStorefront(root?: HTMLElement): void {
  if (root) mounted.get(root)?.teardown();
  else for (const handle of [...active]) handle.teardown();
}
