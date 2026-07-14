import { createHash } from "node:crypto";
import type { CompiledNode, StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import type { PreviewEditContext } from "./types";

export const STOREFRONT_PATCH_SYSTEM_PROMPT = `You are a storefront patch compiler. Return typed patch operations only. Never return JavaScript, external URLs, customer data, storage keys, or a full storefront. Structural HTML and CSS are compiler source, not executable code. Use only compiler-issued IDs and verified owned asset logical keys in the provided scope. Include exact supplied SHA-256 preconditions. Preserve every unnamed route and region.`;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function storefrontPatchPrompt(input: {
  prompt: string;
  context?: PreviewEditContext;
  bundle: StorefrontBundleV1;
  repair?: {
    attempt: 1;
    staticDiagnostics?: Array<{ code: string; path: string; message: string }>;
    browserProof?: { ok: boolean; diagnostics: Array<{ routeId: StorefrontRouteId; regionId?: string; code: string; message: string }> };
  };
}): string {
  const route = input.context?.routeId ?? "unspecified";
  const region = input.context?.regionId ?? "unspecified";
  const routeIds: StorefrontRouteId[] = ["home", "collection", "product", "search", "cart", "checkout"];
  const ids = routeIds.map((routeId) => {
    const tree: CompiledNode[] = routeId === "checkout"
      ? input.bundle.routes.checkout.decorativeTree
      : input.bundle.routes[routeId].tree;
    const collect = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) =>
      node.kind === "element" ? [`${node.id} ${digest(node)}`, ...collect(node.children)] : []);
    const css = routeId === "checkout" ? input.bundle.routes.checkout.decorativeCss : input.bundle.routes[routeId].css;
    return `${routeId} (css ${digest(css)}): ${collect(tree).slice(0, 200).join(", ")}`;
  });
  const selectedTree = input.context
    ? (() => {
        const tree = input.context.routeId === "checkout"
          ? input.bundle.routes.checkout.decorativeTree
          : input.bundle.routes[input.context.routeId].tree;
        const find = (nodes: readonly CompiledNode[]): CompiledNode | null => {
          for (const node of nodes) {
            if (node.kind !== "element") continue;
            if (node.id === input.context!.regionId) return node;
            const nested = find(node.children);
            if (nested) return nested;
          }
          return null;
        };
        const node = find(tree);
        return node ? `${digest(node)} ${JSON.stringify(node).slice(0, 12_000)}` : "missing";
      })()
    : "unspecified";
  return [
    `Merchant instruction: ${JSON.stringify(input.prompt)}`,
    `Allowed route: ${route}`,
    `Allowed region ID: ${region}`,
    `Selected region precondition and compiled shape: ${selectedTree}`,
    `Current source kind: ${input.bundle.source.kind}`,
    `Verified owned asset keys: ${input.bundle.assets.entries.map((entry) => entry.key).sort().join(", ") || "none"}`,
    `Compiler-issued element IDs and exact subtree preconditions:\n${ids.join("\n")}`,
    ...(input.repair ? [
      `Targeted repair attempt: ${input.repair.attempt} of 1`,
      `Static diagnostics: ${JSON.stringify(input.repair.staticDiagnostics ?? [])}`,
      `Browser diagnostics: ${JSON.stringify(input.repair.browserProof?.diagnostics ?? [])}`,
      "Repair only the diagnosed route/region. Return a complete replacement operation with the original base preconditions.",
    ] : []),
    "Return the smallest patch. For layout, imagery, icon, or interaction changes use replaceRegion with closed compiler-source HTML/CSS. For art direction across a route, pair it with replaceRouteCss using the exact route CSS precondition. Never invent an asset key.",
  ].join("\n");
}
