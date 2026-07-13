import postcss, { type AtRule, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import { CompilerError } from "./bindings";

const ALLOWED_AT_RULES = new Set(["media", "supports", "container", "keyframes"]);
const FORBIDDEN_GLOBAL_TAGS = new Set(["html", "body", "head"]);
const FORBIDDEN_PSEUDOS = new Set([":root", ":host", ":host-context", ":global", "::part", "::slotted"]);
const FORBIDDEN_PROTECTED_ATTRIBUTES = new Set([
  "data-cd-protected",
  "data-cd-trusted-slot-id",
  "data-cd-checkout-root",
  "data-cd-platform-root",
]);

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

function compileSelector(selector: string, namespace: string): string {
  try {
    return selectorParser((root) => {
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
        if (attribute.attribute.startsWith("data-cd-") && attribute.attribute !== "data-cd-state") {
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

function assertSafeValue(property: string, value: string, checkoutDecorative: boolean): void {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type === "function") {
      const name = node.value.toLowerCase();
      if (name === "url" || name === "expression" || name === "attr") {
        throw new CompilerError("css.network_or_dynamic_value", `${name}() is forbidden in generated CSS`);
      }
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
    if (
      new Set([
        "pointer-events", "z-index", "content", "filter", "backdrop-filter", "position", "transform", "translate",
        "scale", "rotate", "inset", "top", "right", "bottom", "left", "clip-path",
      ]).has(normalizedProperty)
    ) {
      throw new CompilerError("checkout.css_property", `Property ${property} is forbidden in checkout decoration`);
    }
    if (normalizedProperty === "opacity" && Number(value.trim()) < 1) {
      throw new CompilerError("checkout.opacity", "Checkout decoration cannot be translucent");
    }
  }
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
}

export interface CompiledCssResult {
  css: string;
  ruleCount: number;
  keyframes: string[];
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
    if (!isInsideKeyframes(rule)) rule.selector = compileSelector(rule.selector, options.namespace);
  });
  root.walkDecls((declaration) => {
    assertSafeValue(declaration.prop, declaration.value, options.checkoutDecorative ?? false);
    if (declaration.prop.toLowerCase() === "animation" || declaration.prop.toLowerCase() === "animation-name") {
      declaration.value = namespaceAnimationValue(declaration.value, keyframes);
    }
  });
  root.walkAtRules("keyframes", (atRule) => {
    atRule.params = keyframes.get(atRule.params)!;
  });

  return { css: root.toString(), ruleCount, keyframes: [...keyframes.values()].sort() };
}
