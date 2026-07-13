import type { InteractionManifestV1, PublicDataRef, RuntimeActionSpec } from "../storefront-bundle/types";
import { CompilerError } from "./bindings";

export const EMPTY_INTERACTION_MANIFEST: InteractionManifestV1 = {
  version: 1,
  state: [],
  bindings: [],
  transitions: [],
};

type InteractionState = InteractionManifestV1["state"][number];

export interface StateSource {
  id: string;
  type: string;
  initial: string;
  allowedValues?: string;
  min?: string;
  max?: string;
}

function finiteNumber(value: string | undefined, label: string): number {
  if (value === undefined || value.trim() === "") throw new CompilerError("interaction.state_bound", `${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CompilerError("interaction.state_bound", `${label} must be finite`);
  return parsed;
}

export function compileState(source: StateSource): InteractionState {
  if (source.type === "boolean") {
    if (source.initial !== "true" && source.initial !== "false") {
      throw new CompilerError("interaction.state_initial", "Boolean state must start with true or false");
    }
    return { id: source.id, type: "boolean", initial: source.initial === "true" };
  }
  if (source.type === "enum") {
    const allowedValues = (source.allowedValues ?? "").split(" ").filter(Boolean);
    if (allowedValues.length < 2 || allowedValues.length > 32 || allowedValues.some((value) => value.length > 40)) {
      throw new CompilerError("interaction.state_values", "Enum state requires 2 to 32 bounded values");
    }
    if (!allowedValues.includes(source.initial)) {
      throw new CompilerError("interaction.state_initial", "Enum initial value must be allowlisted");
    }
    return { id: source.id, type: "enum", initial: source.initial, allowedValues };
  }
  if (source.type === "boundedNumber" || source.type === "index") {
    const min = finiteNumber(source.min, "State minimum bound");
    const max = finiteNumber(source.max, "State maximum bound");
    const initial = finiteNumber(source.initial, "State initial value");
    if (max < min || max - min > 10_000 || initial < min || initial > max) {
      throw new CompilerError("interaction.state_bound", "Numeric state must use bounded ordered limits containing its initial value");
    }
    if (source.type === "index" && ![min, max, initial].every(Number.isSafeInteger)) {
      throw new CompilerError("interaction.state_bound", "Index state bounds must be safe integers");
    }
    return { id: source.id, type: source.type, initial, min, max };
  }
  if (source.type === "textQuery") {
    if (source.initial.length > 200) throw new CompilerError("interaction.state_initial", "Text query state exceeds 200 characters");
    return { id: source.id, type: "textQuery", initial: source.initial };
  }
  throw new CompilerError("interaction.state_type", `Unsupported state type ${JSON.stringify(source.type)}`);
}

const STATE_BINDING_PROPERTIES = new Set<InteractionManifestV1["bindings"][number]["property"]>([
  "hidden", "expanded", "selected", "activeIndex", "textQuery", "classToken", "progress01",
]);

export function compileStateBinding(
  targetId: string,
  stateId: string,
  property: string,
): InteractionManifestV1["bindings"][number] {
  if (!STATE_BINDING_PROPERTIES.has(property as InteractionManifestV1["bindings"][number]["property"])) {
    throw new CompilerError("interaction.binding_property", `Unsupported state binding property ${JSON.stringify(property)}`);
  }
  return { targetId, stateId, property: property as InteractionManifestV1["bindings"][number]["property"] };
}

const EVENTS = new Set<InteractionManifestV1["transitions"][number]["on"]>([
  "click",
  "change",
  "input",
  "keydown",
  "inview",
  "scrollProgress",
]);

const TARGET_ACTIONS = new Set([
  "surface.open",
  "surface.close",
  "surface.toggle",
  "tabs.select",
  "accordion.toggle",
  "gallery.select",
  "carousel.previous",
  "carousel.next",
  "scroll.to",
]);

const VALUE_ACTIONS = new Set([
  "collection.sort",
  "collection.view",
  "collection.page",
  "search.update",
  "search.submit",
]);

function eventRef(field: string | undefined): PublicDataRef {
  const eventField = field ?? "value";
  if (!new Set(["value", "checked", "key", "progress01"]).has(eventField)) {
    throw new CompilerError("interaction.value", `Unsupported event field ${JSON.stringify(eventField)}`);
  }
  return { kind: "event", field: eventField as Extract<PublicDataRef, { kind: "event" }>["field"] };
}

export interface ActionSource {
  on: string;
  action: string;
  sourceId: string;
  targetId?: string;
  stateId?: string;
  valueField?: string;
  facetId?: string;
  routeTarget?: Extract<RuntimeActionSpec, { type: "navigate" }>["target"];
}

export function compileTransition(source: ActionSource): InteractionManifestV1["transitions"][number] {
  if (!EVENTS.has(source.on as InteractionManifestV1["transitions"][number]["on"])) {
    throw new CompilerError("interaction.event", `Unsupported interaction event ${JSON.stringify(source.on)}`);
  }

  let action: RuntimeActionSpec;
  if (TARGET_ACTIONS.has(source.action)) {
    if (!source.targetId) throw new CompilerError("interaction.target", `${source.action} requires a local target`);
    if (source.action.startsWith("surface.")) {
      action = { type: source.action as "surface.open" | "surface.close" | "surface.toggle", surfaceId: source.targetId };
    } else if (source.action === "scroll.to") {
      action = { type: "scroll.to", targetId: source.targetId };
    } else if (source.action.startsWith("carousel.")) {
      action = { type: source.action as "carousel.previous" | "carousel.next", targetId: source.targetId };
    } else {
      action = {
        type: source.action as "tabs.select" | "accordion.toggle" | "gallery.select",
        targetId: source.targetId,
        value: eventRef(source.valueField),
      };
    }
  } else if (source.action === "state.set" || source.action === "state.increment" || source.action === "state.decrement") {
    if (!source.stateId) throw new CompilerError("interaction.state", `${source.action} requires a state ID`);
    action = source.action === "state.set"
      ? { type: source.action, stateId: source.stateId, value: eventRef(source.valueField) }
      : { type: source.action, stateId: source.stateId };
  } else if (source.action === "collection.filter") {
    if (!source.facetId) throw new CompilerError("interaction.facet", "collection.filter requires a facet ID");
    action = { type: "collection.filter", facetId: source.facetId, value: eventRef(source.valueField) };
  } else if (VALUE_ACTIONS.has(source.action)) {
    const value = eventRef(source.valueField);
    if (source.action === "collection.page") action = { type: "collection.page", cursor: value };
    else if (source.action === "search.update" || source.action === "search.submit") action = { type: source.action, query: value };
    else action = { type: source.action as "collection.sort" | "collection.view", value };
  } else if (source.action === "search.clear") {
    action = { type: "search.clear" };
  } else if (source.action === "navigate") {
    if (!source.routeTarget) throw new CompilerError("interaction.route", "navigate requires a validated route target");
    action = { type: "navigate", target: source.routeTarget };
  } else {
    throw new CompilerError("interaction.action", `Unsupported action ${JSON.stringify(source.action)}`);
  }

  return {
    on: source.on as InteractionManifestV1["transitions"][number]["on"],
    sourceId: source.sourceId,
    action,
  };
}

function stateAcceptsRef(
  state: InteractionState,
  ref: PublicDataRef | undefined,
  states: ReadonlyMap<string, InteractionState>,
): boolean {
  if (!ref) return false;
  if (ref.kind === "state") {
    const referenced = states.get(ref.stateId);
    if (!referenced || referenced.type !== state.type) return false;
    if (state.type === "enum") {
      return JSON.stringify(referenced.allowedValues ?? []) === JSON.stringify(state.allowedValues ?? []);
    }
    return true;
  }
  if (state.type === "boolean") {
    return (ref.kind === "event" && ref.field === "checked") || (ref.kind === "literal" && typeof ref.value === "boolean");
  }
  if (state.type === "enum") {
    return (ref.kind === "event" && ref.field === "value") ||
      (ref.kind === "literal" && typeof ref.value === "string" && (state.allowedValues ?? []).includes(ref.value));
  }
  if (state.type === "boundedNumber" || state.type === "index") {
    if (ref.kind === "event") return ref.field === "value" || ref.field === "progress01";
    return ref.kind === "literal" && typeof ref.value === "number" && ref.value >= (state.min ?? 0) && ref.value <= (state.max ?? 0);
  }
  return (ref.kind === "event" && ref.field === "value") ||
    (ref.kind === "literal" && typeof ref.value === "string" && ref.value.length <= 200);
}

export function assertInteractionCompatibility(manifest: InteractionManifestV1): void {
  const states = new Map(manifest.state.map((state) => [state.id, state]));
  for (const binding of manifest.bindings) {
    const state = states.get(binding.stateId);
    if (!state) throw new CompilerError("interaction.state", `Unknown state ${binding.stateId}`);
    const compatible =
      (binding.property === "hidden" && state.type === "boolean") ||
      (binding.property === "expanded" && state.type === "boolean") ||
      (binding.property === "selected" && (state.type === "boolean" || state.type === "enum")) ||
      (binding.property === "activeIndex" && state.type === "index") ||
      (binding.property === "textQuery" && state.type === "textQuery") ||
      (binding.property === "classToken" && state.type === "enum") ||
      (binding.property === "progress01" && state.type === "boundedNumber" && state.min === 0 && state.max === 1);
    if (!compatible) {
      throw new CompilerError("interaction.binding_state", `${binding.property} is incompatible with ${state.type} state`);
    }
  }
  for (const transition of manifest.transitions) {
    const action = transition.action;
    if (action.type === "state.set" || action.type === "state.increment" || action.type === "state.decrement") {
      const state = states.get(action.stateId);
      if (!state) throw new CompilerError("interaction.state", `Unknown state ${action.stateId}`);
      if ((action.type === "state.increment" || action.type === "state.decrement") && state.type !== "boundedNumber" && state.type !== "index") {
        throw new CompilerError("interaction.action_state", `${action.type} requires numeric bounded state`);
      }
      if (action.type === "state.set" && !stateAcceptsRef(state, action.value, states)) {
        throw new CompilerError("interaction.action_value", `state.set value is incompatible with ${state.type} state`);
      }
    }
    if (transition.on === "scrollProgress") {
      const valid =
        action.type === "state.set" &&
        action.value?.kind === "event" &&
        action.value.field === "progress01" &&
        states.get(action.stateId)?.type === "boundedNumber" &&
        states.get(action.stateId)?.min === 0 &&
        states.get(action.stateId)?.max === 1;
      if (!valid) throw new CompilerError("interaction.scroll_progress", "scrollProgress requires normalized bounded 0..1 state.set");
    }
  }
}
