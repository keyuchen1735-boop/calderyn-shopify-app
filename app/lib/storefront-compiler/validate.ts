import type {
  CheckoutRouteArtifact,
  CompiledNode,
  DataRequirement,
  RouteArtifact,
  StorefrontBundleV1,
} from "../storefront-bundle/types";
import postcss from "postcss";

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

const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function collectTree(
  nodes: readonly CompiledNode[],
  ids: Set<string>,
  scopes: Set<string>,
  diagnostics: CompilerDiagnostic[],
  path: string,
): number {
  let count = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    count += 1;
    if (node.kind === "text") continue;
    const nodePath = `${path}.tree[${index}]`;
    if (ids.has(node.id)) diagnostics.push({ code: "tree.duplicate_id", path: nodePath, message: `Duplicate compiled ID ${node.id}` });
    ids.add(node.id);
    if (node.repeat) scopes.add(node.repeat.scopeId);
    for (const attribute of Object.keys(node.attributes)) {
      if (attribute === "data-cd-action" || attribute === "data-cd-on" || attribute === "data-cd-target" || attribute === "data-cd-repeat") {
        diagnostics.push({ code: "tree.source_attribute", path: nodePath, message: `Source attribute ${attribute} survived compilation` });
      }
    }
    count += collectTree(node.children, ids, scopes, diagnostics, `${nodePath}.children`);
  }
  return count;
}

function cssRuleCount(css: string): number | null {
  let count = 0;
  try {
    postcss.parse(css, { from: undefined }).walkRules(() => {
      count += 1;
    });
  } catch {
    return null;
  }
  return count;
}

function validateRoute(route: RouteArtifact, path: string, diagnostics: CompilerDiagnostic[]): void {
  if (!route || typeof route !== "object") {
    diagnostics.push({ code: "route.missing", path, message: "Compiled route is missing" });
    return;
  }
  const routeBytes = bytes(route.html ?? "") + bytes(route.css ?? "");
  if (routeBytes > validationLimitsV1.routeHtmlCssBytes) {
    diagnostics.push({ code: "route.byte_limit", path, message: `Compiled HTML+CSS is ${routeBytes} bytes` });
  }
  const manifestBytes = bytes(JSON.stringify(route.interactions ?? null));
  if (manifestBytes > validationLimitsV1.interactionManifestBytes) {
    diagnostics.push({ code: "interaction.byte_limit", path: `${path}.interactions`, message: `Interaction manifest is ${manifestBytes} bytes` });
  }
  const ids = new Set<string>();
  const scopes = new Set<string>(["root"]);
  const scopeSources = new Map<string, string>();
  const collectScopeSources = (nodes: readonly CompiledNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "text") continue;
      if (node.repeat) scopeSources.set(node.repeat.scopeId, node.repeat.source);
      collectScopeSources(node.children);
    }
  };
  collectScopeSources(route.tree ?? []);
  const nodeCount = collectTree(route.tree ?? [], ids, scopes, diagnostics, path);
  if (nodeCount > validationLimitsV1.maxDomNodesPerRoute) {
    diagnostics.push({ code: "route.node_limit", path: `${path}.tree`, message: `Route has ${nodeCount} compiled nodes` });
  }
  const ruleCount = cssRuleCount(route.css ?? "");
  if (ruleCount === null) {
    diagnostics.push({ code: "route.css_parse", path: `${path}.css`, message: "Compiled CSS is not a valid stylesheet" });
  } else if (ruleCount > validationLimitsV1.maxCssRulesPerRoute) {
    diagnostics.push({ code: "route.css_rule_limit", path: `${path}.css`, message: `Route has ${ruleCount} CSS rules` });
  }
  const bindings = route.bindings ?? [];
  if (bindings.length > validationLimitsV1.maxBindingsPerRoute) {
    diagnostics.push({ code: "binding.count_limit", path: `${path}.bindings`, message: `Route has ${bindings.length} bindings` });
  }
  const bindingIds = new Set<string>();
  const requirementKinds = new Set((route.requiredData ?? []).map((requirement) => requirement.kind));
  const requireData = (kind: DataRequirement["kind"], bindingPath: string): void => {
    if (!requirementKinds.has(kind)) {
      diagnostics.push({ code: "data.missing_requirement", path: bindingPath, message: `Binding requires ${kind} data` });
    }
  };
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const bindingPath = `${path}.bindings[${index}]`;
    if (bindingIds.has(binding.id)) diagnostics.push({ code: "binding.duplicate_id", path: bindingPath, message: `Duplicate binding ID ${binding.id}` });
    bindingIds.add(binding.id);
    if (!ids.has(binding.targetId)) diagnostics.push({ code: "binding.unresolved_target", path: bindingPath, message: `Missing target ${binding.targetId}` });
    if (binding.ref.kind === "data" && !scopes.has(binding.ref.scopeId)) {
      diagnostics.push({ code: "binding.unresolved_scope", path: bindingPath, message: `Missing scope ${binding.ref.scopeId}` });
    }
    if (binding.ref.kind === "data") {
      const owner = binding.ref.path.slice(0, binding.ref.path.indexOf("."));
      const repeatSource = scopeSources.get(binding.ref.scopeId);
      if (owner === "store") requireData("storeIdentity", bindingPath);
      else if (owner === "collection") requireData("currentCollection", bindingPath);
      else if (owner === "cart" || owner === "cartLine") requireData("cart", bindingPath);
      else if (owner === "search") requireData("searchResults", bindingPath);
      else if (repeatSource === "featured.products") requireData("featuredProducts", bindingPath);
      else if (repeatSource === "related.products") requireData("relatedProducts", bindingPath);
      else if (repeatSource === "search.results") requireData("searchResults", bindingPath);
      else if (repeatSource === "collection.products") requireData("currentCollection", bindingPath);
      else if (owner === "product" || owner === "variant") requireData("currentProduct", bindingPath);
    }
  }
  const interactions = route.interactions ?? { state: [], bindings: [], transitions: [] };
  if ((interactions.state?.length ?? 0) > validationLimitsV1.maxStatesPerRoute) {
    diagnostics.push({ code: "interaction.state_limit", path: `${path}.interactions.state`, message: "Too many local states" });
  }
  if ((interactions.transitions?.length ?? 0) > validationLimitsV1.maxActionsPerRoute) {
    diagnostics.push({ code: "interaction.action_limit", path: `${path}.interactions.transitions`, message: "Too many actions" });
  }
  const stateIds = new Set<string>();
  for (let index = 0; index < (interactions.state?.length ?? 0); index += 1) {
    const state = interactions.state[index]!;
    const statePath = `${path}.interactions.state[${index}]`;
    if (stateIds.has(state.id)) diagnostics.push({ code: "interaction.duplicate_state", path: statePath, message: `Duplicate state ${state.id}` });
    stateIds.add(state.id);
  }
  for (let index = 0; index < (interactions.bindings?.length ?? 0); index += 1) {
    const binding = interactions.bindings[index]!;
    const bindingPath = `${path}.interactions.bindings[${index}]`;
    if (!ids.has(binding.targetId)) diagnostics.push({ code: "interaction.unresolved_target", path: bindingPath, message: `Missing target ${binding.targetId}` });
    if (!stateIds.has(binding.stateId)) diagnostics.push({ code: "interaction.unresolved_state", path: bindingPath, message: `Missing state ${binding.stateId}` });
  }
  for (let index = 0; index < (interactions.transitions?.length ?? 0); index += 1) {
    const transition = interactions.transitions[index]!;
    const transitionPath = `${path}.interactions.transitions[${index}]`;
    if (!ids.has(transition.sourceId)) diagnostics.push({ code: "interaction.unresolved_source", path: transitionPath, message: `Missing source ${transition.sourceId}` });
    if ("stateId" in transition.action && !stateIds.has(transition.action.stateId)) {
      diagnostics.push({ code: "interaction.unresolved_state", path: transitionPath, message: `Missing state ${transition.action.stateId}` });
    }
    const targetId =
      "surfaceId" in transition.action
        ? transition.action.surfaceId
        : "targetId" in transition.action
          ? transition.action.targetId
          : undefined;
    if (targetId !== undefined && !ids.has(targetId)) {
      diagnostics.push({ code: "interaction.unresolved_target", path: transitionPath, message: `Missing target ${targetId}` });
    }
    if (transition.on === "scrollProgress") {
      const action = transition.action;
      const state = "stateId" in action ? interactions.state.find((item) => item.id === action.stateId) : undefined;
      const validProgressState =
        action.type === "state.set" &&
        action.value?.kind === "event" &&
        action.value.field === "progress01" &&
        state?.type === "boundedNumber" &&
        state.min === 0 &&
        state.max === 1;
      if (!validProgressState) {
        diagnostics.push({ code: "interaction.scroll_progress", path: transitionPath, message: "Scroll progress must write normalized progress01 into a bounded 0..1 state" });
      }
    }
  }
  if ((route.trustedSlots?.length ?? 0) > validationLimitsV1.maxTrustedSlotsPerRoute) {
    diagnostics.push({ code: "slot.count_limit", path: `${path}.trustedSlots`, message: "Too many trusted slots" });
  }
  for (let index = 0; index < (route.trustedSlots?.length ?? 0); index += 1) {
    const slot = route.trustedSlots[index]!;
    if (!ids.has(slot.id)) diagnostics.push({ code: "slot.unresolved_host", path: `${path}.trustedSlots[${index}]`, message: `Missing slot host ${slot.id}` });
  }
}

function validateCheckout(route: CheckoutRouteArtifact, diagnostics: CompilerDiagnostic[]): void {
  const path = "routes.checkout";
  if (!route || typeof route !== "object") {
    diagnostics.push({ code: "route.missing", path, message: "Compiled checkout route is missing" });
    return;
  }
  const routeBytes = bytes(route.decorativeHtml ?? "") + bytes(route.decorativeCss ?? "");
  if (routeBytes > validationLimitsV1.routeHtmlCssBytes) {
    diagnostics.push({ code: "route.byte_limit", path, message: `Checkout HTML+CSS is ${routeBytes} bytes` });
  }
  const ids = new Set<string>();
  const scopes = new Set<string>(["root"]);
  const nodeCount = collectTree(route.decorativeTree ?? [], ids, scopes, diagnostics, path);
  if (nodeCount > validationLimitsV1.maxDomNodesPerRoute) {
    diagnostics.push({ code: "route.node_limit", path: `${path}.decorativeTree`, message: `Checkout has ${nodeCount} nodes` });
  }
  for (let index = 0; index < (route.bindings?.length ?? 0); index += 1) {
    const binding = route.bindings[index]!;
    if (!ids.has(binding.targetId)) diagnostics.push({ code: "binding.unresolved_target", path: `${path}.bindings[${index}]`, message: `Missing target ${binding.targetId}` });
    if (binding.ref.kind !== "data" || !binding.ref.path.startsWith("store.")) {
      diagnostics.push({ code: "checkout.binding", path: `${path}.bindings[${index}]`, message: "Checkout decoration may only bind store identity" });
    }
  }
}

export function validateCompiledBundle(bundle: StorefrontBundleV1): BundleValidationReport {
  const diagnostics: CompilerDiagnostic[] = [];
  if (bundle.schemaVersion !== 1) diagnostics.push({ code: "bundle.schema", path: "schemaVersion", message: "Unsupported schema version" });
  if (bundle.runtimeVersion !== 1) diagnostics.push({ code: "bundle.runtime", path: "runtimeVersion", message: "Unsupported runtime version" });
  if (bundle.validationProfileVersion !== 1) diagnostics.push({ code: "bundle.profile", path: "validationProfileVersion", message: "Unsupported validation profile" });
  validateRoute(bundle.shell, "shell", diagnostics);
  const routeIds = ["home", "collection", "product", "search", "cart"] as const;
  for (const routeId of routeIds) validateRoute(bundle.routes?.[routeId], `routes.${routeId}`, diagnostics);
  validateCheckout(bundle.routes?.checkout, diagnostics);
  const bundleBytes = bytes(JSON.stringify(bundle));
  if (bundleBytes > validationLimitsV1.bundleExcludingImagesBytes) {
    diagnostics.push({ code: "bundle.byte_limit", path: "bundle", message: `Bundle is ${bundleBytes} bytes excluding image payloads` });
  }
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  return { profileVersion: 1, ok: diagnostics.length === 0, diagnostics };
}
