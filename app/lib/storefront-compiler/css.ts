import postcss, { type AtRule, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import { CompilerError } from "./bindings";
import type { ProtectedCssNode } from "./html";

const ALLOWED_AT_RULES = new Set(["media", "supports", "container", "keyframes"]);
const FORBIDDEN_GLOBAL_TAGS = new Set(["html", "body", "head"]);
const FORBIDDEN_PSEUDOS = new Set([":root", ":host", ":host-context", ":global", "::part", "::slotted"]);
const FORBIDDEN_PROTECTED_ATTRIBUTES = new Set([
  "data-cd-protected",
  "data-cd-trusted-slot-id",
  "data-cd-checkout-root",
  "data-cd-platform-root",
]);
const PRESENTATION_STATE_ATTRIBUTES = new Set(["data-cd-active-value", "data-cd-class-token"]);

function isSafeIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      !(
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        character === "-" ||
        character === "_"
      )
    ) return false;
  }
  return true;
}

function isInsideKeyframes(rule: Rule): boolean {
  let parent: unknown = rule.parent;
  while (parent !== null && typeof parent === "object") {
    const node = parent as { type?: string; name?: string; parent?: unknown };
    if (node.type === "atrule" && node.name?.toLowerCase() === "keyframes") return true;
    parent = node.parent;
  }
  return false;
}

const ROUTE_BOUNDARY_EXCLUSIONS = selectorParser()
  .astSync(":not([data-cd-bundle-route]):not([data-cd-bundle-route] *)", { lossless: false })
  .first.nodes;
const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

function isolateCompiledShellSelector(selector: string): string {
  return selectorParser((root) => {
    root.each((selectorNode) => {
      let alreadyIsolated = false;
      selectorNode.walkAttributes((attribute) => {
        if (attribute.attribute === "data-cd-bundle-route") alreadyIsolated = true;
      });
      if (alreadyIsolated) return;
      let lastCombinator = -1;
      selectorNode.nodes.forEach((node, index) => {
        if (node.type === "combinator") lastCombinator = index;
      });
      const pseudoElement = selectorNode.nodes.find((node, index) =>
        index > lastCombinator && node.type === "pseudo" &&
        (node.value.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(node.value.toLowerCase())),
      );
      for (const exclusion of ROUTE_BOUNDARY_EXCLUSIONS) {
        if (pseudoElement) selectorNode.insertBefore(pseudoElement, exclusion.clone());
        else selectorNode.append(exclusion.clone());
      }
    });
  }).processSync(selector, { lossless: false });
}

export function isolateCompiledShellCss(source: string): string {
  if (!source) return "";
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch (error) {
    throw new CompilerError("css.parse", error instanceof Error ? error.message : "Invalid CSS");
  }
  root.walkRules((rule) => {
    if (!isInsideKeyframes(rule)) rule.selector = isolateCompiledShellSelector(rule.selector);
  });
  return root.toString();
}

function selectorCanMatchProtected(
  selector: selectorParser.Selector,
  protectedNodes: readonly ProtectedCssNode[],
  protectedSourceIds: ReadonlySet<string>,
): boolean {
  let compoundStart = 0;
  selector.nodes.forEach((node, index) => {
    if (node.type === "combinator") compoundStart = index + 1;
  });
  const compound = selector.nodes.slice(compoundStart);
  for (const node of compound) {
    if (node.type === "id" && protectedSourceIds.has(node.value)) return true;
  }
  return protectedNodes.some((candidate) => {
    let hasPositiveSelector = false;
    for (const node of compound) {
      if (node.type === "comment" || node.type === "pseudo") continue;
      if (node.type === "universal") {
        hasPositiveSelector = true;
        continue;
      }
      if (node.type === "id") {
        hasPositiveSelector = true;
        if (node.value !== candidate.id) return false;
      } else if (node.type === "class") {
        hasPositiveSelector = true;
        if (!candidate.classes.includes(node.value)) return false;
      } else if (node.type === "tag") {
        hasPositiveSelector = true;
        if (node.value.toLowerCase() !== candidate.tag) return false;
      } else if (node.type === "attribute") {
        hasPositiveSelector = true;
        const actual = node.attribute === "id" ? candidate.id : candidate.attributes[node.attribute];
        if (actual === undefined) return false;
        if (node.operator === "=" && node.value !== actual) return false;
      } else return true;
    }
    return !hasPositiveSelector || hasPositiveSelector;
  });
}

function compileSelector(
  selector: string,
  namespace: string,
  protectedNodes: readonly ProtectedCssNode[],
  protectedSourceIds: ReadonlySet<string>,
): string {
  try {
    return selectorParser((root) => {
      root.each((selectorNode) => {
        if (selectorCanMatchProtected(selectorNode, protectedNodes, protectedSourceIds)) {
          throw new CompilerError("css.protected_selector", "Generated CSS selector can match a protected commerce host or ancestor");
        }
      });
      root.walkTags((tag) => {
        if (FORBIDDEN_GLOBAL_TAGS.has(tag.value.toLowerCase())) {
          throw new CompilerError("css.selector_escape", `Global selector ${JSON.stringify(tag.value)} is forbidden`);
        }
      });
      root.walkPseudos((pseudo) => {
        if (FORBIDDEN_PSEUDOS.has(pseudo.value.toLowerCase())) {
          throw new CompilerError("css.selector_escape", `Pseudo selector ${JSON.stringify(pseudo.value)} is forbidden`);
        }
      });
      root.walkAttributes((attribute) => {
        if (FORBIDDEN_PROTECTED_ATTRIBUTES.has(attribute.attribute)) {
          throw new CompilerError("css.protected_selector", "Generated CSS cannot select protected platform hosts");
        }
        if (
          attribute.attribute.startsWith("data-cd-") &&
          attribute.attribute !== "data-cd-state" &&
          !PRESENTATION_STATE_ATTRIBUTES.has(attribute.attribute)
        ) {
          throw new CompilerError("css.compiler_selector", `Compiler-owned selector ${attribute.attribute} is forbidden`);
        }
      });
      root.walkIds((id) => {
        if (!isSafeIdentifier(id.value)) throw new CompilerError("css.id", `Invalid ID selector ${JSON.stringify(id.value)}`);
        id.value = `cd-${namespace}-${id.value}`;
      });
      root.each((selectorNode) => {
        selectorNode.prepend(selectorParser.combinator({ value: " " }));
        selectorNode.prepend(
          selectorParser.attribute({
            attribute: "data-cd-bundle",
            operator: "=",
            value: namespace,
            quoteMark: '"',
            raws: {},
          }),
        );
      });
    }).processSync(selector, { lossless: false });
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("css.selector_parse", error instanceof Error ? error.message : "Invalid selector");
  }
}

const NETWORK_FUNCTIONS = new Set([
  "url", "src", "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "paint", "element", "-moz-element",
]);

function hasNetworkMarker(value: string): boolean {
  const lower = decodeCssEscapes(value).toLowerCase();
  return lower.includes("http:") || lower.includes("https:") || lower.includes("data:") || lower.includes("blob:") || lower.startsWith("//");
}

function decodeCssEscapes(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) break;
    if (next === "\n" || next === "\f") {
      index += 1;
      continue;
    }
    if (next === "\r") {
      index += value[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    let hex = "";
    let cursor = index + 1;
    while (cursor < value.length && hex.length < 6 && /[0-9a-f]/i.test(value[cursor]!)) {
      hex += value[cursor]!;
      cursor += 1;
    }
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      decoded += codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
      if (/\s/.test(value[cursor] ?? "")) cursor += 1;
      index = cursor - 1;
      continue;
    }
    decoded += next;
    index += 1;
  }
  return decoded;
}

function parseDimension(word: string): { value: number; unit: string } | null {
  let numeric = "";
  let index = 0;
  if (word[0] === "+" || word[0] === "-") numeric += word[index++];
  let sawDigit = false;
  let sawDot = false;
  while (index < word.length) {
    const character = word[index]!;
    if (character >= "0" && character <= "9") {
      sawDigit = true;
      numeric += character;
      index += 1;
    } else if (character === "." && !sawDot) {
      sawDot = true;
      numeric += character;
      index += 1;
    } else break;
  }
  if (!sawDigit) return null;
  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;
  return { value, unit: word.slice(index).toLowerCase() };
}

function assertBoundedDimensions(value: string, maxPx: number, allowAuto = false, allowNegative = false): void {
  const parsed = valueParser(value);
  let count = 0;
  parsed.walk((node) => {
    if (node.type === "space" || node.type === "comment") return;
    if (node.type !== "word") throw new CompilerError("checkout.css_value", "Checkout dimensions must be static bounded values");
    count += 1;
    if (allowAuto && node.value === "auto") return;
    const dimension = parseDimension(node.value);
    if (!dimension || (!allowNegative && dimension.value < 0)) throw new CompilerError("checkout.css_value", "Checkout dimensions cannot be negative or dynamic");
    const pixels = dimension.unit === "px" || dimension.unit === "" ? dimension.value : dimension.unit === "rem" || dimension.unit === "em" ? dimension.value * 16 : Number.POSITIVE_INFINITY;
    if (pixels > maxPx || pixels < (allowNegative ? -maxPx : 0)) throw new CompilerError("checkout.css_value", "Checkout dimension exceeds its bound");
  });
  if (count === 0 || count > 4) throw new CompilerError("checkout.css_value", "Checkout dimensions require one to four values");
}

const CHECKOUT_PROPERTIES = new Set([
  "color", "background-color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-decoration", "display", "grid-template-columns", "grid-template-rows",
  "grid-column", "grid-row", "grid-area", "gap", "row-gap", "column-gap", "align-items", "align-content",
  "justify-items", "justify-content", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "border-width", "border-top-width",
  "border-right-width", "border-bottom-width", "border-left-width", "border-style", "border-color", "border-radius",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "overflow", "overflow-x", "overflow-y",
  "object-fit", "aspect-ratio",
]);

function assertCheckoutValue(property: string, value: string): void {
  if (!CHECKOUT_PROPERTIES.has(property)) throw new CompilerError("checkout.css_property", `Property ${property} is not allowlisted in checkout decoration`);
  if (property.startsWith("margin") || property.startsWith("padding") || property.endsWith("gap")) {
    assertBoundedDimensions(value, 128, property.startsWith("margin"));
    return;
  }
  if (property.includes("width") || property.includes("height")) {
    assertBoundedDimensions(value, property.includes("height") ? 1_000 : 1_600, true);
    return;
  }
  if (property.endsWith("border-width") || property === "border-width" || property === "border-radius") {
    assertBoundedDimensions(value, property === "border-radius" ? 64 : 12);
    return;
  }
  if (property === "font-size") {
    assertBoundedDimensions(value, 96);
    return;
  }
  if (property === "line-height") {
    assertBoundedDimensions(value, 48);
    return;
  }
  if (property === "letter-spacing") {
    assertBoundedDimensions(value, 16, false, true);
    return;
  }
  if (property === "display" && !new Set(["block", "inline", "inline-block", "flex", "inline-flex", "grid"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout display value is not allowlisted");
  }
  if ((property === "color" || property === "background-color" || property === "border-color")) {
    const parsed = valueParser(value);
    let valid = true;
    parsed.walk((node) => {
      if (node.type === "function" && !new Set(["var", "rgb", "rgba", "hsl", "hsla"]).has(node.value.toLowerCase())) valid = false;
      if (node.type === "string" || node.type === "div") valid = false;
    });
    if (!valid) throw new CompilerError("checkout.css_value", `${property} must be a static color or approved token`);
  }
  if (property === "font-family" && !new Set(["inherit", "var(--font-body)", "var(--font-display)"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout font family must use a curated font token");
  }
  if (property === "font-weight" && !new Set(["normal", "bold", "400", "500", "600", "700", "800", "900"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout font weight is not allowlisted");
  }
  if (property === "font-style" && !new Set(["normal", "italic"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout font style is not allowlisted");
  }
  if (property === "text-align" && !new Set(["start", "end", "left", "right", "center"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout text alignment is not allowlisted");
  }
  if (property === "text-decoration" && !new Set(["none", "underline"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout text decoration is not allowlisted");
  }
  if ((property === "align-items" || property === "align-content" || property === "justify-items" || property === "justify-content") &&
    !new Set(["start", "end", "center", "stretch", "space-between", "space-around"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout alignment value is not allowlisted");
  }
  if (property === "border-style" && !new Set(["none", "solid", "dashed"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout border style is not allowlisted");
  }
  if ((property === "grid-template-columns" || property === "grid-template-rows") && !new Set(["1fr", "1fr 1fr", "2fr 1fr", "minmax(0, 1fr) minmax(0, 1fr)"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout grid track definition is not allowlisted");
  }
  if ((property === "grid-area" || property === "grid-column" || property === "grid-row") && !isSafeIdentifier(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout grid placement must be one local area identifier");
  }
  if ((property === "overflow" || property === "overflow-x" || property === "overflow-y") && !new Set(["visible", "hidden", "clip", "auto"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout overflow value is not allowlisted");
  }
  if (property === "object-fit" && !new Set(["contain", "cover", "fill", "scale-down"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout object-fit value is not allowlisted");
  }
  if (property === "aspect-ratio" && !new Set(["1 / 1", "4 / 3", "3 / 2", "16 / 9"]).has(value.trim())) {
    throw new CompilerError("checkout.css_value", "Checkout aspect ratio is not allowlisted");
  }
}

export function assertSafeCssValue(property: string, value: string, checkoutDecorative = false): void {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type === "function") {
      const name = decodeCssEscapes(node.value).toLowerCase();
      if (NETWORK_FUNCTIONS.has(name) || name === "expression" || name === "attr") {
        throw new CompilerError("css.network_or_dynamic_value", `${name}() is forbidden in generated CSS`);
      }
    }
    if ((node.type === "string" || node.type === "word") && hasNetworkMarker(node.value)) {
      throw new CompilerError("css.network_value", "Network-capable string values are forbidden in generated CSS");
    }
  });
  const normalizedProperty = property.toLowerCase();
  if (normalizedProperty === "behavior" || normalizedProperty === "-moz-binding") {
    throw new CompilerError("css.dangerous_property", `Property ${property} is forbidden`);
  }
  if (normalizedProperty === "position" && value.trim().toLowerCase() === "fixed") {
    throw new CompilerError("css.fixed_overlay", "Fixed overlays must use a trusted platform surface");
  }
  if (checkoutDecorative) {
    assertCheckoutValue(normalizedProperty, value);
  }
}

export function assertSafeDesignTokenValue(tokenId: string, value: string): void {
  if (!isSafeIdentifier(tokenId)) throw new CompilerError("design.token", "Design token ID is invalid");
  const compiled = compileCss(`.token { --${tokenId}: ${value}; }`, { namespace: "token-check" });
  const root = postcss.parse(compiled.css, { from: undefined });
  let declarationCount = 0;
  root.walkDecls((declaration) => {
    declarationCount += 1;
    if (declaration.prop !== `--${tokenId}`) throw new CompilerError("design.token", "Design token value escaped its declaration");
  });
  if (declarationCount !== 1) throw new CompilerError("design.token", "Design token must compile to exactly one declaration");
}

function namespaceAnimationValue(value: string, keyframes: ReadonlyMap<string, string>): string {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type === "word") {
      const replacement = keyframes.get(node.value);
      if (replacement) node.value = replacement;
    }
  });
  return parsed.toString();
}

export interface CompileCssOptions {
  namespace: string;
  checkoutDecorative?: boolean;
  protectedNodes?: readonly ProtectedCssNode[];
  protectedSourceIds?: readonly string[];
}

export interface CompiledCssResult {
  css: string;
  ruleCount: number;
  keyframes: string[];
}

export interface ValidateCompiledCssOptions extends CompileCssOptions {}

export function validateCompiledCss(source: string, options: ValidateCompiledCssOptions): { ruleCount: number } {
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch (error) {
    throw new CompilerError("css.parse", error instanceof Error ? error.message : "Invalid CSS");
  }
  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (!ALLOWED_AT_RULES.has(name)) throw new CompilerError("css.at_rule", `At-rule @${name} is forbidden`);
    if (name === "keyframes" && !atRule.params.startsWith(`cd-${options.namespace}-`)) {
      throw new CompilerError("css.keyframes_scope", "Compiled keyframes are not namespaced");
    }
  });
  let ruleCount = 0;
  root.walkRules((rule) => {
    ruleCount += 1;
    if (isInsideKeyframes(rule)) return;
    let selectorRoot: selectorParser.Root;
    try {
      selectorRoot = selectorParser().astSync(rule.selector, { lossless: false });
    } catch (error) {
      throw new CompilerError("css.selector_parse", error instanceof Error ? error.message : "Invalid selector");
    }
    selectorRoot.each((selector) => {
      const first = selector.nodes[0];
      const second = selector.nodes[1];
      const scoped =
        first?.type === "attribute" &&
        first.attribute === "data-cd-bundle" &&
        first.operator === "=" &&
        first.value === options.namespace &&
        second?.type === "combinator";
      if (!scoped) throw new CompilerError("css.scope", "Compiled selector is not rooted under its bundle namespace");
      if (selectorCanMatchProtected(selector, options.protectedNodes ?? [], new Set())) {
        throw new CompilerError("css.protected_selector", "Compiled selector can match a protected commerce host or ancestor");
      }
      selector.walkTags((tag) => {
        if (FORBIDDEN_GLOBAL_TAGS.has(tag.value.toLowerCase())) throw new CompilerError("css.selector_escape", "Global selectors are forbidden");
      });
      selector.walkAttributes((attribute) => {
        if (attribute === first) return;
        if (FORBIDDEN_PROTECTED_ATTRIBUTES.has(attribute.attribute)) throw new CompilerError("css.protected_selector", "Protected selectors are forbidden");
      });
    });
  });
  root.walkDecls((declaration) => assertSafeCssValue(declaration.prop, declaration.value, options.checkoutDecorative ?? false));
  return { ruleCount };
}

export function compileCss(source: string, options: CompileCssOptions): CompiledCssResult {
  if (!isSafeIdentifier(options.namespace)) throw new CompilerError("css.namespace", "CSS namespace is invalid");
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch (error) {
    throw new CompilerError("css.parse", error instanceof Error ? error.message : "Invalid CSS");
  }

  const keyframes = new Map<string, string>();
  root.walkAtRules((atRule: AtRule) => {
    const name = atRule.name.toLowerCase();
    if (!ALLOWED_AT_RULES.has(name)) {
      throw new CompilerError("css.at_rule", `At-rule @${atRule.name} is forbidden`);
    }
    if (name === "keyframes") {
      if (!isSafeIdentifier(atRule.params)) throw new CompilerError("css.keyframes", "Keyframe name is invalid");
      if (keyframes.has(atRule.params)) throw new CompilerError("css.keyframes_duplicate", `Duplicate keyframes ${atRule.params}`);
      keyframes.set(atRule.params, `cd-${options.namespace}-${atRule.params}`);
    }
  });

  let ruleCount = 0;
  root.walkRules((rule: Rule) => {
    ruleCount += 1;
    if (!isInsideKeyframes(rule)) {
      rule.selector = compileSelector(
        rule.selector,
        options.namespace,
        options.protectedNodes ?? [],
        new Set(options.protectedSourceIds ?? []),
      );
    }
  });
  root.walkDecls((declaration) => {
    assertSafeCssValue(declaration.prop, declaration.value, options.checkoutDecorative ?? false);
    if (declaration.prop.toLowerCase() === "animation" || declaration.prop.toLowerCase() === "animation-name") {
      declaration.value = namespaceAnimationValue(declaration.value, keyframes);
    }
  });
  root.walkAtRules("keyframes", (atRule) => {
    atRule.params = keyframes.get(atRule.params)!;
  });

  const css = root.toString();
  return {
    css: options.namespace === "shell" ? isolateCompiledShellCss(css) : css,
    ruleCount,
    keyframes: [...keyframes.values()].sort(),
  };
}
