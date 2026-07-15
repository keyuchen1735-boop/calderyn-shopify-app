import { createHash } from "node:crypto";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { assertSafeDesignTokenValue, compileCss } from "../storefront-compiler/css";
import { isCompilerIdentifier } from "../storefront-compiler/assets";
import { compileHtml, serializeCompiledTree, type ProtectedCssNode } from "../storefront-compiler/html";
import {
  isCuratedFontId,
  type CompiledBinding,
  type CompiledElementNode,
  type CompiledNode,
  type DataRequirement,
  type InteractionManifestV1,
  type RouteArtifact,
  type RuntimeCapability,
  type StorefrontBundleV1,
  type StorefrontRouteId,
  type TrustedSlotManifest,
} from "../storefront-bundle/types";
import type { StorefrontChangedScope, StorefrontPatchOperation } from "./types";

export class StorefrontPatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "StorefrontPatchError";
  }
}

type EditableArtifact = Pick<RouteArtifact, "tree" | "html" | "css" | "bindings" | "interactions" | "trustedSlots">;

function artifact(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): EditableArtifact {
  if (routeId === "checkout") {
    const checkout = bundle.routes.checkout;
    return {
      get tree() { return checkout.decorativeTree; },
      set tree(value) { checkout.decorativeTree = value; },
      get html() { return checkout.decorativeHtml; },
      set html(value) { checkout.decorativeHtml = value; },
      get css() { return checkout.decorativeCss; },
      set css(value) { checkout.decorativeCss = value; },
      bindings: checkout.bindings,
      interactions: { version: 1, state: [], bindings: [], transitions: [] },
      trustedSlots: [],
    };
  }
  return bundle.routes[routeId];
}

function findElement(nodes: CompiledNode[], targetId: string): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.id === targetId) return node;
    const nested = findElement(node.children, targetId);
    if (nested) return nested;
  }
  return null;
}

function findParent(nodes: CompiledNode[], targetId: string): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.children.some((child) => child.kind === "element" && child.id === targetId)) return node;
    const nested = findParent(node.children, targetId);
    if (nested) return nested;
  }
  return null;
}

function textValue(node: CompiledElementNode): string {
  return node.children.filter((child) => child.kind === "text").map((child) => child.value).join("");
}

function assertTarget(route: EditableArtifact, targetId: string): CompiledElementNode {
  if (!isCompilerIdentifier(targetId)) throw new StorefrontPatchError("patch_target_invalid", "Patch target is not a compiler-issued ID");
  const target = findElement(route.tree, targetId);
  if (!target) throw new StorefrontPatchError("patch_target_missing", `No compiler-issued target ${targetId} exists on this route`);
  return target;
}

function rewriteDebugHtml(route: EditableArtifact): void {
  route.html = serializeCompiledTree(route.tree);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function descendantIds(node: CompiledElementNode): Set<string> {
  const ids = new Set<string>();
  const visit = (candidate: CompiledElementNode): void => {
    ids.add(candidate.id);
    for (const child of candidate.children) if (child.kind === "element") visit(child);
  };
  visit(node);
  return ids;
}

function allElementIds(nodes: readonly CompiledNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (children: readonly CompiledNode[]): void => {
    for (const child of children) {
      if (child.kind !== "element") continue;
      ids.add(child.id);
      visit(child.children);
    }
  };
  visit(nodes);
  return ids;
}

function replaceElement(nodes: CompiledNode[], targetId: string, replacement: CompiledElementNode): boolean {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "element") continue;
    if (node.id === targetId) {
      nodes[index] = replacement;
      return true;
    }
    if (replaceElement(node.children, targetId, replacement)) return true;
  }
  return false;
}

function targetIsNestedInRepeat(nodes: readonly CompiledNode[], targetId: string, insideRepeat = false): boolean {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.id === targetId) return insideRepeat;
    if (targetIsNestedInRepeat(node.children, targetId, insideRepeat || node.repeat !== undefined)) return true;
  }
  return false;
}

function actionTarget(action: InteractionManifestV1["transitions"][number]["action"]): string | null {
  if ("surfaceId" in action) return action.surfaceId;
  if ("targetId" in action) return action.targetId;
  return null;
}

function mergeInteractionManifest(
  current: InteractionManifestV1,
  removedIds: ReadonlySet<string>,
  incoming: InteractionManifestV1,
): InteractionManifestV1 {
  const bindings = current.bindings.filter((binding) => !removedIds.has(binding.targetId));
  const transitions = current.transitions.filter((transition) => {
    const target = actionTarget(transition.action);
    return !removedIds.has(transition.sourceId) && (target === null || !removedIds.has(target));
  });
  const referencedStateIds = new Set<string>();
  for (const binding of bindings) referencedStateIds.add(binding.stateId);
  for (const transition of transitions) if ("stateId" in transition.action) referencedStateIds.add(transition.action.stateId);
  const state = current.state.filter((entry) => referencedStateIds.has(entry.id));
  const occupiedStates = new Set(state.map((entry) => entry.id));
  if (incoming.state.some((entry) => occupiedStates.has(entry.id))) {
    throw new StorefrontPatchError("patch_identity_collision", "Replacement interaction state collides with an untouched route state");
  }
  return {
    version: 1,
    state: [...state, ...incoming.state],
    bindings: [...bindings, ...incoming.bindings],
    transitions: [...transitions, ...incoming.transitions],
  };
}

function protectedCssNodes(nodes: readonly CompiledNode[]): ProtectedCssNode[] {
  const protectedNodes: ProtectedCssNode[] = [];
  const visit = (children: readonly CompiledNode[]): boolean => {
    let containsProtected = false;
    for (const node of children) {
      if (node.kind !== "element") continue;
      const childProtected = visit(node.children);
      if (node.trustedSlotId !== undefined || childProtected) {
        protectedNodes.push({
          id: node.id,
          tag: node.tag,
          classes: (node.attributes.class ?? "").split(/\s+/).filter(Boolean),
          attributes: { ...node.attributes },
        });
        containsProtected = true;
      }
    }
    return containsProtected;
  };
  visit(nodes);
  return protectedNodes;
}

function rootScopeKind(routeId: Exclude<StorefrontRouteId, "checkout">): "store" | "collection" | "product" | "search" | "cart" {
  return routeId === "home" ? "store" : routeId;
}

function collectTree(nodes: readonly CompiledNode[]): { repeats: NonNullable<CompiledElementNode["repeat"]>[]; elements: CompiledElementNode[] } {
  const repeats: NonNullable<CompiledElementNode["repeat"]>[] = [];
  const elements: CompiledElementNode[] = [];
  const visit = (children: readonly CompiledNode[]): void => {
    for (const node of children) {
      if (node.kind !== "element") continue;
      elements.push(node);
      if (node.repeat) repeats.push(node.repeat);
      visit(node.children);
    }
  };
  visit(nodes);
  return { repeats, elements };
}

function deriveClosedContract(
  routeId: Exclude<StorefrontRouteId, "checkout">,
  tree: readonly CompiledNode[],
  bindings: readonly CompiledBinding[],
  interactions: InteractionManifestV1,
  slots: readonly TrustedSlotManifest[],
): { requiredData: DataRequirement[]; requiredCapabilities: RuntimeCapability[] } {
  const collected = collectTree(tree);
  const data = new Map<DataRequirement["kind"], DataRequirement>();
  const add = (requirement: DataRequirement): void => { if (!data.has(requirement.kind)) data.set(requirement.kind, requirement); };
  for (const binding of bindings) {
    if (binding.ref.kind !== "data") continue;
    const owner = binding.ref.path.slice(0, binding.ref.path.indexOf("."));
    if (owner === "store") add({ kind: "storeIdentity" });
    else if (owner === "collection") add({ kind: "currentCollection" });
    else if (owner === "cart" || owner === "cartLine") add({ kind: "cart" });
    else if (owner === "search") add({ kind: "searchResults", limit: 24 });
    else if (binding.ref.scopeId === "root" && (owner === "product" || owner === "variant")) add({ kind: "currentProduct" });
  }
  for (const repeat of collected.repeats) {
    if (repeat.source === "collection.products") add({ kind: "currentCollection" });
    else if (repeat.source === "featured.products") add({ kind: "featuredProducts", limit: 12 });
    else if (repeat.source === "related.products") add({ kind: "relatedProducts", limit: 8 });
    else if (repeat.source === "search.results") add({ kind: "searchResults", limit: 24 });
    else if (repeat.source === "cart.lines") add({ kind: "cart" });
    else add({ kind: "currentProduct" });
  }
  if (routeId === "collection") add({ kind: "currentCollection" });
  if (routeId === "product") add({ kind: "currentProduct" });
  if (routeId === "search") add({ kind: "searchResults", limit: 24 });
  if (routeId === "cart") add({ kind: "cart" });
  if (collected.elements.some((node) => node.attributes["data-cd-platform-content"] === "policyLinks")) add({ kind: "policyLinks" });
  for (const slot of slots) {
    if (slot.kind === "cartLineControls" || slot.kind === "cartSummary" || slot.kind === "cartDrawer") add({ kind: "cart" });
    else if (slot.kind === "variantPicker" || slot.kind === "addToCart" || routeId === "product") {
      add({ kind: "currentProduct" });
    }
  }
  const dataOrder: readonly DataRequirement["kind"][] = [
    "storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart", "featuredProducts", "relatedProducts", "searchResults",
  ];
  const capabilities = new Set<RuntimeCapability>();
  if (collected.elements.some((node) => node.routeTarget) || interactions.transitions.some((entry) => entry.action.type === "navigate")) capabilities.add("navigation");
  if (interactions.state.length || interactions.bindings.length || interactions.transitions.length) capabilities.add("localState");
  if (interactions.transitions.some((entry) => entry.action.type.startsWith("surface."))) capabilities.add("overlay");
  if (routeId === "collection" || interactions.transitions.some((entry) => entry.action.type.startsWith("collection."))) capabilities.add("catalogFiltering");
  if (routeId === "search" || interactions.transitions.some((entry) => entry.action.type.startsWith("search."))) capabilities.add("catalogSearch");
  if (slots.length) capabilities.add("commerce");
  if (slots.some((slot) => slot.kind === "cartDrawer" || slot.kind === "quickViewCommerce")) capabilities.add("overlay");
  const capabilityOrder: readonly RuntimeCapability[] = ["navigation", "localState", "overlay", "catalogFiltering", "catalogSearch", "commerce"];
  return {
    requiredData: dataOrder.flatMap((kind) => data.get(kind) ? [data.get(kind)!] : []),
    requiredCapabilities: capabilityOrder.filter((capability) => capabilities.has(capability)),
  };
}

function assetKeys(nodes: readonly CompiledNode[]): Set<string> {
  const keys = new Set<string>();
  const visit = (children: readonly CompiledNode[]): void => {
    for (const child of children) {
      if (child.kind !== "element") continue;
      const key = child.attributes["data-cd-asset-key"];
      if (key) keys.add(key);
      visit(child.children);
    }
  };
  visit(nodes);
  return keys;
}

function replaceRegion(
  bundle: StorefrontBundleV1,
  operation: Extract<StorefrontPatchOperation, { kind: "replaceRegion" }>,
): { compilerIds: string[]; assetKeys: string[]; interactionChanged: boolean } {
  const route = bundle.routes[operation.routeId];
  const target = assertTarget(route, operation.targetId);
  if (digest(target) !== operation.expected) throw new StorefrontPatchError("patch_precondition_failed", `Region ${target.id} changed before this edit`);
  if (targetIsNestedInRepeat(route.tree, target.id)) {
    throw new StorefrontPatchError("patch_scope_invalid", "A region nested inside a data repeat cannot be structurally replaced");
  }
  if (!operation.source || typeof operation.source.html !== "string" || typeof operation.source.css !== "string" ||
      operation.source.html.length > 120_000 || operation.source.css.length > 120_000) {
    throw new StorefrontPatchError("patch_source_invalid", "Replacement compiler source is missing or exceeds the scoped size limit");
  }
  const sourceDigest = createHash("sha256").update(`${operation.source.html}\u0000${operation.source.css}`).digest("hex").slice(0, 10);
  const namespace = `${operation.routeId}-edit-${sourceDigest}`;
  let compiled: ReturnType<typeof compileHtml>;
  let css: string;
  try {
    compiled = compileHtml(operation.source.html, { namespace, rootScopeKind: rootScopeKind(operation.routeId) });
    if (compiled.tree.length !== 1 || compiled.tree[0]?.kind !== "element") {
      throw new StorefrontPatchError("patch_source_invalid", "A region replacement must compile to exactly one element root");
    }
    css = compileCss(operation.source.css, {
      namespace: operation.routeId,
      protectedNodes: compiled.protectedCssNodes,
      protectedSourceIds: compiled.protectedSourceIds,
    }).css;
  } catch (error) {
    if (error instanceof StorefrontPatchError) throw error;
    throw new StorefrontPatchError("patch_source_invalid", error instanceof Error ? error.message : "Replacement compiler source is invalid");
  }
  const replacement = compiled.tree[0];
  css = scopeRegionCss(css, replacement.id);
  const removed = descendantIds(target);
  const outside = allElementIds(route.tree);
  for (const id of removed) outside.delete(id);
  const incomingIds = allElementIds(compiled.tree);
  if ([...incomingIds].some((id) => outside.has(id))) {
    throw new StorefrontPatchError("patch_identity_collision", "Replacement compiler IDs collide with an untouched route region");
  }
  const manifestKeys = new Set(bundle.assets.entries.map((entry) => entry.key));
  const referencedAssets = assetKeys(compiled.tree);
  if ([...referencedAssets].some((key) => !manifestKeys.has(key))) {
    throw new StorefrontPatchError("patch_asset_unverified", "Replacement imagery must reference the existing verified asset manifest");
  }
  if (!replaceElement(route.tree, target.id, replacement)) throw new StorefrontPatchError("patch_target_missing", "Region disappeared during patch application");
  route.bindings = [
    ...route.bindings.filter((binding) => !removed.has(binding.targetId)),
    ...compiled.bindings,
  ];
  const priorInteractions = JSON.stringify(route.interactions);
  route.interactions = mergeInteractionManifest(route.interactions, removed, compiled.interactions);
  route.trustedSlots = [
    ...route.trustedSlots.filter((slot) => !removed.has(slot.id)),
    ...compiled.trustedSlots,
  ];
  if (css.trim()) route.css = `${route.css}\n${css}`;
  const contract = deriveClosedContract(operation.routeId, route.tree, route.bindings, route.interactions, route.trustedSlots);
  route.requiredData = contract.requiredData;
  route.requiredCapabilities = contract.requiredCapabilities;
  rewriteDebugHtml(route);
  return {
    compilerIds: [...incomingIds].sort(),
    assetKeys: [...referencedAssets].sort(),
    interactionChanged: priorInteractions !== JSON.stringify(route.interactions),
  };
}

function scopeRegionCss(css: string, replacementId: string): string {
  if (!css.trim()) return css;
  try {
    const root = postcss.parse(css, { from: undefined });
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && rule.parent.name.toLowerCase() === "keyframes") return;
      rule.selector = selectorParser((selectors) => {
        selectors.each((selector) => {
          const nodes = [...selector.nodes];
          const bundleCombinator = nodes.findIndex((node, index) => index > 0 && node.type === "combinator");
          if (bundleCombinator < 0) throw new StorefrontPatchError("patch_css_scope", "Replacement CSS lost its route scope");
          if (nodes.slice(bundleCombinator + 1).some((node) => node.type === "combinator" && (node.value.trim() === "+" || node.value.trim() === "~"))) {
            throw new StorefrontPatchError("patch_css_scope", "Replacement CSS cannot use sibling selectors outside its region");
          }
          const isPseudoElement = (node: (typeof nodes)[number]) => node.type === "pseudo" && node.value.startsWith("::");
          let compoundEnd = bundleCombinator + 1;
          while (compoundEnd + 1 < nodes.length && nodes[compoundEnd + 1]!.type !== "combinator" && !isPseudoElement(nodes[compoundEnd + 1]!)) compoundEnd += 1;
          const anchor = nodes[compoundEnd]!;
          if (isPseudoElement(anchor)) selector.insertBefore(anchor, selectorParser.id({ value: replacementId }));
          else selector.insertAfter(anchor, selectorParser.id({ value: replacementId }));
        });
      }).processSync(rule.selector, { lossless: false });
    });
    return root.toString();
  } catch (error) {
    if (error instanceof StorefrontPatchError) throw error;
    throw new StorefrontPatchError("patch_css_scope", error instanceof Error ? error.message : "Replacement CSS could not be region scoped");
  }
}

function replaceRouteCss(
  bundle: StorefrontBundleV1,
  operation: Extract<StorefrontPatchOperation, { kind: "replaceRouteCss" }>,
): void {
  const route = bundle.routes[operation.routeId];
  if (digest(route.css) !== operation.expected) throw new StorefrontPatchError("patch_precondition_failed", `CSS for ${operation.routeId} changed before this edit`);
  if (typeof operation.css !== "string" || operation.css.length > 120_000) throw new StorefrontPatchError("patch_css_invalid", "Route CSS exceeds the scoped size limit");
  try {
    route.css = compileCss(operation.css, {
      namespace: operation.routeId,
      protectedNodes: protectedCssNodes(route.tree),
    }).css;
  } catch (error) {
    throw new StorefrontPatchError("patch_css_invalid", error instanceof Error ? error.message : "Route CSS is invalid");
  }
}

function setText(route: EditableArtifact, target: CompiledElementNode, value: string, expected?: string, replaceAll = false): void {
  const clean = value.trim();
  // eslint-disable-next-line no-control-regex -- control bytes are deliberately rejected at the patch boundary
  if (!clean || clean.length > 500 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new StorefrontPatchError("patch_text_invalid", "Edited text must be 1 to 500 safe characters");
  }
  const current = textValue(target);
  const actualPrecondition = replaceAll ? digest(target) : current;
  if (expected !== undefined && actualPrecondition !== expected) {
    throw new StorefrontPatchError("patch_precondition_failed", `Text ${target.id} changed before this edit`);
  }
  if (replaceAll) target.children = [{ kind: "text", value: clean }];
  else {
    const index = target.children.findIndex((child) => child.kind === "text");
    if (index >= 0) target.children[index] = { kind: "text", value: clean };
    else target.children.unshift({ kind: "text", value: clean });
  }
  rewriteDebugHtml(route);
}

function hiddenClass(routeId: StorefrontRouteId): string {
  return `storefront-edit-hidden-${routeId}`;
}

function setVisibility(route: EditableArtifact, routeId: StorefrontRouteId, target: CompiledElementNode, hidden: boolean, expected?: string): void {
  if (expected !== undefined && digest(target) !== expected) {
    throw new StorefrontPatchError("patch_precondition_failed", `Region ${target.id} changed before this edit`);
  }
  const className = hiddenClass(routeId);
  const classes = new Set((target.attributes.class ?? "").split(/\s+/).filter(Boolean));
  if (hidden) classes.add(className);
  else classes.delete(className);
  if (classes.size) target.attributes.class = [...classes].join(" ");
  else delete target.attributes.class;
  const namespace = routeId === "checkout" ? "checkout" : routeId;
  const rule = `[data-cd-bundle="${namespace}"] .${className}{display:none}`;
  if (hidden && !route.css.includes(rule)) route.css += rule;
  rewriteDebugHtml(route);
}

function reorder(route: EditableArtifact, parent: CompiledElementNode, childIds: string[], expected?: string[]): void {
  if (new Set(childIds).size !== childIds.length || childIds.some((id) => !isCompilerIdentifier(id))) {
    throw new StorefrontPatchError("patch_reorder_invalid", "Reorder IDs must be unique compiler-issued IDs");
  }
  const elementChildren = parent.children.filter((child): child is CompiledElementNode => child.kind === "element");
  if (elementChildren.length !== parent.children.length) {
    throw new StorefrontPatchError("patch_reorder_invalid", "Only region containers with element children can be reordered");
  }
  const current = elementChildren.map((child) => child.id);
  if (expected && JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new StorefrontPatchError("patch_precondition_failed", `Region ${parent.id} changed before this edit`);
  }
  if (childIds.length !== current.length || childIds.some((id) => !current.includes(id))) {
    throw new StorefrontPatchError("patch_reorder_invalid", "Reorder must contain every existing child exactly once");
  }
  const byId = new Map(elementChildren.map((child) => [child.id, child]));
  parent.children = childIds.map((id) => byId.get(id)!);
  rewriteDebugHtml(route);
}

export interface AppliedStorefrontPatch {
  bundle: StorefrontBundleV1;
  changedRoutes: StorefrontRouteId[];
  changedScope: StorefrontChangedScope;
  structural: boolean;
}

const SEMANTIC_TOKEN_PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  accent: ["accent", "signal", "acid", "cobalt", "orange", "blue", "green", "sun", "plum", "moss", "forest", "primary", "ink"],
  background: ["background", "paper", "milk", "cream", "fog", "black", "panel"],
};

function resolveTokenId(bundle: StorefrontBundleV1, requested: string): string {
  if (Object.hasOwn(bundle.designSystem.tokens, requested)) return requested;
  const preferred = SEMANTIC_TOKEN_PREFERENCES[requested];
  if (!preferred) return requested;
  const named = preferred.find((tokenId) => Object.hasOwn(bundle.designSystem.tokens, tokenId));
  if (named) return named;
  return Object.keys(bundle.designSystem.tokens).find((tokenId) => /^#[0-9a-f]{6}$/i.test(bundle.designSystem.tokens[tokenId]!)) ?? requested;
}

/** Apply a closed typed patch to a clone. No selectors, arbitrary paths, or executable code are accepted. */
export function applyStorefrontPatch(
  input: StorefrontBundleV1,
  operations: readonly StorefrontPatchOperation[],
): AppliedStorefrontPatch {
  if (!operations.length || operations.length > 32) throw new StorefrontPatchError("patch_operations_invalid", "A patch needs 1 to 32 operations");
  const bundle = structuredClone(input);
  const routes = new Set<StorefrontRouteId>();
  const tokens = new Set<string>();
  const regions = new Set<string>();
  const css = new Set<StorefrontRouteId>();
  const interactionRoutes = new Set<StorefrontRouteId>();
  const referencedAssets = new Set<string>();
  const compilerIds = new Set<string>();
  let structural = false;

  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw new StorefrontPatchError("patch_operation_invalid", "Patch operation is malformed");
    switch (operation.kind) {
      case "setToken": {
        if (!isCompilerIdentifier(operation.tokenId)) throw new StorefrontPatchError("patch_token_invalid", "Token ID is invalid");
        const tokenId = resolveTokenId(bundle, operation.tokenId);
        const current = bundle.designSystem.tokens[tokenId];
        if (operation.expected !== undefined && current !== operation.expected) {
          throw new StorefrontPatchError("patch_precondition_failed", `Token ${tokenId} changed before this edit`);
        }
        try { assertSafeDesignTokenValue(tokenId, operation.value); }
        catch (error) { throw new StorefrontPatchError("patch_token_invalid", error instanceof Error ? error.message : "Token value is invalid"); }
        bundle.designSystem.tokens[tokenId] = operation.value;
        tokens.add(tokenId);
        break;
      }
      case "setFont": {
        if (!isCuratedFontId(operation.fontId)) throw new StorefrontPatchError("patch_font_invalid", "Font is not in the curated self-hosted set");
        const key = operation.target === "display" ? "displayFontId" : operation.target === "body" ? "bodyFontId" : null;
        if (!key) throw new StorefrontPatchError("patch_font_invalid", "Font target is invalid");
        if (operation.expected !== undefined && bundle.designSystem[key] !== operation.expected) {
          throw new StorefrontPatchError("patch_precondition_failed", `${operation.target} font changed before this edit`);
        }
        bundle.designSystem[key] = operation.fontId;
        tokens.add(`${operation.target}Font`);
        break;
      }
      case "setText":
      case "replaceTextChildren": {
        const route = artifact(bundle, operation.routeId);
        setText(route, assertTarget(route, operation.targetId), operation.value, operation.expected, operation.kind === "replaceTextChildren");
        routes.add(operation.routeId);
        structural ||= operation.kind === "replaceTextChildren";
        break;
      }
      case "setVisibility": {
        const route = artifact(bundle, operation.routeId);
        setVisibility(route, operation.routeId, assertTarget(route, operation.targetId), operation.hidden, operation.expected);
        routes.add(operation.routeId);
        break;
      }
      case "moveRegion": {
        const route = artifact(bundle, operation.routeId);
        assertTarget(route, operation.targetId);
        const parent = findParent(route.tree, operation.targetId);
        if (!parent || parent.children.some((child) => child.kind !== "element")) {
          throw new StorefrontPatchError("patch_reorder_invalid", "The selected region is not in a reorderable container");
        }
        const current = parent.children as CompiledElementNode[];
        const index = current.findIndex((child) => child.id === operation.targetId);
        const next = operation.direction === "up" ? index - 1 : index + 1;
        if (next < 0 || next >= current.length) throw new StorefrontPatchError("patch_reorder_invalid", "The selected region cannot move farther in that direction");
        [current[index], current[next]] = [current[next]!, current[index]!];
        rewriteDebugHtml(route);
        routes.add(operation.routeId);
        break;
      }
      case "reorderChildren": {
        const route = artifact(bundle, operation.routeId);
        reorder(route, assertTarget(route, operation.parentId), operation.childIds, operation.expected);
        routes.add(operation.routeId);
        break;
      }
      case "replaceRegion": {
        const replacement = replaceRegion(bundle, operation);
        routes.add(operation.routeId);
        regions.add(`${operation.routeId}:${operation.targetId}`);
        replacement.compilerIds.forEach((id) => compilerIds.add(id));
        replacement.assetKeys.forEach((key) => referencedAssets.add(key));
        if (replacement.interactionChanged) interactionRoutes.add(operation.routeId);
        structural = true;
        break;
      }
      case "replaceRouteCss": {
        replaceRouteCss(bundle, operation);
        routes.add(operation.routeId);
        css.add(operation.routeId);
        structural = true;
        break;
      }
      default:
        throw new StorefrontPatchError("patch_operation_invalid", "Patch operation kind is not allowed");
    }
  }
  return {
    bundle,
    changedRoutes: [...routes].sort(),
    changedScope: {
      designTokens: [...tokens].sort(),
      routes: [...routes].sort(),
      ...(regions.size ? { regions: [...regions].sort() } : {}),
      ...(css.size ? { css: [...css].sort() } : {}),
      ...(interactionRoutes.size ? { interactions: [...interactionRoutes].sort() } : {}),
      ...(referencedAssets.size ? { assets: [...referencedAssets].sort() } : {}),
      ...(compilerIds.size ? { compilerIds: [...compilerIds].sort() } : {}),
    },
    structural,
  };
}
