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
  | "foreign-template-path";

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

// src= in every quote style the model can author.
const SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
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
  if (ref.startsWith("data:")) return null;
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

function* references(file: string, body: string): Generator<string> {
  if (file.endsWith(".html")) {
    for (const match of body.matchAll(SRC_RE)) yield match[1] ?? match[2] ?? "";
  }
  // url() appears in stylesheets and in inline style attributes alike.
  for (const match of body.matchAll(CSS_URL_RE)) yield match[1] ?? match[2] ?? match[3] ?? "";
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
}): ImageRegistryViolation[] {
  const violations: ImageRegistryViolation[] = [];
  const seen = new Set<string>();
  for (const [file, body] of Object.entries(input.files)) {
    if (!file.endsWith(".html") && !file.endsWith(".css")) continue;
    for (const ref of references(file, body)) {
      const reason = classify(ref, input.templateId, input.firstBuild);
      if (!reason) continue;
      const key = `${file}|${ref.trim()}|${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ file, path: ref.trim(), reason });
    }
  }
  return violations;
}

/** Violations that make a document set unpublishable: references to files
 *  that do not exist (404 on every page view) or to another template's art.
 *  Donor art of the document's own template is a build-time repair concern,
 *  never a publish blocker — stores that shipped it must stay publishable. */
export function unpublishableImageViolations(
  violations: ImageRegistryViolation[],
): ImageRegistryViolation[] {
  return violations.filter(
    (violation) => violation.reason === "invented-path" || violation.reason === "foreign-template-path",
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
      default:
        return `${violation.file}: "${violation.path}" does not exist — the storefront has no such file, so it renders as a broken image. Replace it with a real binding ({{asset.hero}}, {{product.image}}, {{store.logo}}) or remove the element. Never invent image paths.`;
    }
  });
  return `IMAGE AUDIT — these image references are broken or dishonest and must be fixed in this reply:\n- ${lines.join("\n- ")}`;
}
