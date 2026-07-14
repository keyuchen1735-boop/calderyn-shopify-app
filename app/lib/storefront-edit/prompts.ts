import type { CompiledNode, StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import type { PreviewEditContext } from "./types";

export const STOREFRONT_PATCH_SYSTEM_PROMPT = `You are a storefront patch compiler. Return typed patch operations only. Never return JavaScript, selectors, URLs, customer data, or a full storefront. Modify only compiler-issued IDs in the provided scope.`;

export function storefrontPatchPrompt(input: {
  prompt: string;
  context?: PreviewEditContext;
  bundle: StorefrontBundleV1;
}): string {
  const route = input.context?.routeId ?? "unspecified";
  const region = input.context?.regionId ?? "unspecified";
  const routeIds: StorefrontRouteId[] = ["home", "collection", "product", "search", "cart", "checkout"];
  const ids = routeIds.map((routeId) => {
    const tree: CompiledNode[] = routeId === "checkout"
      ? input.bundle.routes.checkout.decorativeTree
      : input.bundle.routes[routeId].tree;
    const collect = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) =>
      node.kind === "element" ? [node.id, ...collect(node.children)] : []);
    return `${routeId}: ${collect(tree).slice(0, 200).join(", ")}`;
  });
  return [
    `Merchant instruction: ${JSON.stringify(input.prompt)}`,
    `Allowed route: ${route}`,
    `Allowed region ID: ${region}`,
    `Current source kind: ${input.bundle.source.kind}`,
    `Compiler-issued element IDs:\n${ids.join("\n")}`,
    "Return the smallest patch. Preserve every route and region not named above.",
  ].join("\n");
}
