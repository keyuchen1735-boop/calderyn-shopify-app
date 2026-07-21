import {
  isCuratedFontId,
  isPublicBindingPath,
  type CompiledBinding,
  type CompiledBindingKind,
  type CompiledElementNode,
  type CompiledNode,
  type CompiledRepeat,
  type DataRequirement,
  type InteractionManifestV1,
  type PublicDataRef,
  type RouteTarget,
  type RuntimeActionSpec,
  type RuntimeCapability,
  type TrustedPersonalizationField,
  type TrustedSlotManifest,
} from "../storefront-bundle/types";
import { compileState, assertInteractionCompatibility } from "./interactions";
import { assertValidAssetEntry, isCompilerIdentifier } from "./assets";
import {
  CompilerError,
  compileRepeat,
  isBindingKindPathAllowed,
  isPathVisible,
  type BindingScope,
  type BindingScopeKind,
} from "./bindings";
import { RUNTIME_CSS_CUSTOM_PROPERTY_IDS, assertSafeDesignTokenValue, requiredCssCustomPropertyIds, validateCompiledCss } from "./css";
import { isAllowedCompiledTag, serializeCompiledTree, type ProtectedCssNode } from "./html";
import { isVisualLayerSpec } from "../storebuilder/fx/shader";

export const validationLimitsV1 = Object.freeze({
  routeHtmlCssBytes: 250 * 1024,
  interactionManifestBytes: 40 * 1024,
  bundleExcludingImagesBytes: 1_500 * 1024,
  maxDomNodesPerRoute: 2_000,
  maxCssRulesPerRoute: 1_000,
  maxBindingsPerRoute: 512,
  maxStatesPerRoute: 64,
  maxActionsPerRoute: 256,
  maxTrustedSlotsPerRoute: 64,
});

export interface CompilerDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface BundleValidationReport {
  profileVersion: 1;
  ok: boolean;
  diagnostics: CompilerDiagnostic[];
}

type UnknownRecord = Record<string, unknown>;
type AddDiagnostic = (code: string, path: string, message: string) => void;

const encoder = new TextEncoder();
const ROUTE_IDS = new Set(["home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound", "account", "policy"]);
const EVENTS = new Set(["click", "change", "input", "keydown", "inview", "scrollProgress"]);
const BINDING_KINDS = new Set<CompiledBindingKind>(["text", "money", "src", "alt", "href"]);
const SLOT_KINDS = new Set<TrustedSlotManifest["kind"]>([
  "variantPicker", "addToCart", "bundleBuilder", "cartLineControls", "cartSummary", "cartDrawer", "quickViewCommerce",
]);
const HOST_SIZES = new Set<TrustedSlotManifest["hostSize"]>(["inline", "block", "panel", "page"]);
const COMPILED_ATTRIBUTES = new Set([
  "class", "title", "role", "tabindex", "alt", "width", "height", "loading", "decoding", "open", "href", "for",
  "type", "name", "placeholder", "value", "muted", "autoplay", "playsinline", "loop", "preload", "data-cd-video",
  "data-cd-repeat-id", "data-cd-bind-text", "data-cd-bind-money", "data-cd-bind-src", "data-cd-bind-alt", "data-cd-bind-href",
  "data-cd-route-target", "data-cd-trusted-slot-id", "data-cd-platform-content", "data-cd-asset-key",
  "data-cd-empty-state", "data-cd-native-control", "data-cd-poster-asset-key", "data-cd-motion",
]);
const DECLARATIVE_MOTIONS = new Set(["reveal", "parallax", "count-up", "pinned", "scroll-progress"]);

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "-" || character === "_")) return false;
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validControlAttribute(tag: unknown, name: string, value: string): boolean {
  if (name === "type") {
    if (tag === "input") return ["search", "text", "radio", "checkbox"].includes(value);
    return tag === "source" && ["video/webm", "video/mp4"].includes(value);
  }
  if (name === "name") return tag === "input" && isIdentifier(value) && value.length <= 80;
  if (name === "placeholder") return tag === "input" && value.length <= 160 && !hasControlCharacter(value);
  if (name === "value") return (tag === "input" || tag === "button" || tag === "option" || tag === "select") && value.length <= 120 && !hasControlCharacter(value);
  if (["muted", "autoplay", "playsinline", "loop", "data-cd-video"].includes(name)) return tag === "video" && value === "";
  if (name === "preload") return tag === "video" && ["none", "metadata", "auto"].includes(value);
  if (name === "data-cd-poster-asset-key") return tag === "video" && isCompilerIdentifier(value);
  if (name === "data-cd-motion") return DECLARATIVE_MOTIONS.has(value);
  return true;
}

function splitWhitespace(value: string): string[] {
  const result: string[] = [];
  let current = "";
  for (const character of value) {
    if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f") {
      if (current) result.push(current);
      current = "";
    } else current += character;
  }
  if (current) result.push(current);
  return result;
}

interface TreeContext {
  nodes: CompiledNode[];
  ids: Set<string>;
  elements: Map<string, CompiledElementNode>;
  scopes: Map<string, BindingScope & { parentId?: string }>;
  elementScopes: Map<string, string>;
  repeats: CompiledRepeat[];
  protectedNodes: ProtectedCssNode[];
  count: number;
}

function parseRouteTarget(
  value: unknown,
  path: string,
  add: AddDiagnostic,
  scopes: ReadonlyMap<string, BindingScope>,
  elementScopeId: string,
): RouteTarget | null {
  const input = record(value);
  if (!input || typeof input.routeId !== "string" || !ROUTE_IDS.has(input.routeId)) {
    add("route.target", path, "Route target is malformed");
    return null;
  }
  const paramsInput = record(input.params);
  if (!paramsInput) {
    add("route.params", `${path}.params`, "Route params must be an object");
    return null;
  }
  const params: RouteTarget["params"] = {};
  const allowedParams: Readonly<Record<string, ReadonlySet<string>>> = {
    home: new Set(), collection: new Set(["handle"]), product: new Set(["handle"]), search: new Set(["query"]),
    cart: new Set(), checkout: new Set(), account: new Set(), policy: new Set(["policyId"]),
  };
  for (const [key, refValue] of Object.entries(paramsInput)) {
    if ((key !== "handle" && key !== "query" && key !== "policyId") || !allowedParams[input.routeId]!.has(key)) {
      add("route.param", `${path}.params.${key}`, "Unsupported route parameter");
      continue;
    }
    const ref = parseDataRef(refValue, `${path}.params.${key}`, add, scopes, elementScopeId, "route.scope");
    if (!ref) continue;
    if (key === "handle") {
      const expected = input.routeId === "product" ? "product.handle" : "collection.handle";
      if (ref.kind !== "data" || ref.path !== expected) add("route.param", `${path}.params.${key}`, `Handle must bind ${expected}`);
    } else if (key === "query" && (ref.kind !== "data" || ref.path !== "search.query")) {
      add("route.param", `${path}.params.${key}`, "Query must bind search.query");
    } else if (key === "policyId" && (ref.kind !== "literal" || typeof ref.value !== "string" || !new Set(["privacy", "terms", "refund", "shipping"]).has(ref.value))) {
      add("route.param", `${path}.params.${key}`, "Policy ID is not allowlisted");
    }
    params[key] = ref;
  }
  return { routeId: input.routeId as RouteTarget["routeId"], params };
}

function parseRepeat(value: unknown, path: string, add: AddDiagnostic, parentScope: BindingScope): CompiledRepeat | null {
  const input = record(value);
  if (!input || typeof input.source !== "string" || !isCompilerIdentifier(input.scopeId) || typeof input.keyPath !== "string") {
    add("tree.repeat", path, "Compiled repeat is malformed or unsupported");
    return null;
  }
  try {
    const repeat = compileRepeat(input.source, input.scopeId, parentScope, input.keyPath);
    if (input.itemKind !== repeat.itemKind) {
      add("tree.repeat", path, "Compiled repeat item kind does not match its source");
      return null;
    }
    return repeat;
  } catch (error) {
    const code = error instanceof CompilerError && error.code === "repeat.scope" ? "tree.repeat_scope" : "tree.repeat";
    add(code, path, error instanceof Error ? error.message : "Compiled repeat is malformed or unsupported");
    return null;
  }
}

function parseTree(
  value: unknown,
  path: string,
  namespace: string,
  add: AddDiagnostic,
  checkout: boolean,
  rootScopeKind: BindingScopeKind,
): TreeContext {
  const context: TreeContext = {
    nodes: [], ids: new Set(), elements: new Map(), scopes: new Map([["root", { id: "root", kind: rootScopeKind }]]),
    elementScopes: new Map(), repeats: [], protectedNodes: [], count: 0,
  };
  const parseNodes = (candidate: unknown, nodePath: string, depth: number, parentScopeId: string): CompiledNode[] => {
    if (!Array.isArray(candidate)) {
      add("tree.type", nodePath, "Compiled tree must be an array");
      return [];
    }
    if (depth > 64) {
      add("tree.depth", nodePath, "Compiled tree exceeds maximum depth");
      return [];
    }
    const nodes: CompiledNode[] = [];
    for (let index = 0; index < candidate.length; index += 1) {
      const input = record(candidate[index]);
      const currentPath = `${nodePath}[${index}]`;
      context.count += 1;
      if (!input) {
        add("tree.node", currentPath, "Compiled node must be an object");
        continue;
      }
      if (input.kind === "text") {
        if (typeof input.value !== "string") add("tree.text", currentPath, "Text node value must be a string");
        else nodes.push({ kind: "text", value: input.value });
        continue;
      }
      if (input.kind !== "element") {
        add("tree.kind", currentPath, "Unknown compiled node discriminant");
        continue;
      }
      const elementId = typeof input.id === "string" ? input.id : `invalid-${index}`;
      if (!isIdentifier(input.id) || !input.id.startsWith(`cd-${namespace}-`)) {
        add("tree.id", `${currentPath}.id`, "Compiled element ID is not namespaced");
      }
      if (context.ids.has(elementId)) add("tree.duplicate_id", `${currentPath}.id`, `Duplicate compiled ID ${elementId}`);
      context.ids.add(elementId);
      if (!isAllowedCompiledTag(input.tag)) add("tree.tag", `${currentPath}.tag`, "Compiled tag is not allowlisted");
      if (checkout && (input.tag === "button" || input.tag === "details" || input.tag === "summary" || input.tag === "input" || input.tag === "select")) {
        add("checkout.control", `${currentPath}.tag`, "Checkout decoration contains an interactive control");
      }
      const attrsInput = record(input.attributes);
      const attributes: Record<string, string> = {};
      if (!attrsInput) add("tree.attributes", `${currentPath}.attributes`, "Compiled attributes must be an object");
      else {
        for (const [name, attributeValue] of Object.entries(attrsInput)) {
          if (typeof attributeValue !== "string") {
            add("tree.attribute", `${currentPath}.attributes.${name}`, "Compiled attribute values must be strings");
            continue;
          }
          const allowed = COMPILED_ATTRIBUTES.has(name) || name.startsWith("aria-");
          if (!allowed || name.startsWith("on") || name === "style" || name === "src" || name === "srcset") {
            add("tree.attribute", `${currentPath}.attributes.${name}`, "Compiled attribute is not allowlisted");
            continue;
          }
          if (!validControlAttribute(input.tag, name, attributeValue)) {
            add("tree.control_attribute", `${currentPath}.attributes.${name}`, "Compiled control attribute is unsafe or out of bounds");
            continue;
          }
          attributes[name] = attributeValue;
        }
      }
      let compiledRepeat: CompiledRepeat | undefined;
      let elementScopeId = parentScopeId;
      if (input.repeat !== undefined) {
        const parentScope = context.scopes.get(parentScopeId)!;
        const repeat = parseRepeat(input.repeat, `${currentPath}.repeat`, add, parentScope);
        if (repeat) {
          if (context.scopes.has(repeat.scopeId)) add("tree.repeat_scope", `${currentPath}.repeat`, "Duplicate repeat scope");
          context.scopes.set(repeat.scopeId, { id: repeat.scopeId, kind: repeat.itemKind, parentId: parentScopeId });
          context.repeats.push(repeat);
          compiledRepeat = repeat;
          elementScopeId = repeat.scopeId;
        }
      }
      const children = parseNodes(input.children, `${currentPath}.children`, depth + 1, elementScopeId);
      const element: CompiledElementNode = {
        kind: "element",
        id: elementId,
        tag: typeof input.tag === "string" ? input.tag : "div",
        attributes,
        children,
      };
      if (compiledRepeat) element.repeat = compiledRepeat;
      if (input.routeTarget !== undefined) {
        const target = parseRouteTarget(input.routeTarget, `${currentPath}.routeTarget`, add, context.scopes, elementScopeId);
        if (target) element.routeTarget = target;
      }
      if (input.trustedSlotId !== undefined) {
        if (typeof input.trustedSlotId !== "string" || input.trustedSlotId !== input.id) {
          add("slot.host", `${currentPath}.trustedSlotId`, "Trusted slot host identity is malformed");
        } else element.trustedSlotId = input.trustedSlotId;
      }
      context.elements.set(element.id, element);
      context.elementScopes.set(element.id, elementScopeId);
      nodes.push(element);
    }
    return nodes;
  };
  context.nodes = parseNodes(value, path, 0, "root");

  const collectProtected = (nodes: readonly CompiledNode[]): boolean => {
    let contains = false;
    for (const node of nodes) {
      if (node.kind === "text") continue;
      const protectedChild = collectProtected(node.children);
      if (node.trustedSlotId || protectedChild) {
        context.protectedNodes.push({
          id: node.id,
          tag: node.tag,
          classes: splitWhitespace(node.attributes.class ?? ""),
          attributes: { ...node.attributes },
        });
        contains = true;
      }
    }
    return contains;
  };
  collectProtected(context.nodes);
  for (const element of context.elements.values()) {
    for (const name of ["aria-controls", "aria-labelledby", "aria-describedby", "aria-owns", "aria-activedescendant", "for"]) {
      const value = element.attributes[name];
      if (value && splitWhitespace(value).some((id) => !context.ids.has(id))) add("tree.idref", `${path}.${element.id}.${name}`, "Compiled IDREF is unresolved");
    }
    const href = element.attributes.href;
    if (href && (!href.startsWith("#") || !context.ids.has(href.slice(1)))) add("tree.idref", `${path}.${element.id}.href`, "Compiled fragment is unresolved");
    if (element.repeat && element.attributes["data-cd-repeat-id"] !== element.repeat.scopeId) add("tree.repeat_marker", `${path}.${element.id}`, "Repeat marker does not match repeat scope");
    if (element.trustedSlotId && element.attributes["data-cd-trusted-slot-id"] !== element.trustedSlotId) add("slot.host", `${path}.${element.id}`, "Trusted slot marker does not match host identity");
    if (element.attributes["data-cd-platform-content"] && element.attributes["data-cd-platform-content"] !== "policyLinks") add("tree.platform_content", `${path}.${element.id}`, "Platform content marker is unsupported");
    if (element.attributes["data-cd-empty-state"] !== undefined && element.attributes["data-cd-empty-state"] !== "") add("tree.empty_state", `${path}.${element.id}`, "Empty-state marker is malformed");
    if (element.attributes["data-cd-asset-key"] && !isIdentifier(element.attributes["data-cd-asset-key"])) add("asset.key", `${path}.${element.id}`, "Compiled asset key is malformed");
    if (element.attributes["data-cd-poster-asset-key"] && !isIdentifier(element.attributes["data-cd-poster-asset-key"])) add("asset.key", `${path}.${element.id}`, "Compiled poster asset key is malformed");
  }
  return context;
}

function parseDataRef(
  value: unknown,
  path: string,
  add: AddDiagnostic,
  scopes: ReadonlyMap<string, BindingScope>,
  expectedScopeId?: string,
  scopeDiagnosticCode = "binding.scope",
): PublicDataRef | null {
  const input = record(value);
  if (!input || typeof input.kind !== "string") {
    add("binding.ref", path, "Data reference is malformed");
    return null;
  }
  if (input.kind === "data") {
    if (!isPublicBindingPath(input.path)) {
      add("binding.path", `${path}.path`, "Binding path is not public");
      return null;
    }
    if (expectedScopeId !== undefined && input.scopeId !== expectedScopeId) {
      add(scopeDiagnosticCode, `${path}.scopeId`, "Data reference does not belong to the owning element scope");
      return null;
    }
    const resolvedScopeId = expectedScopeId ?? (typeof input.scopeId === "string" ? input.scopeId : undefined);
    const scope = resolvedScopeId === undefined ? undefined : scopes.get(resolvedScopeId);
    if (!scope) {
      add(scopeDiagnosticCode, `${path}.scopeId`, "Data reference scope is unresolved");
      return null;
    }
    if (!isPathVisible(input.path, scope)) {
      add(scopeDiagnosticCode, path, `Data path ${input.path} is not visible from scope ${scope.id}`);
      return null;
    }
    return { kind: "data", scopeId: scope.id, path: input.path };
  }
  if (input.kind === "state" && typeof input.stateId === "string") return { kind: "state", stateId: input.stateId };
  if (input.kind === "event" && new Set(["value", "checked", "key", "progress01"]).has(String(input.field))) {
    return { kind: "event", field: input.field as "value" | "checked" | "key" | "progress01" };
  }
  if (input.kind === "literal" && (input.value === null || ["string", "number", "boolean"].includes(typeof input.value))) {
    return { kind: "literal", value: input.value as string | number | boolean | null };
  }
  add("binding.ref", path, "Unsupported data reference discriminant or payload");
  return null;
}

function parseBindings(value: unknown, path: string, tree: TreeContext, add: AddDiagnostic): CompiledBinding[] {
  if (!Array.isArray(value)) {
    add("binding.type", path, "Bindings must be an array");
    return [];
  }
  if (value.length > validationLimitsV1.maxBindingsPerRoute) add("binding.count_limit", path, "Too many bindings");
  const bindings: CompiledBinding[] = [];
  const ids = new Set<string>();
  value.forEach((candidate, index) => {
    const input = record(candidate);
    const currentPath = `${path}[${index}]`;
    if (!input || !isIdentifier(input.id) || typeof input.targetId !== "string" || !BINDING_KINDS.has(input.kind as CompiledBindingKind)) {
      add("binding.schema", currentPath, "Compiled binding is malformed");
      return;
    }
    if (ids.has(input.id)) add("binding.duplicate_id", currentPath, "Duplicate binding ID");
    ids.add(input.id);
    if (!tree.ids.has(input.targetId)) add("binding.unresolved_target", `${currentPath}.targetId`, "Binding target is unresolved");
    const ref = parseDataRef(input.ref, `${currentPath}.ref`, add, tree.scopes);
    if (!ref || ref.kind !== "data") {
      add("binding.ref", `${currentPath}.ref`, "Compiled content bindings require a public data ref");
      return;
    }
    const kind = input.kind as CompiledBindingKind;
    if (!isBindingKindPathAllowed(kind, ref.path)) add("binding.type", currentPath, "Binding kind and public path are incompatible");
    const target = tree.elements.get(input.targetId);
    const targetScopeId = tree.elementScopes.get(input.targetId);
    if (targetScopeId && ref.scopeId !== targetScopeId) add("binding.scope", `${currentPath}.ref.scopeId`, "Binding scope does not own its target element");
    if (target?.attributes[`data-cd-bind-${kind}`] !== input.id) add("binding.marker", currentPath, "Binding marker does not match its target");
    bindings.push({ id: input.id, targetId: input.targetId, kind, ref });
  });
  return bindings;
}

function parseState(value: unknown, path: string, add: AddDiagnostic): InteractionManifestV1["state"][number] | null {
  const input = record(value);
  if (!input || !isIdentifier(input.id) || typeof input.type !== "string") {
    add("interaction.state", path, "State is malformed");
    return null;
  }
  try {
    if (input.type === "boolean" && typeof input.initial === "boolean") {
      return compileState({ id: input.id, type: input.type, initial: String(input.initial) });
    }
    if (input.type === "enum" && typeof input.initial === "string" && Array.isArray(input.allowedValues) && input.allowedValues.every((item) => typeof item === "string")) {
      return compileState({ id: input.id, type: input.type, initial: input.initial, allowedValues: input.allowedValues.join(" ") });
    }
    if ((input.type === "boundedNumber" || input.type === "index") && typeof input.initial === "number" && typeof input.min === "number" && typeof input.max === "number") {
      return compileState({ id: input.id, type: input.type, initial: String(input.initial), min: String(input.min), max: String(input.max) });
    }
    if (input.type === "textQuery" && typeof input.initial === "string") return compileState({ id: input.id, type: input.type, initial: input.initial });
  } catch (error) {
    add("interaction.state", path, error instanceof Error ? error.message : "Invalid state");
    return null;
  }
  add("interaction.state", path, "State type and initial value are incompatible");
  return null;
}

function parseAction(
  value: unknown,
  path: string,
  add: AddDiagnostic,
  scopes: ReadonlyMap<string, BindingScope>,
  elementScopeId: string,
): RuntimeActionSpec | null {
  const input = record(value);
  if (!input || typeof input.type !== "string") {
    add("interaction.action", path, "Action is malformed");
    return null;
  }
  const ref = (key: string): PublicDataRef | null => parseDataRef(input[key], `${path}.${key}`, add, scopes);
  switch (input.type) {
    case "state.set": {
      if (typeof input.stateId !== "string") break;
      const valueRef = ref("value");
      return valueRef ? { type: "state.set", stateId: input.stateId, value: valueRef } : null;
    }
    case "state.increment":
    case "state.decrement":
      if (typeof input.stateId === "string") return { type: input.type, stateId: input.stateId };
      break;
    case "surface.open":
    case "surface.close":
    case "surface.toggle":
      if (typeof input.surfaceId === "string") return { type: input.type, surfaceId: input.surfaceId };
      break;
    case "tabs.select":
    case "accordion.toggle":
    case "gallery.select": {
      const valueRef = ref("value");
      if (typeof input.targetId === "string" && valueRef) return { type: input.type, targetId: input.targetId, value: valueRef };
      break;
    }
    case "carousel.previous":
    case "carousel.next":
      if (typeof input.targetId === "string") return { type: input.type, targetId: input.targetId };
      break;
    case "collection.filter": {
      const valueRef = ref("value");
      if (isIdentifier(input.facetId) && valueRef) return { type: input.type, facetId: input.facetId, value: valueRef };
      break;
    }
    case "collection.sort":
    case "collection.view": {
      const valueRef = ref("value");
      if (valueRef) return { type: input.type, value: valueRef };
      break;
    }
    case "collection.page": {
      const cursor = ref("cursor");
      if (cursor) return { type: input.type, cursor };
      break;
    }
    case "search.update":
    case "search.submit": {
      const query = ref("query");
      if (query) return { type: input.type, query };
      break;
    }
    case "search.clear":
      return { type: "search.clear" };
    case "scroll.to":
      if (typeof input.targetId === "string") return { type: "scroll.to", targetId: input.targetId };
      break;
    case "navigate": {
      const target = parseRouteTarget(input.target, `${path}.target`, add, scopes, elementScopeId);
      if (target) return { type: "navigate", target };
      break;
    }
  }
  add("interaction.action", path, `Unsupported or malformed action ${JSON.stringify(input.type)}`);
  return null;
}

function parseInteractions(value: unknown, path: string, tree: TreeContext, add: AddDiagnostic): InteractionManifestV1 {
  const input = record(value);
  const manifest: InteractionManifestV1 = { version: 1, state: [], bindings: [], transitions: [] };
  if (!input || input.version !== 1 || !Array.isArray(input.state) || !Array.isArray(input.bindings) || !Array.isArray(input.transitions)) {
    add("interaction.schema", path, "Interaction manifest is malformed");
    return manifest;
  }
  if (input.state.length > validationLimitsV1.maxStatesPerRoute) add("interaction.state_limit", `${path}.state`, "Too many states");
  if (input.transitions.length > validationLimitsV1.maxActionsPerRoute) add("interaction.action_limit", `${path}.transitions`, "Too many actions");
  const stateIds = new Set<string>();
  input.state.forEach((candidate, index) => {
    const state = parseState(candidate, `${path}.state[${index}]`, add);
    if (!state) return;
    if (stateIds.has(state.id)) add("interaction.duplicate_state", `${path}.state[${index}]`, "Duplicate state ID");
    stateIds.add(state.id);
    manifest.state.push(state);
  });
  const properties = new Set<InteractionManifestV1["bindings"][number]["property"]>([
    "hidden", "expanded", "selected", "activeIndex", "textQuery", "classToken", "progress01",
  ]);
  input.bindings.forEach((candidate, index) => {
    const binding = record(candidate);
    const currentPath = `${path}.bindings[${index}]`;
    if (!binding || typeof binding.targetId !== "string" || typeof binding.stateId !== "string" || !properties.has(binding.property as never)) {
      add("interaction.binding", currentPath, "State binding is malformed");
      return;
    }
    if (!tree.ids.has(binding.targetId)) add("interaction.unresolved_target", currentPath, "State binding target is unresolved");
    if (!stateIds.has(binding.stateId)) add("interaction.unresolved_state", currentPath, "State binding state is unresolved");
    manifest.bindings.push({
      targetId: binding.targetId,
      stateId: binding.stateId,
      property: binding.property as InteractionManifestV1["bindings"][number]["property"],
    });
  });
  input.transitions.forEach((candidate, index) => {
    const transition = record(candidate);
    const currentPath = `${path}.transitions[${index}]`;
    if (!transition || typeof transition.sourceId !== "string" || typeof transition.on !== "string" || !EVENTS.has(transition.on)) {
      add("interaction.transition", currentPath, "Transition is malformed");
      return;
    }
    if (!tree.ids.has(transition.sourceId)) add("interaction.unresolved_source", currentPath, "Transition source is unresolved");
    const action = parseAction(
      transition.action,
      `${currentPath}.action`,
      add,
      tree.scopes,
      tree.elementScopes.get(transition.sourceId) ?? "root",
    );
    if (!action) return;
    const targetId = "surfaceId" in action ? action.surfaceId : "targetId" in action ? action.targetId : undefined;
    if (targetId && !tree.ids.has(targetId)) add("interaction.unresolved_target", currentPath, "Action target is unresolved");
    if ("stateId" in action && !stateIds.has(action.stateId)) add("interaction.unresolved_state", currentPath, "Action state is unresolved");
    manifest.transitions.push({ on: transition.on as InteractionManifestV1["transitions"][number]["on"], sourceId: transition.sourceId, action });
  });
  try {
    assertInteractionCompatibility(manifest);
  } catch (error) {
    add("interaction.compatibility", path, error instanceof Error ? error.message : "Interaction types are incompatible");
  }
  return manifest;
}

function parseSlots(value: unknown, path: string, tree: TreeContext, add: AddDiagnostic): TrustedSlotManifest[] {
  if (!Array.isArray(value)) {
    add("slot.schema", path, "Trusted slots must be an array");
    return [];
  }
  if (value.length > validationLimitsV1.maxTrustedSlotsPerRoute) add("slot.count_limit", path, "Too many trusted slots");
  const slots: TrustedSlotManifest[] = [];
  value.forEach((candidate, index) => {
    const input = record(candidate);
    const currentPath = `${path}[${index}]`;
    if (!input || typeof input.id !== "string" || !SLOT_KINDS.has(input.kind as never) || !HOST_SIZES.has(input.hostSize as never) || !Array.isArray(input.themeTokenIds) || !input.themeTokenIds.every(isIdentifier)) {
      add("slot.kind", currentPath, "Trusted slot is malformed or unsupported");
      return;
    }
    if (input.scopeId !== undefined && (typeof input.scopeId !== "string" || !tree.scopes.has(input.scopeId))) add("slot.scope", currentPath, "Trusted slot scope is unresolved");
    if (input.kind === "cartLineControls" &&
      (typeof input.scopeId !== "string" || tree.scopes.get(input.scopeId)?.kind !== "cartLine")) {
      add("slot.scope", currentPath, "cartLineControls requires an exact cartLine repeat scope");
    }
    const personalizationFields = input.personalizationFields;
    const slotCount = input.slotCount;
    const validSlotCount = input.kind === "bundleBuilder"
      ? Number.isSafeInteger(slotCount) && Number(slotCount) >= 2 && Number(slotCount) <= 12
      : slotCount === undefined;
    if (!validSlotCount) add("slot.bundle", currentPath, "bundleBuilder slot count is malformed or unsupported");
    const validPersonalizationFields = personalizationFields === undefined || (
      input.kind === "addToCart" && Array.isArray(personalizationFields) &&
      personalizationFields.length > 0 && personalizationFields.length <= 4 &&
      new Set(personalizationFields).size === personalizationFields.length &&
      personalizationFields.every((field): field is TrustedPersonalizationField =>
        field === "engraving" || field === "giftNote" || field === "giftWrap" || field === "recipient")
    );
    if (!validPersonalizationFields) {
      add("slot.personalization", currentPath, "Trusted personalization fields are malformed or unsupported");
    }
    const host = tree.elements.get(input.id);
    if (!host || host.trustedSlotId !== input.id) add("slot.unresolved_host", currentPath, "Trusted slot host is unresolved");
    else {
      const expectedScopeId = tree.elementScopes.get(input.id);
      const persistedScopeId = typeof input.scopeId === "string" ? input.scopeId : "root";
      if (expectedScopeId && persistedScopeId !== expectedScopeId) add("slot.scope", currentPath, "Trusted slot scope does not own its host");
      const attributeKeys = Object.keys(host.attributes);
      if (host.children.length > 0 || attributeKeys.length !== 1 || host.attributes["data-cd-trusted-slot-id"] !== input.id) {
        add("slot.host", currentPath, "Trusted slot host contains model-controlled presentation");
      }
    }
    slots.push({
      id: input.id,
      kind: input.kind as TrustedSlotManifest["kind"],
      scopeId: typeof input.scopeId === "string" ? input.scopeId : undefined,
      hostSize: input.hostSize as TrustedSlotManifest["hostSize"],
      themeTokenIds: input.themeTokenIds as string[],
      ...(validPersonalizationFields && Array.isArray(personalizationFields)
        ? { personalizationFields: personalizationFields as TrustedPersonalizationField[] }
        : {}),
      ...(validSlotCount && typeof slotCount === "number" ? { slotCount } : {}),
    });
  });
  return slots;
}

function deriveContract(
  namespace: string,
  tree: TreeContext,
  bindings: readonly CompiledBinding[],
  interactions: InteractionManifestV1,
  slots: readonly TrustedSlotManifest[],
): { data: DataRequirement[]; capabilities: RuntimeCapability[] } {
  const data = new Map<DataRequirement["kind"], DataRequirement>();
  const addData = (requirement: DataRequirement): void => { if (!data.has(requirement.kind)) data.set(requirement.kind, requirement); };
  for (const binding of bindings) {
    const owner = binding.ref.kind === "data" ? binding.ref.path.slice(0, binding.ref.path.indexOf(".")) : "";
    if (owner === "store") addData({ kind: "storeIdentity" });
    else if (owner === "collection") addData({ kind: "currentCollection" });
    else if (owner === "cart" || owner === "cartLine") addData({ kind: "cart" });
    else if (owner === "search") addData({ kind: "searchResults", limit: 24 });
    else if (binding.ref.kind === "data" && binding.ref.scopeId === "root" && (owner === "product" || owner === "variant")) addData({ kind: "currentProduct" });
  }
  for (const repeat of tree.repeats) {
    if (repeat.source === "collection.products") addData({ kind: "currentCollection" });
    else if (repeat.source === "featured.products") addData({ kind: "featuredProducts", limit: 12 });
    else if (repeat.source === "featured.collections") addData({ kind: "featuredCollections", limit: 12 });
    else if (repeat.source === "related.products") addData({ kind: "relatedProducts", limit: 8 });
    else if (repeat.source === "search.results") addData({ kind: "searchResults", limit: 24 });
    else if (repeat.source === "cart.lines") addData({ kind: "cart" });
    else addData({ kind: "currentProduct" });
  }
  if (namespace === "collection") addData({ kind: "currentCollection" });
  if (namespace === "product") addData({ kind: "currentProduct" });
  if (namespace === "search") addData({ kind: "searchResults", limit: 24 });
  if (namespace === "cart") addData({ kind: "cart" });
  if ([...tree.elements.values()].some((node) => node.attributes["data-cd-platform-content"] === "policyLinks")) addData({ kind: "policyLinks" });
  for (const slot of slots) {
    if (slot.kind === "bundleBuilder") addData({ kind: "featuredProducts", limit: 12 });
    else if (slot.kind === "cartLineControls" || slot.kind === "cartSummary" || slot.kind === "cartDrawer") addData({ kind: "cart" });
    else if (namespace === "product" && !slot.scopeId) addData({ kind: "currentProduct" });
  }
  const dataOrder: readonly DataRequirement["kind"][] = ["storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart", "featuredProducts", "featuredCollections", "relatedProducts", "searchResults"];
  const capabilities = new Set<RuntimeCapability>();
  if ([...tree.elements.values()].some((node) => node.routeTarget) || interactions.transitions.some((transition) => transition.action.type === "navigate")) capabilities.add("navigation");
  if (interactions.state.length || interactions.bindings.length || interactions.transitions.length) capabilities.add("localState");
  if (interactions.transitions.some((transition) => transition.action.type.startsWith("surface."))) capabilities.add("overlay");
  if (namespace === "collection" || interactions.transitions.some((transition) => transition.action.type.startsWith("collection."))) capabilities.add("catalogFiltering");
  if (namespace === "search" || interactions.transitions.some((transition) => transition.action.type.startsWith("search."))) capabilities.add("catalogSearch");
  if (slots.length) capabilities.add("commerce");
  if (slots.some((slot) => slot.kind === "cartDrawer" || slot.kind === "quickViewCommerce")) capabilities.add("overlay");
  const capabilityOrder: readonly RuntimeCapability[] = ["navigation", "localState", "overlay", "catalogFiltering", "catalogSearch", "commerce"];
  return {
    data: dataOrder.flatMap((kind) => data.get(kind) ? [data.get(kind)!] : []),
    capabilities: capabilityOrder.filter((capability) => capabilities.has(capability)),
  };
}

function validateClosedPlans(input: UnknownRecord, path: string, expected: ReturnType<typeof deriveContract>, add: AddDiagnostic): void {
  const actualData = safeJson(input.requiredData);
  const actualCapabilities = safeJson(input.requiredCapabilities);
  if (actualData !== JSON.stringify(expected.data)) add("data.plan_mismatch", `${path}.requiredData`, "Persisted data plan does not match the derived closed plan");
  if (actualCapabilities !== JSON.stringify(expected.capabilities)) add("capability.plan_mismatch", `${path}.requiredCapabilities`, "Persisted capability plan does not match the derived closed plan");
}

function routeRootScope(namespace: string): BindingScopeKind {
  if (namespace === "collection" || namespace === "product" || namespace === "search" || namespace === "cart") return namespace;
  return "store";
}

function validateRoute(value: unknown, namespace: string, path: string, add: AddDiagnostic): TreeContext {
  const rootScopeKind = routeRootScope(namespace);
  const input = record(value);
  if (!input) {
    add("route.missing", path, "Compiled route is missing");
    return parseTree([], `${path}.tree`, namespace, add, false, rootScopeKind);
  }
  const html = typeof input.html === "string" ? input.html : "";
  const css = typeof input.css === "string" ? input.css : "";
  if (typeof input.html !== "string") add("route.html", `${path}.html`, "Compiled HTML debug string is missing");
  if (typeof input.css !== "string") add("route.css", `${path}.css`, "Compiled CSS is missing");
  if (bytes(html) + bytes(css) > validationLimitsV1.routeHtmlCssBytes) add("route.byte_limit", path, "Compiled HTML+CSS exceeds 250KB");
  const tree = parseTree(input.tree, `${path}.tree`, namespace, add, false, rootScopeKind);
  if (tree.count > validationLimitsV1.maxDomNodesPerRoute) add("route.node_limit", `${path}.tree`, "Route exceeds node count limit");
  if (html !== serializeCompiledTree(tree.nodes)) add("route.html_mismatch", `${path}.html`, "Debug HTML does not match compiled tree");
  const bindings = parseBindings(input.bindings, `${path}.bindings`, tree, add);
  const interactionsJson = safeJson(input.interactions);
  if (interactionsJson && bytes(interactionsJson) > validationLimitsV1.interactionManifestBytes) add("interaction.byte_limit", `${path}.interactions`, "Interaction manifest exceeds 40KB");
  const interactions = parseInteractions(input.interactions, `${path}.interactions`, tree, add);
  for (const element of tree.elements.values()) {
    const hasBoundHref = bindings.some((binding) => binding.targetId === element.id && binding.kind === "href");
    if (element.tag === "a" && !element.routeTarget && !element.attributes.href && !hasBoundHref) {
      add("tree.inert_control", `${path}.tree.${element.id}`, "Compiled anchor is inert");
    }
    if (element.tag === "button" && !element.routeTarget && !interactions.transitions.some((transition) => transition.sourceId === element.id)) add("tree.inert_control", `${path}.tree.${element.id}`, "Compiled button is inert");
  }
  const slots = parseSlots(input.trustedSlots, `${path}.trustedSlots`, tree, add);
  for (const [index, slot] of slots.entries()) {
    let validContext = true;
    if (slot.kind === "variantPicker" || slot.kind === "addToCart") {
      validContext = namespace === "product" && !slot.scopeId;
    } else if (slot.kind === "quickViewCommerce") {
      validContext = slot.scopeId ? tree.scopes.get(slot.scopeId)?.kind === "product" : namespace === "product";
    } else if (slot.kind === "cartSummary" || slot.kind === "cartDrawer") {
      validContext = !slot.scopeId;
    }
    if (!validContext) add(
      "slot.route_scope",
      `${path}.trustedSlots[${index}]`,
      "Trusted commerce slot is incompatible with its route or repeat scope",
    );
  }
  try {
    const cssReport = validateCompiledCss(css, { namespace, protectedNodes: tree.protectedNodes });
    if (cssReport.ruleCount > validationLimitsV1.maxCssRulesPerRoute) add("route.css_rule_limit", `${path}.css`, "Route exceeds CSS rule limit");
  } catch (error) {
    const code = error instanceof CompilerError && error.code === "css.scope" ? "route.css_scope" : "route.css_unsafe";
    add(code, `${path}.css`, error instanceof Error ? error.message : "Compiled CSS is unsafe");
  }
  validateClosedPlans(input, path, deriveContract(namespace, tree, bindings, interactions, slots), add);
  return tree;
}

function validateCheckout(value: unknown, add: AddDiagnostic): TreeContext {
  const path = "routes.checkout";
  const input = record(value);
  if (!input) {
    add("route.missing", path, "Compiled checkout route is missing");
    return parseTree([], `${path}.decorativeTree`, "checkout", add, true, "store");
  }
  const html = typeof input.decorativeHtml === "string" ? input.decorativeHtml : "";
  const css = typeof input.decorativeCss === "string" ? input.decorativeCss : "";
  if (bytes(html) + bytes(css) > validationLimitsV1.routeHtmlCssBytes) add("route.byte_limit", path, "Checkout HTML+CSS exceeds 250KB");
  const tree = parseTree(input.decorativeTree, `${path}.decorativeTree`, "checkout", add, true, "store");
  if (html !== serializeCompiledTree(tree.nodes)) add("route.html_mismatch", `${path}.decorativeHtml`, "Checkout HTML does not match decorative tree");
  const bindings = parseBindings(input.bindings, `${path}.bindings`, tree, add);
  bindings.forEach((binding, index) => {
    if (binding.ref.kind !== "data" || (binding.ref.path !== "store.name" && binding.ref.path !== "store.logo")) add("checkout.binding", `${path}.bindings[${index}]`, "Checkout may only bind store identity");
  });
  try {
    validateCompiledCss(css, { namespace: "checkout", checkoutDecorative: true });
  } catch (error) {
    add("checkout.css", `${path}.decorativeCss`, error instanceof Error ? error.message : "Checkout CSS is unsafe");
  }
  const layout = record(input.layout);
  const requiredSections = ["contact", "shipping", "delivery", "consent", "payment", "summary"];
  if (
    !layout ||
    !new Set(["single", "summaryAside", "summaryFirst"]).has(String(layout.columnMode)) ||
    !Array.isArray(layout.sectionOrder) ||
    layout.sectionOrder.length !== 6 ||
    new Set(layout.sectionOrder).size !== 6 ||
    !layout.sectionOrder.every((section) => requiredSections.includes(String(section))) ||
    !isIdentifier(layout.spacingTokenId) ||
    !Array.isArray(layout.surfaceTokenIds) ||
    !layout.surfaceTokenIds.every(isIdentifier)
  ) add("checkout.layout", `${path}.layout`, "Checkout layout manifest is malformed");
  const expectedData: DataRequirement[] = [];
  if (bindings.some((binding) => binding.ref.kind === "data" && binding.ref.path.startsWith("store."))) expectedData.push({ kind: "storeIdentity" });
  if ([...tree.elements.values()].some((node) => node.attributes["data-cd-platform-content"] === "policyLinks")) expectedData.push({ kind: "policyLinks" });
  if (safeJson(input.requiredData) !== JSON.stringify(expectedData)) add("data.plan_mismatch", `${path}.requiredData`, "Checkout data plan does not match decoration");
  return tree;
}

function validateAssetReferenceSet(bundle: UnknownRecord, trees: readonly TreeContext[], add: AddDiagnostic): void {
  const assets = record(bundle.assets);
  if (!assets || !Array.isArray(assets.entries)) return;
  const manifestTypes = new Map(assets.entries.flatMap((entry) => {
    const item = record(entry);
    return typeof item?.key === "string" && typeof item.mediaType === "string" ? [[item.key, item.mediaType] as const] : [];
  }));
  const manifestKeys = new Set(manifestTypes.keys());
  const referencedKeys = new Set<string>();
  for (const tree of trees) {
    for (const element of tree.elements.values()) {
      const assetKey = element.attributes["data-cd-asset-key"];
      const posterKey = element.attributes["data-cd-poster-asset-key"];
      if (posterKey && manifestTypes.get(posterKey) !== "image/webp") {
        add("asset.media_mismatch", `assets.references.${posterKey}`, "Video poster asset must be image/webp");
      }
      if (element.tag === "source" && assetKey && manifestTypes.get(assetKey) !== element.attributes.type) {
        add("asset.media_mismatch", `assets.references.${assetKey}`, "Video source type must match its manifest media type");
      }
      for (const key of [element.attributes["data-cd-asset-key"], element.attributes["data-cd-poster-asset-key"]]) {
        if (key) referencedKeys.add(key);
      }
    }
  }
  for (const key of [...referencedKeys].sort(compareCodeUnits)) {
    if (!manifestKeys.has(key)) add("asset.reference_missing", `assets.references.${key}`, "Compiled asset reference is absent from the manifest");
  }
  for (const key of [...manifestKeys].sort(compareCodeUnits)) {
    if (!referencedKeys.has(key)) add("asset.manifest_unused", `assets.entries.${key}`, "Asset manifest key is not referenced by compiled markup");
  }
}

function validateBundleEnvelope(bundle: UnknownRecord, add: AddDiagnostic): void {
  if (bundle.schemaVersion !== 1) add("bundle.schema", "schemaVersion", "Unsupported schema version");
  if (bundle.runtimeVersion !== 1) add("bundle.runtime", "runtimeVersion", "Unsupported runtime version");
  if (bundle.validationProfileVersion !== 1) add("bundle.profile", "validationProfileVersion", "Unsupported validation profile");
  const source = record(bundle.source);
  if (!source || (source.kind !== "recipe" && source.kind !== "custom")) add("bundle.source", "source", "Bundle source is malformed");
  if (bundle.visualLayer !== undefined && !isVisualLayerSpec(bundle.visualLayer)) {
    add("bundle.visual_layer", "visualLayer", "Visual layer is malformed or exceeds its source cap");
  }
  const concept = record(bundle.concept);
  if (!concept || typeof concept.name !== "string" || typeof concept.rationale !== "string" || !Array.isArray(concept.noveltySignature) || !concept.noveltySignature.every((item) => typeof item === "string")) {
    add("bundle.concept", "concept", "Bundle concept is malformed");
  }
  const design = record(bundle.designSystem);
  if (!design || !isCuratedFontId(design.displayFontId) || !isCuratedFontId(design.bodyFontId) || typeof design.globalCss !== "string" || !record(design.tokens) || !record(design.breakpoints) || typeof design.iconStyle !== "string" || typeof design.motionStyle !== "string") {
    add("bundle.design", "designSystem", "Design system is malformed");
  } else {
    for (const [key, value] of Object.entries(design.tokens as UnknownRecord)) {
      if (!isCompilerIdentifier(key) || typeof value !== "string") {
        add("bundle.tokens", `designSystem.tokens.${key}`, "Design token keys and values are malformed");
        continue;
      }
      try { assertSafeDesignTokenValue(key, value); }
      catch (error) { add("bundle.tokens", `designSystem.tokens.${key}`, error instanceof Error ? error.message : "Design token value is unsafe"); }
    }
    for (const [key, value] of Object.entries(design.breakpoints as UnknownRecord)) {
      if (!isCompilerIdentifier(key) || typeof value !== "number" || !Number.isFinite(value) || value < 240 || value > 3840) {
        add("bundle.breakpoints", `designSystem.breakpoints.${key}`, "Breakpoint must match compiler bounds");
      }
    }
    if (design.iconStyle.length > 120 || design.motionStyle.length > 120) add("bundle.design", "designSystem", "Design descriptions exceed compiler bounds");
  }
  const assets = record(bundle.assets);
  if (!assets || !Array.isArray(assets.entries)) add("asset.schema", "assets", "Asset manifest is malformed");
  else {
    const keys = new Set<string>();
    assets.entries.forEach((entry, index) => {
      const item = record(entry);
      try { assertValidAssetEntry(entry); }
      catch (error) {
        add("asset.entry", `assets.entries[${index}]`, error instanceof Error ? error.message : "Asset entry is malformed");
        return;
      }
      if (!item) return;
      if (keys.has(item.key as string)) add("asset.duplicate", `assets.entries[${index}]`, "Asset key is duplicated");
      else keys.add(item.key as string);
    });
  }
}

function validateGlobalCss(value: unknown, protectedNodes: readonly ProtectedCssNode[], add: AddDiagnostic): void {
  const design = record(value);
  if (!design || typeof design.globalCss !== "string") return;
  try { validateCompiledCss(design.globalCss, { namespace: "global", protectedNodes }); }
  catch (error) { add("bundle.global_css", "designSystem.globalCss", error instanceof Error ? error.message : "Global CSS is unsafe"); }
}

function validateDesignTokenCoverage(bundle: UnknownRecord, add: AddDiagnostic): void {
  const design = record(bundle.designSystem);
  const tokens = record(design?.tokens);
  if (!design || !tokens) return;
  const tokenIds = new Set([...Object.keys(tokens), ...RUNTIME_CSS_CUSTOM_PROPERTY_IDS]);
  const routes = record(bundle.routes);
  const cssArtifacts: Array<[string, unknown]> = [
    ["designSystem.globalCss", design.globalCss],
    ["shell.css", record(bundle.shell)?.css],
    ...(["home", "collection", "product", "search", "cart"] as const).map((routeId) => [
      `routes.${routeId}.css`,
      record(routes?.[routeId])?.css,
    ] as [string, unknown]),
    ...(["collections", "story", "notFound"] as const).flatMap((routeId) => routes?.[routeId] === undefined ? [] : [[
      `routes.${routeId}.css`, record(routes[routeId])?.css,
    ] as [string, unknown]]),
    ["routes.checkout.decorativeCss", record(routes?.checkout)?.decorativeCss],
  ];
  for (const [path, css] of cssArtifacts) {
    if (typeof css !== "string") continue;
    try {
      for (const tokenId of requiredCssCustomPropertyIds(css)) {
        if (!tokenIds.has(tokenId)) add("bundle.token_reference", path, `CSS references missing design token --${tokenId}`);
      }
    } catch {
      // The artifact-specific CSS validator reports malformed CSS separately.
    }
  }
  for (const [routeId, route] of [["shell", bundle.shell], ...(["home", "collection", "product", "search", "cart", "collections", "story", "notFound"] as const).map((id) => [id, routes?.[id]])] as Array<[string, unknown]>) {
    const trustedSlots = record(route)?.trustedSlots;
    if (!Array.isArray(trustedSlots)) continue;
    trustedSlots.forEach((slot, index) => {
      const ids = record(slot)?.themeTokenIds;
      if (!Array.isArray(ids)) return;
      ids.forEach((tokenId) => {
        if (typeof tokenId === "string" && !tokenIds.has(tokenId)) {
          add("bundle.token_reference", `${routeId}.trustedSlots[${index}]`, `Commerce slot references missing design token --${tokenId}`);
        }
      });
    });
  }
  const layout = record(record(routes?.checkout)?.layout);
  const layoutTokenIds = [layout?.spacingTokenId, ...(Array.isArray(layout?.surfaceTokenIds) ? layout.surfaceTokenIds : [])];
  layoutTokenIds.forEach((tokenId) => {
    if (typeof tokenId === "string" && !tokenIds.has(tokenId)) {
      add("bundle.token_reference", "routes.checkout.layout", `Checkout layout references missing design token --${tokenId}`);
    }
  });
}

export function validateCompiledBundle(value: unknown): BundleValidationReport {
  const diagnostics: CompilerDiagnostic[] = [];
  const add: AddDiagnostic = (code, path, message) => diagnostics.push({ code, path, message });
  const bundle = record(value);
  if (!bundle) add("bundle.type", "bundle", "Compiled bundle must be an object");
  else {
    validateBundleEnvelope(bundle, add);
    const protectedNodes: ProtectedCssNode[] = [];
    const trees: TreeContext[] = [];
    const shell = validateRoute(bundle.shell, "shell", "shell", add);
    trees.push(shell);
    protectedNodes.push(...shell.protectedNodes);
    const routes = record(bundle.routes);
    if (!routes) add("bundle.routes", "routes", "Bundle routes must be an object");
    for (const routeId of ["home", "collection", "product", "search", "cart"] as const) {
      const tree = validateRoute(routes?.[routeId], routeId, `routes.${routeId}`, add);
      trees.push(tree);
      protectedNodes.push(...tree.protectedNodes);
    }
    for (const routeId of ["collections", "story", "notFound"] as const) {
      if (routes?.[routeId] === undefined) continue;
      const tree = validateRoute(routes[routeId], routeId, `routes.${routeId}`, add);
      trees.push(tree);
      protectedNodes.push(...tree.protectedNodes);
    }
    trees.push(validateCheckout(routes?.checkout, add));
    validateAssetReferenceSet(bundle, trees, add);
    validateGlobalCss(bundle.designSystem, protectedNodes, add);
    validateDesignTokenCoverage(bundle, add);
    const serialized = safeJson(value);
    if (!serialized) add("bundle.serialization", "bundle", "Bundle is not serializable");
    else if (bytes(serialized) > validationLimitsV1.bundleExcludingImagesBytes) add("bundle.byte_limit", "bundle", "Bundle exceeds 1.5MB excluding image payloads");
  }
  diagnostics.sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code) || compareCodeUnits(a.message, b.message));
  return { profileVersion: 1, ok: diagnostics.length === 0, diagnostics };
}
