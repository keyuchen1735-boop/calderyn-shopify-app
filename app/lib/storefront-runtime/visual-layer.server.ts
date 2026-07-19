import { getStoreTemplate, isStoreTemplateId } from "~/lib/storefront-bundle/registry";
import type { CompiledNode, StorefrontBundleV1, StorefrontRouteId } from "~/lib/storefront-bundle/types";
import { isVisualLayerSpec } from "~/lib/storebuilder/fx/shader";

export interface StorefrontVisualPlacement {
  hostNodeId: string;
  fallbackNodeId: string;
}

export function resolveStorefrontVisualPlacement(
  bundle: StorefrontBundleV1,
  routeId: StorefrontRouteId,
): StorefrontVisualPlacement | null {
  if (!isVisualLayerSpec(bundle.visualLayer) || bundle.visualLayer.kind !== "fragment_shader") return null;
  const source = bundle.source;
  if (source.kind !== "recipe" || !isStoreTemplateId(source.templateId)) return null;
  const version = getStoreTemplate(source.templateId).versions.find(
    (candidate) => candidate.templateVersion === source.templateVersion,
  );
  if (!version) return null;

  const routeTree = routeId === "checkout" ? bundle.routes.checkout.decorativeTree : bundle.routes[routeId].tree;
  const matches: Array<StorefrontVisualPlacement & { repeated: boolean }> = [];
  const visit = (node: CompiledNode, parentId?: string, insideRepeat = false): void => {
    if (node.kind !== "element") return;
    const repeated = insideRepeat || Boolean(node.repeat);
    if (node.attributes["data-cd-asset-key"] === version.visualLayer.fallbackAssetKey && parentId) {
      matches.push({ hostNodeId: parentId, fallbackNodeId: node.id, repeated });
    }
    node.children.forEach((child) => visit(child, node.id, repeated));
  };
  [...bundle.shell.tree, ...routeTree].forEach((node) => visit(node));
  const match = matches.find(({ repeated }) => !repeated) ?? null;
  return match ? { hostNodeId: match.hostNodeId, fallbackNodeId: match.fallbackNodeId } : null;
}
