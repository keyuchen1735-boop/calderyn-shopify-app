// Deterministic image-reference validator for designer documents (designer
// flagship spec D4; the later D2.3 audit reuses this mechanism). Every image
// reference a document carries — <img src> and CSS url() — must be one of:
//   - a known placeholder binding ({{asset.<key>}}, {{product.image}},
//     {{store.logo}}) the renderer resolves against real store data,
//   - a REAL donor-template asset path from that template's manifest
//     (/storefront-recipes/<templateId>/<key>.webp — nothing else exists on
//     disk, so any other path 404s on every page view),
//   - a self-hosted font file (/storefront-fonts/...), or
//   - a data: URI (the renderer's neutral placeholder).
// Anything else is a violation. Donor paths are additionally violations on a
// FIRST build: template adaptation must replace or remove donor art, never
// keep a pantry template's food photography on a candle store (spec D4's
// "template art replacement is a contract"). On edit turns donor paths stay
// legal so stores that already shipped them keep working.
import { STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";

export type ImageViolationReason =
  | "invented-path"
  | "donor-art-on-first-build"
  | "foreign-template-path"
  | "missing-required-asset-binding"
  | "synthetic-product-media-stand-in";

export interface ImageRegistryViolation {
  /** Document file name, e.g. "home.html" or "base.css". */
  file: string;
  /** The offending reference, verbatim. */
  path: string;
  reason: ImageViolationReason;
}

// {{asset.<key>}} / {{product.image}} / {{store.logo}} — the renderer's whole
// image vocabulary. Anything else in {{...}} does not bind an image.
const PLACEHOLDER_RE = /^\{\{\s*(?:asset\.[a-z0-9_-]+|product\.image|store\.logo)\s*\}\}$/i;

// src/srcset in every quote style the model can author, including bare values.
const IMAGE_ATTR_RE = /\b(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
// CSS url(...) — quoted or bare — in stylesheets and inline style attributes.
const CSS_URL_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^'")][^)]*))\)/gi;

/** Donor asset paths, keyed by template id, unioned across every registered
 *  template version — older documents may reference an older version's art. */
function donorPathsByTemplate(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const template of STORE_TEMPLATE_REGISTRY.templates) {
    const paths = new Set<string>();
    for (const version of template.versions) {
      for (const entry of version.assets.entries) {
        paths.add(`/storefront-recipes/${template.id}/${entry.key}.webp`);
      }
    }
    map.set(template.id, paths);
  }
  return map;
}

let donorPathsCache: Map<string, Set<string>> | null = null;
function donorPaths(): Map<string, Set<string>> {
  donorPathsCache ??= donorPathsByTemplate();
  return donorPathsCache;
}

/** The donor template's real art paths, for prompts that must name them
 *  explicitly (first-build replacement contract). Empty for scratch builds
 *  and unknown template ids. */
export function donorTemplateArtPaths(templateId: string): string[] {
  return [...(donorPaths().get(templateId) ?? [])].sort();
}

function classify(
  raw: string,
  templateId: string,
  firstBuild: boolean,
): ImageViolationReason | null {
  const ref = raw.trim();
  if (ref === "" || ref === "none") return null;
  if (ref.startsWith("{{")) return PLACEHOLDER_RE.test(ref) ? null : "invented-path";
  if (/^data:/i.test(ref)) return null;
  if (ref.startsWith("#")) return null; // SVG fragment references in url()
  if (ref.startsWith("/storefront-fonts/")) return null;
  if (ref.startsWith("/storefront-recipes/")) {
    const own = donorPaths().get(templateId);
    if (own?.has(ref)) return firstBuild ? "donor-art-on-first-build" : null;
    for (const paths of donorPaths().values()) {
      if (paths.has(ref)) return "foreign-template-path";
    }
    return "invented-path";
  }
  return "invented-path";
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})[\t\n\f\r ]?/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
    })
    .replace(/\\\r\n|\\[\n\r\f]/g, "")
    .replace(/\\(.)/gs, "$1");
}

function* srcsetCandidates(value: string): Generator<string> {
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (index >= value.length) break;

    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);

    // A bare srcset may compact candidates as /a.jpg,/b.jpg. Data URLs own
    // commas, so only split comma-packed non-data tokens.
    if (!/^data:/i.test(url) && url.includes(",")) {
      for (const candidate of url.split(",")) {
        if (candidate) yield candidate;
      }
    } else {
      url = url.replace(/,+$/, "");
      if (url) yield url;
    }

    while (index < value.length && value[index] !== ",") index += 1;
    if (value[index] === ",") index += 1;
  }
}

interface ImageReference {
  raw: string;
  canonical: string;
}

function* references(file: string, body: string): Generator<ImageReference> {
  if (file.endsWith(".html")) {
    for (const match of body.matchAll(IMAGE_ATTR_RE)) {
      const kind = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (kind === "srcset") {
        for (const candidate of srcsetCandidates(value)) {
          yield { raw: candidate, canonical: candidate };
        }
      } else {
        yield { raw: value, canonical: value };
      }
    }
  }
  // url() appears in stylesheets and in inline style attributes alike.
  for (const match of body.matchAll(CSS_URL_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    yield { raw, canonical: decodeCssEscapes(raw) };
  }
}

const PRODUCTS_LOOP_RE = /\{\{#products\}\}([\s\S]*?)\{\{\/products\}\}/gi;
const OPENING_TAG_RE = /<(?![\s/!])([a-z][\w-]*)\b([^>]*)>/gi;
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const STYLE_ATTR_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function classWords(className: string): string[] {
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classWithWord(classNames: string[], vocabulary: readonly string[]): string | null {
  for (const className of classNames) {
    if (classWords(className).some((word) => vocabulary.includes(word))) {
      return className;
    }
  }
  return null;
}

function mediaSemanticClass(classNames: string[]): string | null {
  return classWithWord(classNames, [
    "media", "image", "img", "photo", "picture", "visual", "thumbnail",
    "thumb", "artwork", "placeholder", "initial", "initials",
  ]);
}

function cssEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classDeclarations(styles: string, className: string): string {
  const token = new RegExp(`(?:^|[^a-z0-9_-])\\.${cssEscape(className)}(?![a-z0-9_-])`, "i");
  const declarations: string[] = [];
  for (const rule of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (token.test(rule[1])) declarations.push(rule[2]);
  }
  return declarations.join(";");
}

function reservesPaintedMediaArea(declarations: string): boolean {
  const painted = /\bbackground(?:-image|-color)?\s*:/i.test(declarations);
  const aspectRatio = /\baspect-ratio\s*:\s*(?!auto\b|initial\b|unset\b|none\b)[^;]+/i.test(declarations);
  const largeHeight = [...declarations.matchAll(/\b(?:min-)?height\s*:\s*(\d*\.?\d+)\s*(px|r?em|vh|vw)\b/gi)]
    .some((match) => {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === "px") return amount >= 120;
      if (unit === "rem" || unit === "em") return amount >= 7.5;
      return amount >= 20;
    });
  const ratioPadding = [...declarations.matchAll(/\bpadding-(?:top|bottom)\s*:\s*(\d*\.?\d+)\s*%/gi)]
    .some((match) => Number(match[1]) >= 50);
  return painted && (aspectRatio || largeHeight || ratioPadding);
}

function elementContent(body: string, tagName: string, contentStart: number): string {
  const remainder = body.slice(contentStart);
  const tag = new RegExp(`<\\/?${cssEscape(tagName)}\\b[^>]*>`, "gi");
  let depth = 1;
  for (const match of remainder.matchAll(tag)) {
    if (/^<\//.test(match[0])) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return remainder.slice(0, match.index);
  }
  return "";
}

/** Product-card media must either bind real photography or disappear. A
 *  media-shaped wrapper otherwise renders as fake photography when it contains
 *  only a badge, gradient, initials, or an empty neutral block. This check is
 *  scoped to product loops, so typographic/color heroes and content-led cards
 *  remain valid. */
function syntheticProductMediaViolations(
  file: string,
  body: string,
  styles: string,
  productImagesAvailable: boolean,
): ImageRegistryViolation[] {
  const violations: ImageRegistryViolation[] = [];
  const seen = new Set<string>();
  for (const loop of body.matchAll(PRODUCTS_LOOP_RE)) {
    for (const tag of loop[1].matchAll(OPENING_TAG_RE)) {
      const classMatch = tag[2].match(CLASS_ATTR_RE);
      const classNames = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const contentStart = (tag.index ?? 0) + tag[0].length;
      const content = elementContent(loop[1], tag[1], contentStart);
      const semanticClass = mediaSemanticClass(classNames);
      const paintedClass = classNames.find((candidate) => reservesPaintedMediaArea(classDeclarations(styles, candidate))) ?? null;
      const styleMatch = tag[2].match(STYLE_ATTR_RE);
      const inlineStyle = styleMatch?.[1] ?? styleMatch?.[2] ?? styleMatch?.[3] ?? "";
      const paintedInline = reservesPaintedMediaArea(inlineStyle);
      const imageElement = /^(?:img|picture)$/i.test(tag[1]);
      if (!imageElement && !paintedClass && !paintedInline) continue;

      const carriesSubstantiveProductContent = /\{\{\s*product\.(?:title|price|description)\s*\}\}/i.test(content);
      if (carriesSubstantiveProductContent) continue;

      const bindsProductImage = /\{\{\s*product\.image\s*\}\}/i.test(`${tag[0]}${content}`);
      if (imageElement && bindsProductImage) continue;
      if (productImagesAvailable && bindsProductImage) continue;

      const className = semanticClass ?? paintedClass;
      const path = className
        ? `.${className}`
        : paintedInline
          ? `<${tag[1].toLowerCase()} style>`
          : `<${tag[1].toLowerCase()}>`;
      if (seen.has(path)) continue;
      seen.add(path);
      violations.push({ file, path, reason: "synthetic-product-media-stand-in" });
    }
  }
  return violations;
}

/** Validates every image reference in a designer file set. Pure — safe to run
 *  on every save; callers decide what a violation means (repair-loop feedback
 *  during builds, a hard refusal at publish time). */
export function findImageRegistryViolations(input: {
  files: Record<string, string>;
  templateId: string;
  /** Donor-template art is a violation only while first-building; previously
   *  saved donor paths stay legal on edit turns so existing stores don't break. */
  firstBuild: boolean;
  availableAssetKeys?: ReadonlySet<string>;
  storeLogoAvailable?: boolean;
  productImagesAvailable?: boolean;
}): ImageRegistryViolation[] {
  const violations: ImageRegistryViolation[] = [];
  const seen = new Set<string>();
  for (const [file, body] of Object.entries(input.files)) {
    if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
    for (const ref of references(file, body)) {
      let reason = classify(ref.canonical, input.templateId, input.firstBuild);
      if (!reason && input.firstBuild && input.availableAssetKeys) {
        const asset = ref.canonical.trim().match(/^\{\{\s*asset\.([a-z0-9_-]+)\s*\}\}$/i);
        if (asset && !input.availableAssetKeys.has(asset[1].toLowerCase())) {
          reason = "missing-required-asset-binding";
        }
      }
      if (!reason && (input.firstBuild || input.productImagesAvailable === false)) {
        const placeholder = ref.canonical.trim().replace(/\s/g, "").toLowerCase();
        if (input.firstBuild && placeholder === "{{store.logo}}" && input.storeLogoAvailable === false) {
          reason = "missing-required-asset-binding";
        }
        if (placeholder === "{{product.image}}" && input.productImagesAvailable === false) {
          reason = "missing-required-asset-binding";
        }
      }
      if (!reason) continue;
      const path = ref.raw.trim();
      const key = `${file}|${path}|${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ file, path, reason });
    }
    if (input.productImagesAvailable !== undefined && file.endsWith(".html")) {
      const routeCss = input.files[file.replace(/\.html$/i, ".css")] ?? "";
      const styles = `${input.files["base.css"] ?? ""}\n${routeCss}`;
      violations.push(...syntheticProductMediaViolations(file, body, styles, input.productImagesAvailable));
    }
  }
  return violations;
}

/** Violations that make a document set unpublishable: references to files
 *  that do not exist, another template's art, or fake product-media regions.
 *  Donor art of the document's own template is a build-time repair concern,
 *  never a publish blocker — stores that shipped it must stay publishable. */
export function unpublishableImageViolations(
  violations: ImageRegistryViolation[],
): ImageRegistryViolation[] {
  return violations.filter(
    (violation) =>
      violation.reason === "invented-path"
      || violation.reason === "foreign-template-path"
      || violation.reason === "synthetic-product-media-stand-in"
      || (violation.reason === "missing-required-asset-binding" && /\{\{\s*product\.image\s*\}\}/i.test(violation.path)),
  );
}

/** One repair instruction covering every finding, phrased for the model's
 *  retry/review loop. Empty string when the set is clean. */
export function imageRepairInstruction(violations: ImageRegistryViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map((violation) => {
    switch (violation.reason) {
      case "donor-art-on-first-build":
        return `${violation.file}: "${violation.path}" is the donor template's own artwork — it belongs to another product category, not this store. Replace it with a real binding ({{asset.hero}} for the hero photograph, {{product.image}} inside product cards, {{store.logo}} for the logo) or remove the element entirely. Never keep it with rewritten alt text.`;
      case "foreign-template-path":
        return `${violation.file}: "${violation.path}" belongs to a different template and must not be referenced. Replace it with a real binding ({{asset.hero}}, {{product.image}}, {{store.logo}}) or remove the element.`;
      case "missing-required-asset-binding":
        if (/\{\{\s*store\.logo\s*\}\}/i.test(violation.path)) {
          return `${violation.file}: "${violation.path}" has no real store logo behind it, so it renders neutral placeholder art. Remove the image and use a typographic store-name treatment instead.`;
        }
        if (/\{\{\s*product\.image\s*\}\}/i.test(violation.path)) {
          return `${violation.file}: "${violation.path}" is not safe because the catalog is empty or at least one product has no real photo, so a card renders neutral placeholder art. Remove the image or use an intentional image-free card treatment instead.`;
        }
        return `${violation.file}: "${violation.path}" has no successfully adopted or generated asset behind it, so it renders neutral placeholder art. Remove that image and use a deliberate typographic/color treatment instead.`;
      case "synthetic-product-media-stand-in":
        return `${violation.file}: "${violation.path}" reserves a fake media area without actually rendering real product photography. Bind {{product.image}} when every product has real photography, or remove the media region entirely and compose an intentional image-free card from the real title, price, availability, and action. Do not substitute a blank or neutral box, gradient, initials, icon, or illustration.`;
      default:
        return `${violation.file}: "${violation.path}" does not exist — the storefront has no such file, so it renders as a broken image. Replace it with a real binding ({{asset.hero}}, {{product.image}}, {{store.logo}}) or remove the element. Never invent image paths.`;
    }
  });
  return `IMAGE AUDIT — these image references are broken or dishonest and must be fixed in this reply:\n- ${lines.join("\n- ")}`;
}
