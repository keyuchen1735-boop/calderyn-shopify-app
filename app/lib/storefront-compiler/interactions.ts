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
    action = { type: source.action, stateId: source.stateId, value: eventRef(source.valueField) };
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
