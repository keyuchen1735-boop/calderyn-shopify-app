import { createHash } from "node:crypto";
import type { CompiledNode, RouteArtifact, StorefrontBundleV1 } from "../storefront-bundle/types";
import type { NoveltySignature } from "./contracts";

type StructuralRoute = Pick<RouteArtifact, "tree" | "css" | "interactions" | "trustedSlots">;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nodeShape(node: CompiledNode): unknown {
  if (node.kind === "text") return "text";
  return {
    tag: node.tag,
    repeat: node.repeat?.source ?? null,
    route: node.routeTarget?.routeId ?? null,
    slot: node.trustedSlotId ?? null,
    children: node.children.map(nodeShape),
  };
}

function cssVocabulary(css: string): string[] {
  return [...new Set([...css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/g)].map((match) => match[1]))].sort();
}

function positionVocabulary(css: string): string[] {
  return [...css.matchAll(/\b(position\s*:\s*(?:sticky|fixed)|scroll-snap-[a-z-]+\s*:[^;}]+)/g)]
    .map((match) => match[1].replace(/\s+/g, " ").trim())
    .sort();
}

function structuralSignature(input: {
  displayFontId: string;
  bodyFontId: string;
  tokenKeys: string[];
  globalCss: string;
  shell: StructuralRoute;
  home: StructuralRoute;
}): NoveltySignature {
  const routes = [input.shell, input.home];
  const roots = routes.flatMap((route) => route.tree);
  const routeTargets: string[] = [];
  const walk = (nodes: readonly CompiledNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text") continue;
      if (node.routeTarget) routeTargets.push(node.routeTarget.routeId);
      walk(node.children);
    }
  };
  walk(roots);
  const interactions = routes.flatMap((route) => route.interactions.transitions.map((transition) => ({
    on: transition.on,
    type: transition.action.type,
  })));
  const states = routes.flatMap((route) => route.interactions.state.map((state) => state.type));
  const slots = routes.flatMap((route) => route.trustedSlots.map((slot) => slot.kind));
  const css = `${input.globalCss}\n${routes.map((route) => route.css).join("\n")}`;
  return {
    layoutTopology: digest(roots.map(nodeShape)),
    typeTreatment: digest([input.displayFontId, input.bodyFontId, input.tokenKeys.slice().sort(), cssVocabulary(css)]),
    sectionSequence: digest(roots.map((root) => root.kind === "element" ? root.children.map(nodeShape) : nodeShape(root))),
    navigationModel: digest([routeTargets.sort(), positionVocabulary(css)]),
    interactionStyle: digest([interactions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), states.sort(), slots.sort()]),
  };
}

export function structuralSignatureFromConcept(input: {
  displayFontId: string;
  bodyFontId: string;
  tokens: Record<string, string>;
  globalCss: string;
  shell: StructuralRoute;
  home: StructuralRoute;
}): NoveltySignature {
  return structuralSignature({ ...input, tokenKeys: Object.keys(input.tokens) });
}

export function structuralSignatureFromBundle(bundle: StorefrontBundleV1): NoveltySignature {
  return structuralSignature({
    displayFontId: bundle.designSystem.displayFontId,
    bodyFontId: bundle.designSystem.bodyFontId,
    tokenKeys: Object.keys(bundle.designSystem.tokens),
    globalCss: bundle.designSystem.globalCss,
    shell: bundle.shell,
    home: bundle.routes.home,
  });
}
