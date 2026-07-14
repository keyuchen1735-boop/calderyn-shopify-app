import { assertSafeDesignTokenValue } from "../storefront-compiler/css";
import { isCompilerIdentifier } from "../storefront-compiler/assets";
import { serializeCompiledTree } from "../storefront-compiler/html";
import {
  isCuratedFontId,
  type CompiledElementNode,
  type CompiledNode,
  type RouteArtifact,
  type StorefrontBundleV1,
  type StorefrontRouteId,
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

function setText(route: EditableArtifact, target: CompiledElementNode, value: string, expected?: string, replaceAll = false): void {
  const clean = value.trim();
  // eslint-disable-next-line no-control-regex -- control bytes are deliberately rejected at the patch boundary
  if (!clean || clean.length > 500 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new StorefrontPatchError("patch_text_invalid", "Edited text must be 1 to 500 safe characters");
  }
  const current = textValue(target);
  if (expected !== undefined && current !== expected) {
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

function setVisibility(route: EditableArtifact, routeId: StorefrontRouteId, target: CompiledElementNode, hidden: boolean): void {
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
        setVisibility(route, operation.routeId, assertTarget(route, operation.targetId), operation.hidden);
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
      default:
        throw new StorefrontPatchError("patch_operation_invalid", "Patch operation kind is not allowed");
    }
  }
  return {
    bundle,
    changedRoutes: [...routes].sort(),
    changedScope: { designTokens: [...tokens].sort(), routes: [...routes].sort() },
    structural,
  };
}
