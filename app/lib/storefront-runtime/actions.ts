import type {
  InteractionManifestV1,
  PublicDataRef,
  RouteTarget,
  RuntimeActionSpec,
  TrustedSlotManifest,
} from "~/lib/storefront-bundle/types";
import type { OverlayManager } from "./overlays";
import type { StorefrontLinePersonalization } from "./trusted-slots";
import {
  isCompilerIssuedId,
  reduceRuntimeState,
  runtimeStateDefinition,
  RuntimeManifestError,
  type RuntimeState,
} from "./state";

export type CollectionIntent =
  | { type: "filter"; facetId: string; value: unknown }
  | { type: "sort" | "view"; value: unknown }
  | { type: "page"; cursor: unknown };

export type SearchIntent =
  | { type: "update" | "submit"; query: unknown }
  | { type: "clear" };

export interface ResolvedRouteTarget {
  routeId: RouteTarget["routeId"];
  params: Partial<Record<"handle" | "query" | "policyId", unknown>>;
}

export interface RuntimeAdapters {
  resolveData?: (ref: Extract<PublicDataRef, { kind: "data" }>, source: HTMLElement | null) => unknown;
  collection?: (intent: CollectionIntent) => void;
  search?: (intent: SearchIntent) => void;
  navigate?: (target: ResolvedRouteTarget) => void;
  commerce?: CommerceAdapter;
}

export interface RuntimeActionContext {
  root: HTMLElement;
  manifest: InteractionManifestV1;
  state: RuntimeState;
  getState?(instanceId?: string): RuntimeState;
  setState(next: RuntimeState, instanceId?: string): void;
  applyBindings(instanceId?: string): void;
  snapshotElement?(element: HTMLElement): void;
  reducedMotion?: boolean;
  adapters: RuntimeAdapters;
  overlays: OverlayManager;
}

export type CommerceIntent =
  | { type: "variant.select"; productId: string; variantId: string }
  | { type: "cart.add"; productId: string; variantId: string; quantity: number; personalization?: StorefrontLinePersonalization; sellingPlanId?: string }
  | { type: "cart.addBundle"; lines: Array<{ productId: string; variantId: string; quantity: 1 }> }
  | { type: "cart.quantity"; lineId: string; quantity: number }
  | { type: "cart.remove"; lineId: string }
  | { type: "cart.clear"; cartId: string }
  | { type: "checkout.start"; cartId: string };

export interface CommerceDispatch {
  authorityKey: string;
  slotKind: TrustedSlotManifest["kind"];
  intent: CommerceIntent;
}

export interface CommerceMountContext {
  shadowRoot: ShadowRoot;
  host: HTMLElement;
  slot: TrustedSlotManifest;
  authorityKey: string;
  bridge(intent: CommerceIntent): void;
}

export interface CommerceAdapter {
  mount(context: CommerceMountContext): void | (() => void);
  dispatch(command: CommerceDispatch): void;
}

function instanceIdFor(source: HTMLElement | null): string | undefined {
  return source?.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance;
}

function currentState(context: RuntimeActionContext, source: HTMLElement | null): RuntimeState {
  return context.getState?.(instanceIdFor(source)) ?? context.state;
}

function eventValue(event: Event, field: Extract<PublicDataRef, { kind: "event" }>["field"]): unknown {
  const target = event.target;
  if (field === "key") return event instanceof KeyboardEvent ? event.key : "";
  if (field === "progress01") {
    const candidate = "progress01" in event ? (event as Event & { progress01: unknown }).progress01 : 0;
    return typeof candidate === "number" && Number.isFinite(candidate) ? Math.min(1, Math.max(0, candidate)) : 0;
  }
  if (field === "checked") return target instanceof HTMLInputElement ? target.checked : false;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
    return target.value;
  }
  return target instanceof HTMLElement ? target.getAttribute("value") ?? target.textContent ?? "" : "";
}

export function resolveRuntimeRef(
  context: RuntimeActionContext,
  ref: PublicDataRef,
  event: Event,
  source: HTMLElement | null,
): unknown {
  if (ref.kind === "literal") return ref.value;
  if (ref.kind === "state") return currentState(context, source)[ref.stateId];
  if (ref.kind === "event") return eventValue(event, ref.field);
  return context.adapters.resolveData?.(ref, source) ?? null;
}

function localElements(root: HTMLElement, targetId: string, source: HTMLElement | null): HTMLElement[] {
  if (!isCompilerIssuedId(targetId)) throw new RuntimeManifestError("Action target is not compiler-issued");
  const instanceId = instanceIdFor(source);
  const concreteId = instanceId ? `${targetId}-${instanceId}` : targetId;
  const candidate = root.ownerDocument.getElementById(concreteId);
  const matches = candidate instanceof HTMLElement && root.contains(candidate) &&
    (!instanceId || candidate.closest<HTMLElement>("[data-cd-instance]")?.dataset.cdInstance === instanceId)
    ? [candidate]
    : [];
  if (matches.length === 0) throw new RuntimeManifestError(`Action target ${targetId} is not local`);
  return matches;
}

function stateBindingFor(
  context: RuntimeActionContext,
  targetId: string,
  property: InteractionManifestV1["bindings"][number]["property"],
): string | null {
  return context.manifest.bindings.find((binding) => binding.targetId === targetId && binding.property === property)?.stateId ?? null;
}

function setBoundState(
  context: RuntimeActionContext,
  targetId: string,
  property: InteractionManifestV1["bindings"][number]["property"],
  value: unknown,
  source: HTMLElement | null,
): boolean {
  const stateId = stateBindingFor(context, targetId, property);
  if (!stateId) return false;
  const instanceId = instanceIdFor(source);
  context.setState(reduceRuntimeState(context.manifest, currentState(context, source), { type: "set", stateId, value }), instanceId);
  context.applyBindings(instanceId);
  return true;
}

function resolveTarget(context: RuntimeActionContext, target: RouteTarget, event: Event, source: HTMLElement | null): ResolvedRouteTarget {
  return {
    routeId: target.routeId,
    params: Object.fromEntries(
      Object.entries(target.params).flatMap(([key, ref]) => ref ? [[key, resolveRuntimeRef(context, ref, event, source)]] : []),
    ),
  };
}

export function executeRuntimeAction(
  context: RuntimeActionContext,
  action: RuntimeActionSpec,
  event: Event,
  source: HTMLElement | null,
): void {
  if (action.type === "state.set" || action.type === "state.increment" || action.type === "state.decrement") {
    const update = action.type === "state.set"
      ? { type: "set" as const, stateId: action.stateId, value: resolveRuntimeRef(context, action.value!, event, source) }
      : { type: action.type === "state.increment" ? "increment" as const : "decrement" as const, stateId: action.stateId };
    const instanceId = instanceIdFor(source);
    context.setState(reduceRuntimeState(context.manifest, currentState(context, source), update), instanceId);
    context.applyBindings(instanceId);
    return;
  }
  if (action.type === "surface.open" || action.type === "surface.close" || action.type === "surface.toggle") {
    if (!isCompilerIssuedId(action.surfaceId)) throw new RuntimeManifestError("Action target is not compiler-issued");
    const method = action.type.slice("surface.".length) as "open" | "close" | "toggle";
    context.overlays[method](action.surfaceId, source);
    return;
  }
  if (action.type === "tabs.select" || action.type === "gallery.select") {
    localElements(context.root, action.targetId, source);
    const value = resolveRuntimeRef(context, action.value, event, source);
    if (!setBoundState(context, action.targetId, "selected", value, source)) {
      for (const target of localElements(context.root, action.targetId, source)) {
        context.snapshotElement?.(target);
        target.setAttribute("data-cd-active-value", String(value ?? ""));
      }
    }
    return;
  }
  if (action.type === "accordion.toggle") {
    localElements(context.root, action.targetId, source);
    const stateId = stateBindingFor(context, action.targetId, "expanded") ?? stateBindingFor(context, action.targetId, "hidden");
    const activeState = currentState(context, source);
    if (!stateId || typeof activeState[stateId] !== "boolean") throw new RuntimeManifestError("Accordion target lacks boolean state");
    const instanceId = instanceIdFor(source);
    context.setState(reduceRuntimeState(context.manifest, activeState, { type: "set", stateId, value: !activeState[stateId] }), instanceId);
    context.applyBindings(instanceId);
    return;
  }
  if (action.type === "carousel.previous" || action.type === "carousel.next") {
    localElements(context.root, action.targetId, source);
    const stateId = stateBindingFor(context, action.targetId, "activeIndex");
    if (!stateId || !runtimeStateDefinition(context.manifest, stateId)) throw new RuntimeManifestError("Carousel target lacks index state");
    const instanceId = instanceIdFor(source);
    context.setState(reduceRuntimeState(context.manifest, currentState(context, source), {
      type: action.type === "carousel.next" ? "increment" : "decrement", stateId,
    }), instanceId);
    context.applyBindings(instanceId);
    return;
  }
  if (action.type === "collection.filter") {
    context.adapters.collection?.({ type: "filter", facetId: action.facetId, value: resolveRuntimeRef(context, action.value, event, source) });
    return;
  }
  if (action.type === "collection.sort" || action.type === "collection.view") {
    context.adapters.collection?.({ type: action.type === "collection.sort" ? "sort" : "view", value: resolveRuntimeRef(context, action.value, event, source) });
    return;
  }
  if (action.type === "collection.page") {
    context.adapters.collection?.({ type: "page", cursor: resolveRuntimeRef(context, action.cursor, event, source) });
    return;
  }
  if (action.type === "search.update" || action.type === "search.submit") {
    context.adapters.search?.({ type: action.type === "search.update" ? "update" : "submit", query: resolveRuntimeRef(context, action.query, event, source) });
    return;
  }
  if (action.type === "search.clear") {
    context.adapters.search?.({ type: "clear" });
    return;
  }
  if (action.type === "scroll.to") {
    const target = localElements(context.root, action.targetId, source)[0]!;
    target.scrollIntoView?.({ behavior: context.reducedMotion ? "auto" : "smooth", block: "start" });
    return;
  }
  if (action.type === "navigate") {
    context.adapters.navigate?.(resolveTarget(context, action.target, event, source));
    return;
  }
  throw new RuntimeManifestError(`Unsupported runtime action ${JSON.stringify((action as { type?: unknown }).type)}`);
}
