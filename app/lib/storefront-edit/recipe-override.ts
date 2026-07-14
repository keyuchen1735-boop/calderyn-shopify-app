import { getStoreTemplate } from "../storefront-bundle/registry";
import type { CompiledElementNode, CompiledNode, StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import type { StorefrontPatchOperation } from "./types";

function semanticKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findElement(nodes: readonly CompiledNode[], targetId: string): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.id === targetId) return node;
    const nested = findElement(node.children, targetId);
    if (nested) return nested;
  }
  return null;
}

function routeTree(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): readonly CompiledNode[] {
  return routeId === "checkout" ? bundle.routes.checkout.decorativeTree : bundle.routes[routeId].tree;
}

function targetMatches(bundle: StorefrontBundleV1, routeId: StorefrontRouteId, targetId: string, allowed: readonly string[], textRole = false): boolean {
  const node = findElement(routeTree(bundle, routeId), targetId);
  if (!node) return false;
  const candidates = [node.id, ...(node.attributes.class ?? "").split(/\s+/)].map(semanticKey);
  return allowed.some((name) => {
    const semantic = semanticKey(name);
    if (semantic.length <= 2) return false;
    if (candidates.some((candidate) => candidate.endsWith(semantic))) return true;
    if (!textRole) return false;
    if (semantic === "herotitle") return routeId === "home" && node.tag === "h1";
    if (semantic === "heroeyebrow") return routeId === "home" && node.tag === "small";
    if (semantic === "herobody") return routeId === "home" && node.tag === "p";
    if (semantic === "sectionheading") return node.tag === "h2" || node.tag === "h3";
    if (semantic === "ctalabel") return node.tag === "a" || node.tag === "button";
    return false;
  });
}

function tokenCategory(tokenId: string, current: string | undefined, next: string): "color" | "spacing" | "radius" | "motion" | null {
  const name = tokenId.toLowerCase();
  if (/color|ink|paper|cream|milk|fog|black|white|accent|signal|acid|cobalt|orange|blue|green|sun|plum|moss|forest|panel|surface/.test(name) ||
      /^#|^rgb|^hsl/.test(current ?? "") || /^#|^rgb|^hsl/.test(next)) return "color";
  if (/space|gap|rhythm|gutter|padding|margin/.test(name)) return "spacing";
  if (/radius|round/.test(name)) return "radius";
  if (/motion|duration|ease|speed/.test(name)) return "motion";
  return null;
}

/** True only when every operation maps to the recipe's declared semantic override surface. */
export function patchFitsRecipeOverride(bundle: StorefrontBundleV1, operations: readonly StorefrontPatchOperation[]): boolean {
  if (bundle.source.kind !== "recipe") return false;
  const surface = getStoreTemplate(bundle.source.templateId).overrideSurface;
  return operations.every((operation) => {
    switch (operation.kind) {
      case "setToken": {
        const category = tokenCategory(operation.tokenId, bundle.designSystem.tokens[operation.tokenId], operation.value);
        return category !== null && surface.designTokens.some((allowed) => semanticKey(allowed) === category);
      }
      case "setFont":
        return surface.designTokens.some((allowed) => semanticKey(allowed) === "typography");
      case "setText":
      case "replaceTextChildren":
        return targetMatches(bundle, operation.routeId, operation.targetId, surface.textSlots, true);
      case "setVisibility":
        return targetMatches(bundle, operation.routeId, operation.targetId, surface.optionalRegions);
      case "moveRegion":
        return targetMatches(bundle, operation.routeId, operation.targetId, surface.reorderableRegions);
      case "reorderChildren":
        return operation.childIds.length > 0 && operation.childIds.every((id) =>
          targetMatches(bundle, operation.routeId, id, surface.reorderableRegions));
      case "replaceRegion":
      case "replaceRouteCss":
        return false;
    }
    return false;
  });
}
