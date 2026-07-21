import { serializeCompiledTree } from "../storefront-compiler/html";
import type {
  CompiledElementNode,
  CompiledNode,
  StorefrontBundleV1,
  StorefrontRecipeBlueprintId,
  StorefrontRouteId,
  VersionedStoreTemplate,
  VisualLayerSpec,
} from "../storefront-bundle/types";
import { hexToRgb, shaderSourceWithinCap } from "../storebuilder/fx/shader";
import { patchFitsRecipeOverride } from "../storefront-edit/recipe-override";
import type { StorefrontPatchOperation } from "../storefront-edit/types";
import type { StoreIntent } from "./types";

const ROUTE_IDS = ["home", "collection", "product", "search", "cart", "checkout"] as const;
const OPTIONAL_ROUTE_IDS = ["collections", "story", "notFound"] as const;
const ALLOWED_ROUTE_IDS: ReadonlySet<string> = new Set([...ROUTE_IDS, ...OPTIONAL_ROUTE_IDS]);
const PRODUCT_ID_CAP = 12;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/; // eslint-disable-line no-control-regex
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export class StorefrontTemplateIntegrityError extends Error {
  readonly code = "storefront_template_integrity_failed";

  constructor() {
    super("The requested change did not preserve the current design.");
    this.name = "StorefrontTemplateIntegrityError";
  }
}

interface TextTarget {
  blueprintId: StorefrontRecipeBlueprintId;
  id: string;
}

function fail(): never {
  throw new StorefrontTemplateIntegrityError();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  const object = record(value);
  return object !== null && Object.keys(object).length === keys.length
    && Object.keys(object).every((key) => keys.includes(key));
}

function semanticKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tree(bundle: StorefrontBundleV1, blueprintId: StorefrontRecipeBlueprintId): CompiledNode[] {
  if (blueprintId === "shell") return bundle.shell.tree;
  return blueprintId === "checkout"
    ? bundle.routes.checkout.decorativeTree
    : bundle.routes[blueprintId].tree;
}

function findElement(nodes: readonly CompiledNode[], id: string): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.id === id) return node;
    const nested = findElement(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function names(node: CompiledElementNode): string[] {
  return [node.id, ...(node.attributes.class ?? "").split(/\s+/)].filter(Boolean).map(semanticKey);
}

function hasLiveTextBinding(node: CompiledElementNode): boolean {
  if (node.attributes["data-cd-text"] !== undefined || node.attributes["data-cd-money"] !== undefined) return true;
  return node.children.some((child) => child.kind === "element" && hasLiveTextBinding(child));
}

function textTargets(bundle: StorefrontBundleV1, slot: string): TextTarget[] {
  const wanted = semanticKey(slot);
  const exact: TextTarget[] = [];
  const roles: TextTarget[] = [];
  const homeFallbacks: TextTarget[] = [];
  const visit = (blueprintId: StorefrontRecipeBlueprintId, nodes: readonly CompiledNode[], insideHero: boolean): void => {
    for (const node of nodes) {
      if (node.kind !== "element") continue;
      const nodeNames = names(node);
      const inHero = insideHero || nodeNames.some((name) => name.includes("hero"));
      const target = { blueprintId, id: node.id };
      const editable = slotTextNodes(node).length > 0 && !hasLiveTextBinding(node);
      if (editable && nodeNames.some((name) => name.endsWith(wanted))) exact.push(target);
      if (editable && blueprintId === "home") {
        if (wanted === "herotitle" && inHero && node.tag === "h1") roles.push(target);
        else if (wanted === "heroeyebrow" && inHero && node.tag === "small") roles.push(target);
        else if (wanted === "herobody" && inHero && node.tag === "p") roles.push(target);
        else if (wanted === "ctalabel" && inHero && (node.tag === "a" || node.tag === "button")) roles.push(target);
        else if (wanted === "sectionheading" && !inHero && (node.tag === "h2" || node.tag === "h3")) roles.push(target);
        if ((wanted === "herotitle" && node.tag === "h1")
          || (wanted === "heroeyebrow" && node.tag === "small")
          || (wanted === "herobody" && node.tag === "p")
          || (wanted === "ctalabel" && node.tag === "a")) homeFallbacks.push(target);
      }
      visit(blueprintId, node.children, inHero);
    }
  };
  visit("shell", tree(bundle, "shell"), false);
  visit("home", tree(bundle, "home"), false);
  return exact.length ? exact : (roles.length ? roles : homeFallbacks);
}

function slotTextNodes(
  element: CompiledElementNode,
  includeNestedWithDirect = false,
): Array<Extract<CompiledNode, { kind: "text" }>> {
  const direct = element.children.filter((child): child is Extract<CompiledNode, { kind: "text" }> => child.kind === "text");
  if (direct.length && !includeNestedWithDirect) return direct;
  const textNodes: Array<Extract<CompiledNode, { kind: "text" }>> = [];
  const visit = (nodes: readonly CompiledNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "text") textNodes.push(node);
      else visit(node.children);
    }
  };
  visit(element.children);
  return textNodes;
}

function replaceSlotText(element: CompiledElementNode, value: string, includeNestedWithDirect = false): void {
  const nodes = slotTextNodes(element, includeNestedWithDirect);
  if (!nodes.length) fail();
  if (nodes.length === 1) {
    nodes[0]!.value = value;
    return;
  }
  const words = value.split(/\s+/);
  let offset = 0;
  nodes.forEach((node, index) => {
    const remainingNodes = nodes.length - index;
    const take = Math.ceil((words.length - offset) / remainingNodes);
    node.value = words.slice(offset, offset + take).join(" ");
    offset += take;
  });
}

function validProductIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRODUCT_ID_CAP
    || !value.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 128)) return false;
  return new Set(value.map((id) => id.trim())).size === value.length;
}

function validVisualLayer(value: unknown): value is VisualLayerSpec {
  const layer = record(value);
  if (!layer || typeof layer.kind !== "string") return false;
  if (layer.kind === "none") return hasExactKeys(layer, ["kind"]);
  return layer.kind === "fragment_shader" && hasExactKeys(layer, ["kind", "source", "colors"])
    && typeof layer.source === "string" && layer.source.trim().length > 0 && shaderSourceWithinCap(layer.source)
    && Array.isArray(layer.colors) && layer.colors.length === 3
    && layer.colors.every((color) => typeof color === "string" && HEX_COLOR.test(color) && hexToRgb(color) !== null);
}

function heroReferences(bundle: StorefrontBundleV1, key: string): string[] {
  const references: string[] = [];
  const visit = (routeId: StorefrontRouteId, nodes: readonly CompiledNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== "element") continue;
      if (node.attributes["data-cd-asset-key"] === key
        || node.attributes["data-cd-poster-asset-key"] === key) references.push(`${routeId}:${node.id}:${key}`);
      visit(routeId, node.children);
    }
  };
  for (const routeId of ROUTE_IDS) visit(routeId, tree(bundle, routeId));
  return references.sort();
}

function versionFor(bundle: StorefrontBundleV1, template: VersionedStoreTemplate) {
  if (bundle.source.kind !== "recipe" || bundle.source.templateId !== template.id) fail();
  const templateVersion = bundle.source.templateVersion;
  const version = template.versions.find((candidate) => candidate.templateVersion === templateVersion);
  if (!version) fail();
  return version;
}

function assertBundleContract(bundle: StorefrontBundleV1, template: VersionedStoreTemplate): void {
  const routeIds = Object.keys(bundle.routes);
  if (ROUTE_IDS.some((routeId) => !routeIds.includes(routeId))
    || routeIds.some((routeId) => !ALLOWED_ROUTE_IDS.has(routeId))) fail();
  const version = versionFor(bundle, template);
  if (!bundle.assets.entries.some(({ key }) => key === version.visualLayer.fallbackAssetKey)
    || heroReferences(bundle, version.visualLayer.fallbackAssetKey).length === 0
    || (bundle.featuredProductIds !== undefined && !validProductIds(bundle.featuredProductIds))
    || (bundle.visualLayer !== undefined && !validVisualLayer(bundle.visualLayer))) fail();
}

function rewriteHtml(bundle: StorefrontBundleV1, blueprintId: StorefrontRecipeBlueprintId): void {
  if (blueprintId === "shell") bundle.shell.html = serializeCompiledTree(bundle.shell.tree);
  else if (blueprintId === "checkout") bundle.routes.checkout.decorativeHtml = serializeCompiledTree(bundle.routes.checkout.decorativeTree);
  else bundle.routes[blueprintId].html = serializeCompiledTree(bundle.routes[blueprintId].tree);
}

function normalized(bundle: StorefrontBundleV1, intent: StoreIntent, target?: TextTarget): string {
  const copy = structuredClone(bundle);
  if (intent.kind === "update_text" && target) {
    const element = findElement(tree(copy, target.blueprintId), target.id) ?? fail();
    const nodes = slotTextNodes(element, intent.slot === "heroTitle");
    if (!nodes.length) fail();
    nodes.forEach((node, index) => { node.value = `__slot_text_${index}__`; });
    rewriteHtml(copy, target.blueprintId);
  } else if (intent.kind === "update_merchandising") {
    copy.featuredProductIds = [];
  } else if (intent.kind === "update_visual_layer") {
    copy.visualLayer = { kind: "none" };
  }
  return JSON.stringify(copy);
}

export function canApplyStoreTextSlot(
  bundle: StorefrontBundleV1,
  template: VersionedStoreTemplate,
  slot: string,
  expectedRouteId?: StorefrontRouteId,
): boolean {
  try {
    assertBundleContract(bundle, template);
    if (!template.overrideSurface.textSlots.includes(slot)) return false;
    const targets = textTargets(bundle, slot);
    if (targets.length !== 1) return false;
    const target = targets[0]!;
    if (expectedRouteId !== undefined && target.blueprintId !== expectedRouteId) return false;
    return target.blueprintId === "shell" || patchFitsRecipeOverride(bundle, [{
      kind: "setText",
      routeId: target.blueprintId,
      targetId: target.id,
      value: "validated",
    }]);
  } catch {
    return false;
  }
}

export function readStoreTextSlot(
  bundle: StorefrontBundleV1,
  template: VersionedStoreTemplate,
  slot: string,
): string | null {
  try {
    assertBundleContract(bundle, template);
    if (!template.overrideSurface.textSlots.includes(slot)) return null;
    const targets = textTargets(bundle, slot);
    if (targets.length !== 1) return null;
    const target = targets[0]!;
    const element = findElement(tree(bundle, target.blueprintId), target.id);
    const value = element ? slotTextNodes(element, slot === "heroTitle").map(({ value: text }) => text).join(" ").trim() : "";
    return value || null;
  } catch {
    return null;
  }
}

function assertPreserved(
  before: StorefrontBundleV1,
  after: StorefrontBundleV1,
  template: VersionedStoreTemplate,
  intent: StoreIntent,
  target?: TextTarget,
): void {
  assertBundleContract(after, template);
  const version = versionFor(before, template);
  if (JSON.stringify(Object.keys(after.routes)) !== JSON.stringify(Object.keys(before.routes))
    || JSON.stringify(after.assets) !== JSON.stringify(before.assets)
    || JSON.stringify(heroReferences(after, version.visualLayer.fallbackAssetKey))
      !== JSON.stringify(heroReferences(before, version.visualLayer.fallbackAssetKey))
    || normalized(after, intent, target) !== normalized(before, intent, target)) fail();
}

function applyText(
  bundle: StorefrontBundleV1,
  template: VersionedStoreTemplate,
  intent: Extract<StoreIntent, { kind: "update_text" }>,
): { bundle: StorefrontBundleV1 } {
  if (!hasExactKeys(intent, ["kind", "slot", "value"]) || !template.overrideSurface.textSlots.includes(intent.slot)
    || !intent.value.trim() || Array.from(intent.value).length > 500
    || /[<>]/.test(intent.value) || CONTROL_CHARACTERS.test(intent.value)) fail();
  const targets = textTargets(bundle, intent.slot);
  if (targets.length !== 1) fail();
  const target = targets[0]!;
  if (target.blueprintId !== "shell") {
    const operation: StorefrontPatchOperation = {
      kind: "setText", routeId: target.blueprintId, targetId: target.id, value: intent.value.trim(),
    };
    if (!patchFitsRecipeOverride(bundle, [operation])) fail();
  }
  const result = structuredClone(bundle);
  const element = findElement(tree(result, target.blueprintId), target.id) ?? fail();
  replaceSlotText(element, intent.value.trim(), intent.slot === "heroTitle");
  rewriteHtml(result, target.blueprintId);
  assertPreserved(bundle, result, template, intent, target);
  return { bundle: result };
}

export function applyStoreIntent(
  bundle: StorefrontBundleV1,
  template: VersionedStoreTemplate,
  intent: StoreIntent,
): { bundle: StorefrontBundleV1 } {
  assertBundleContract(bundle, template);
  if (intent.kind === "update_text") return applyText(bundle, template, intent);
  if (intent.kind === "update_merchandising") {
    if (!hasExactKeys(intent, ["kind", "productIds"]) || !validProductIds(intent.productIds)) fail();
    const result = structuredClone(bundle);
    result.featuredProductIds = intent.productIds.map((id) => id.trim());
    assertPreserved(bundle, result, template, intent);
    return { bundle: result };
  }
  if (intent.kind === "update_visual_layer") {
    if (!hasExactKeys(intent, ["kind", "visualLayer"]) || !validVisualLayer(intent.visualLayer)) fail();
    const result = structuredClone(bundle);
    result.visualLayer = structuredClone(intent.visualLayer);
    assertPreserved(bundle, result, template, intent);
    return { bundle: result };
  }
  throw new Error("Store intent must be routed before application");
}
