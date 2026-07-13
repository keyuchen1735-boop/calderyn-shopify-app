import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type {
  CompiledBinding,
  CompiledElementNode,
  CompiledNode,
  CompiledRepeat,
  InteractionManifestV1,
  RouteTarget,
  TrustedSlotManifest,
} from "../storefront-bundle/types";
import {
  CompilerError,
  compileBinding,
  compileDataRef,
  compileRepeat,
  compileRouteTarget,
  scopeForRepeat,
  type BindingScope,
  type BindingScopeKind,
} from "./bindings";
import { assertInteractionCompatibility, compileState, compileStateBinding, compileTransition } from "./interactions";

export { CompilerError } from "./bindings";

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "button", "cite", "code",
  "dd", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "kbd", "li", "main", "mark", "nav", "ol",
  "p", "picture", "pre", "q", "s", "section", "small", "source", "span", "strong", "sub", "summary",
  "sup", "time", "u", "ul",
]);

export function isAllowedCompiledTag(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_TAGS.has(value);
}

const VOID_TAGS = new Set(["br", "hr", "img", "source"]);
const STATIC_ATTRIBUTES = new Set([
  "class", "title", "role", "tabindex", "alt", "width", "height", "loading", "decoding", "open", "href", "for",
]);
const IDREF_ATTRIBUTES = new Set(["aria-controls", "aria-labelledby", "aria-describedby", "aria-owns", "aria-activedescendant", "for"]);
const BINDING_ATTRIBUTES = new Map([
  ["data-cd-text", "text"],
  ["data-cd-money", "money"],
  ["data-cd-src", "src"],
  ["data-cd-alt", "alt"],
] as const);
const SOURCE_ATTRIBUTES = new Set([
  ...BINDING_ATTRIBUTES.keys(),
  "data-cd-repeat", "data-cd-key", "data-cd-route", "data-cd-param-handle", "data-cd-param-query",
  "data-cd-param-policy-id", "data-cd-on", "data-cd-action", "data-cd-target", "data-cd-state",
  "data-cd-value-field", "data-cd-facet", "data-cd-slot", "data-cd-product", "data-cd-host-size",
  "data-cd-theme-tokens", "data-cd-policy-links", "data-cd-asset", "data-cd-state-id", "data-cd-state-type",
  "data-cd-state-initial", "data-cd-state-values", "data-cd-state-min", "data-cd-state-max",
  "data-cd-bind-state", "data-cd-bind-property",
]);
const TRUSTED_SLOT_KINDS = new Set<TrustedSlotManifest["kind"]>([
  "variantPicker", "addToCart", "cartLineControls", "cartSummary", "cartDrawer", "quickViewCommerce",
]);
const HOST_SIZES = new Set<TrustedSlotManifest["hostSize"]>(["inline", "block", "panel", "page"]);

function isSafeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === "-" ||
      character === "_";
    if (!allowed) return false;
  }
  return true;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitAsciiWhitespace(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  for (const character of value) {
    const whitespace = character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
    if (whitespace) {
      if (token) tokens.push(token);
      token = "";
    } else token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function serializeCompiledTree(nodes: readonly CompiledNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return escapeText(node.value);
      const attributes = Object.entries({ id: node.id, ...node.attributes })
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join("");
      if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attributes}>`;
      return `<${node.tag}${attributes}>${serializeCompiledTree(node.children)}</${node.tag}>`;
    })
    .join("");
}

function attributesOf(node: DefaultTreeAdapterTypes.Element): Map<string, string> {
  return new Map(node.attrs.map((attribute) => [attribute.name, attribute.value]));
}

function isElement(node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node && "attrs" in node && "childNodes" in node;
}

function isTextNode(node: DefaultTreeAdapterTypes.ChildNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === "#text" && "value" in node;
}

function assertAllowedAttribute(name: string, value: string): void {
  if (name.startsWith("on")) {
    throw new CompilerError("html.event_handler", `Event-handler attribute ${JSON.stringify(name)} is forbidden`);
  }
  if (name === "style") {
    throw new CompilerError("html.inline_style", "Inline style attributes are forbidden");
  }
  if (name === "href" && value.startsWith("#") && isSafeIdentifier(value.slice(1))) return;
  if (name === "href" || name === "src" || name === "srcset" || name === "action" || name === "formaction") {
    throw new CompilerError("html.url_attribute", `Literal URL attribute ${JSON.stringify(name)} is forbidden`);
  }
  if (
    name === "id" ||
    STATIC_ATTRIBUTES.has(name) ||
    SOURCE_ATTRIBUTES.has(name) ||
    name.startsWith("aria-")
  ) {
    return;
  }
  throw new CompilerError("html.attribute", `Attribute ${JSON.stringify(name)} is not allowlisted`);
}

function walkElements(
  nodes: readonly DefaultTreeAdapterTypes.ChildNode[],
  visit: (node: DefaultTreeAdapterTypes.Element) => void,
): void {
  for (const node of nodes) {
    if (isTextNode(node)) continue;
    if (!isElement(node)) {
      throw new CompilerError("html.node", `Node ${node.nodeName} is forbidden`);
    }
    visit(node);
    walkElements(node.childNodes, visit);
  }
}

export interface CompileHtmlOptions {
  namespace: string;
  rootScopeKind?: BindingScopeKind;
  checkoutDecorative?: boolean;
}

export interface CompiledHtmlResult {
  html: string;
  tree: CompiledNode[];
  bindings: CompiledBinding[];
  repeats: CompiledRepeat[];
  routeTargets: RouteTarget[];
  interactions: InteractionManifestV1;
  trustedSlots: TrustedSlotManifest[];
  policyLinks: boolean;
  protectedCssNodes: ProtectedCssNode[];
  protectedSourceIds: string[];
}

export interface ProtectedCssNode {
  id: string;
  tag: string;
  classes: string[];
  attributes: Record<string, string>;
}

export function compileHtml(source: string, options: CompileHtmlOptions): CompiledHtmlResult {
  if (!isSafeIdentifier(options.namespace)) {
    throw new CompilerError("html.namespace", "Compiler namespace must be an ASCII identifier");
  }
  const parseErrors: string[] = [];
  const document = parse(source, { sourceCodeLocationInfo: true });
  const explicitDocumentNode = document.childNodes.find((node) => node.nodeName === "#documentType");
  const documentElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => node.nodeName === "html",
  );
  const explicitShell =
    explicitDocumentNode !== undefined ||
    documentElement?.sourceCodeLocation != null ||
    documentElement?.childNodes.some(
      (node) =>
        (node.nodeName === "head" || node.nodeName === "body") &&
        node.sourceCodeLocation != null,
    );
  if (explicitShell) {
    throw new CompilerError("html.document", "Document, html, head, body, and doctype source is forbidden");
  }
  const fragment = parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error.code),
  });
  if (parseErrors.length > 0) {
    throw new CompilerError("html.parse", `HTML parse failed: ${[...new Set(parseErrors)].sort().join(", ")}`);
  }

  const originalIds = new Map<string, string>();
  const slotNodeIds = new Map<DefaultTreeAdapterTypes.Element, string>();
  const protectedSourceIds = new Set<string>();
  let slotIdentityCounter = 0;
  const stateIds = new Map<string, string>();
  const stateSources: Array<ReturnType<typeof attributesOf>> = [];
  walkElements(fragment.childNodes, (node) => {
    if (!ALLOWED_TAGS.has(node.tagName)) {
      throw new CompilerError("html.tag", `Tag <${node.tagName}> is forbidden`);
    }
    if (options.checkoutDecorative && (node.tagName === "button" || node.tagName === "details" || node.tagName === "summary")) {
      throw new CompilerError("checkout.control", `Interactive checkout tag <${node.tagName}> is forbidden`);
    }
    for (const attribute of node.attrs) assertAllowedAttribute(attribute.name, attribute.value);
    const id = attributesOf(node).get("id");
    const slotKind = attributesOf(node).get("data-cd-slot");
    const slotId = slotKind === undefined ? undefined : `cd-${options.namespace}-slot-${++slotIdentityCounter}`;
    if (slotId) slotNodeIds.set(node, slotId);
    if (id !== undefined) {
      if (!isSafeIdentifier(id)) throw new CompilerError("html.id", `Invalid local ID ${JSON.stringify(id)}`);
      if (originalIds.has(id)) throw new CompilerError("html.duplicate_id", `Duplicate ID ${JSON.stringify(id)}`);
      originalIds.set(id, slotId ?? `cd-${options.namespace}-${id}`);
      if (slotId) protectedSourceIds.add(id);
    }
    const attributes = attributesOf(node);
    const stateId = attributes.get("data-cd-state-id");
    const stateType = attributes.get("data-cd-state-type");
    const stateInitial = attributes.get("data-cd-state-initial");
    const suppliedStateFields = [stateId, stateType, stateInitial].filter((value) => value !== undefined).length;
    if (suppliedStateFields > 0 && suppliedStateFields < 3) {
      throw new CompilerError("interaction.state_syntax", "State ID, type, and initial value must be supplied together");
    }
    if (stateId !== undefined) {
      if (!isSafeIdentifier(stateId)) throw new CompilerError("interaction.state_id", "State ID must be a local identifier");
      if (stateIds.has(stateId)) throw new CompilerError("interaction.state_duplicate", `Duplicate state ID ${stateId}`);
      stateIds.set(stateId, `cd-${options.namespace}-state-${stateId}`);
      stateSources.push(attributes);
    }
  });

  const bindings: CompiledBinding[] = [];
  const repeats: CompiledRepeat[] = [];
  const routeTargets: RouteTarget[] = [];
  const trustedSlots: TrustedSlotManifest[] = [];
  const interactions: InteractionManifestV1 = { version: 1, state: [], bindings: [], transitions: [] };
  for (const stateSource of stateSources) {
    const sourceId = stateSource.get("data-cd-state-id")!;
    interactions.state.push(
      compileState({
        id: stateIds.get(sourceId)!,
        type: stateSource.get("data-cd-state-type")!,
        initial: stateSource.get("data-cd-state-initial")!,
        allowedValues: stateSource.get("data-cd-state-values"),
        min: stateSource.get("data-cd-state-min"),
        max: stateSource.get("data-cd-state-max"),
      }),
    );
  }
  let nodeCounter = 0;
  let bindingCounter = 0;
  let repeatCounter = 0;
  let sawPolicyLinks = false;
  const rootScope: BindingScope = { id: "root", kind: options.rootScopeKind ?? "store" };

  const compileNodes = (
    nodes: readonly DefaultTreeAdapterTypes.ChildNode[],
    scope: BindingScope,
  ): CompiledNode[] => {
    const output: CompiledNode[] = [];
    for (const sourceNode of nodes) {
      if (isTextNode(sourceNode)) {
        if (sourceNode.value.length > 0) output.push({ kind: "text", value: sourceNode.value });
        continue;
      }
      if (!isElement(sourceNode)) continue;
      const sourceAttributes = attributesOf(sourceNode);
      const originalId = sourceAttributes.get("id");
      const id = slotNodeIds.get(sourceNode) ?? (originalId ? originalIds.get(originalId)! : `cd-${options.namespace}-n${++nodeCounter}`);
      const attributes: Record<string, string> = {};
      for (const [name, value] of [...sourceAttributes.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
        if (name === "id" || SOURCE_ATTRIBUTES.has(name)) continue;
        if (IDREF_ATTRIBUTES.has(name)) {
          const references = splitAsciiWhitespace(value);
          if (references.length === 0) throw new CompilerError("html.idref", `${name} requires a local ID`);
          attributes[name] = references
            .map((reference) => {
              const resolved = originalIds.get(reference);
              if (!resolved) throw new CompilerError("html.idref", `Unresolved ${name} reference ${JSON.stringify(reference)}`);
              return resolved;
            })
            .join(" ");
        } else if (name === "href") {
          const resolved = originalIds.get(value.slice(1));
          if (!resolved) throw new CompilerError("html.idref", `Unresolved fragment ${JSON.stringify(value)}`);
          attributes.href = `#${resolved}`;
        } else attributes[name] = value;
      }

      let childScope = scope;
      let repeat: CompiledRepeat | undefined;
      const repeatSource = sourceAttributes.get("data-cd-repeat");
      if (repeatSource !== undefined) {
        repeat = compileRepeat(repeatSource, `cd-${options.namespace}-scope-${++repeatCounter}`, scope);
        repeats.push(repeat);
        childScope = scopeForRepeat(repeat);
        attributes["data-cd-repeat-id"] = repeat.scopeId;
      }
      const keyPath = sourceAttributes.get("data-cd-key");
      if (keyPath !== undefined) {
        if (scope.id === "root" || keyPath !== repeats.find((item) => item.scopeId === scope.id)?.keyPath) {
          throw new CompilerError("repeat.key", `Key ${JSON.stringify(keyPath)} is not valid in scope ${scope.id}`);
        }
      }

      for (const [sourceAttribute, kind] of BINDING_ATTRIBUTES) {
        const path = sourceAttributes.get(sourceAttribute);
        if (path === undefined) continue;
        const binding = compileBinding(`cd-${options.namespace}-binding-${++bindingCounter}`, id, kind, path, childScope);
        bindings.push(binding);
        attributes[`data-cd-bind-${kind}`] = binding.id;
      }

      let routeTarget: RouteTarget | undefined;
      const routeId = sourceAttributes.get("data-cd-route");
      if (routeId !== undefined) {
        const params: Record<string, string> = {};
        const handle = sourceAttributes.get("data-cd-param-handle");
        const query = sourceAttributes.get("data-cd-param-query");
        const policyId = sourceAttributes.get("data-cd-param-policy-id");
        if (handle !== undefined) params.handle = handle;
        if (query !== undefined) params.query = query;
        if (policyId !== undefined) params.policyId = policyId;
        routeTarget = compileRouteTarget(routeId, params, childScope);
        routeTargets.push(routeTarget);
        attributes["data-cd-route-target"] = String(routeTargets.length - 1);
      }

      const actionName = sourceAttributes.get("data-cd-action");
      const eventName = sourceAttributes.get("data-cd-on");
      if ((actionName === undefined) !== (eventName === undefined)) {
        throw new CompilerError("interaction.syntax", "data-cd-on and data-cd-action must be supplied together");
      }
      if (actionName !== undefined && eventName !== undefined) {
        const target = sourceAttributes.get("data-cd-target");
        let targetId: string | undefined;
        if (target !== undefined) {
          if (!isSafeIdentifier(target) || !originalIds.has(target)) {
            throw new CompilerError("interaction.target", `Action target ${JSON.stringify(target)} is not a local ID`);
          }
          targetId = originalIds.get(target);
        }
        const rawStateId = sourceAttributes.get("data-cd-state");
        if (rawStateId !== undefined && !stateIds.has(rawStateId)) {
          throw new CompilerError("interaction.state", `Unknown state ID ${JSON.stringify(rawStateId)}`);
        }
        interactions.transitions.push(
          compileTransition({
            on: eventName,
            action: actionName,
            sourceId: id,
            targetId,
            stateId: rawStateId === undefined ? undefined : stateIds.get(rawStateId),
            valueField: sourceAttributes.get("data-cd-value-field"),
            facetId: sourceAttributes.get("data-cd-facet"),
            routeTarget,
          }),
        );
      }

      const boundState = sourceAttributes.get("data-cd-bind-state");
      const boundProperty = sourceAttributes.get("data-cd-bind-property");
      if ((boundState === undefined) !== (boundProperty === undefined)) {
        throw new CompilerError("interaction.binding_syntax", "State binding ID and property must be supplied together");
      }
      if (boundState !== undefined && boundProperty !== undefined) {
        const compiledStateId = stateIds.get(boundState);
        if (!compiledStateId) throw new CompilerError("interaction.state", `Unknown state ID ${JSON.stringify(boundState)}`);
        interactions.bindings.push(compileStateBinding(id, compiledStateId, boundProperty));
      }

      let trustedSlotId: string | undefined;
      const slotKind = sourceAttributes.get("data-cd-slot");
      if (slotKind !== undefined) {
        if (options.checkoutDecorative) throw new CompilerError("checkout.slot", "Trusted slots are forbidden in decorative checkout HTML");
        if (!TRUSTED_SLOT_KINDS.has(slotKind as TrustedSlotManifest["kind"])) {
          throw new CompilerError("slot.kind", `Unsupported trusted slot ${JSON.stringify(slotKind)}`);
        }
        if (slotKind === "cartLineControls" && childScope.kind !== "cartLine") {
          throw new CompilerError("slot.scope", "cartLineControls must be inside a cart.lines repeat scope");
        }
        if (sourceNode.tagName !== "div" && sourceNode.tagName !== "section" && sourceNode.tagName !== "aside" && sourceNode.tagName !== "span") {
          throw new CompilerError("slot.host", "Trusted commerce slots require a neutral presentation host");
        }
        const hostSize = sourceAttributes.get("data-cd-host-size") ?? "block";
        if (!HOST_SIZES.has(hostSize as TrustedSlotManifest["hostSize"])) {
          throw new CompilerError("slot.size", `Unsupported trusted slot size ${JSON.stringify(hostSize)}`);
        }
        const productPath = sourceAttributes.get("data-cd-product");
        if (productPath !== undefined) compileDataRef(productPath, childScope);
        const themeTokenIds = (sourceAttributes.get("data-cd-theme-tokens") ?? "")
          .split(" ")
          .filter(Boolean);
        if (themeTokenIds.some((token) => !isSafeIdentifier(token))) {
          throw new CompilerError("slot.theme", "Trusted slot theme tokens must be local identifiers");
        }
        trustedSlotId = id;
        for (const name of Object.keys(attributes)) delete attributes[name];
        trustedSlots.push({
          id,
          kind: slotKind as TrustedSlotManifest["kind"],
          scopeId: childScope.id === "root" ? undefined : childScope.id,
          hostSize: hostSize as TrustedSlotManifest["hostSize"],
          themeTokenIds,
        });
        attributes["data-cd-trusted-slot-id"] = id;
      }

      if (sourceAttributes.has("data-cd-policy-links")) {
        sawPolicyLinks = true;
        attributes["data-cd-platform-content"] = "policyLinks";
      }
      const assetKey = sourceAttributes.get("data-cd-asset");
      if (assetKey !== undefined) {
        if (!isSafeIdentifier(assetKey)) throw new CompilerError("asset.key", "Asset keys must be local identifiers");
        attributes["data-cd-asset-key"] = assetKey;
      }

      const compiledNode: CompiledElementNode = {
        kind: "element",
        id,
        tag: sourceNode.tagName,
        attributes,
        children: trustedSlotId ? [] : compileNodes(sourceNode.childNodes, childScope),
      };
      if (repeat) compiledNode.repeat = repeat;
      if (routeTarget) compiledNode.routeTarget = routeTarget;
      if (trustedSlotId) compiledNode.trustedSlotId = trustedSlotId;
      if (sourceNode.tagName === "a" && routeTarget === undefined && attributes.href === undefined) {
        throw new CompilerError("html.inert_control", "Visible anchors require a route target or resolved fragment");
      }
      if (sourceNode.tagName === "button" && actionName === undefined) {
        throw new CompilerError("html.inert_control", "Visible buttons require an allowed action");
      }
      output.push(compiledNode);
    }
    return output;
  };

  const tree = compileNodes(fragment.childNodes, rootScope);
  const protectedCssNodes: ProtectedCssNode[] = [];
  const collectProtectedAncestors = (nodes: readonly CompiledNode[]): boolean => {
    let containsProtected = false;
    for (const node of nodes) {
      if (node.kind === "text") continue;
      const childProtected = collectProtectedAncestors(node.children);
      const protectedNode = node.trustedSlotId !== undefined || childProtected;
      if (protectedNode) {
        protectedCssNodes.push({
          id: node.id,
          tag: node.tag,
          classes: splitAsciiWhitespace(node.attributes.class ?? ""),
          attributes: { ...node.attributes },
        });
        containsProtected = true;
      }
    }
    return containsProtected;
  };
  collectProtectedAncestors(tree);
  assertInteractionCompatibility(interactions);
  return {
    html: serializeCompiledTree(tree),
    tree,
    bindings,
    repeats,
    routeTargets,
    interactions,
    trustedSlots,
    policyLinks: sawPolicyLinks,
    protectedCssNodes,
    protectedSourceIds: [...protectedSourceIds].sort(),
  };
}
