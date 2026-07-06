// app/lib/storebuilder/sanitize-html.server.ts
// Server-only security boundary for AI/merchant-authored store HTML (the `rawHtml` block).
// The store generator lets the model write a complete, flashy home page as HTML so a store can look
// designed WITHOUT product imagery — but that HTML is untrusted and renders on the PUBLIC
// storefront, so it must never carry script, event handlers, javascript: URLs, or external resource
// loads. Rich, image-free design IS allowed: inline styles, a <style> block (gradients, grid, hover,
// @media, keyframes), and inline SVG. This runs at the persistence choke point (saveDraft), so every
// write path — generator, studio, experiments — is covered uniformly. Never store un-sanitized HTML.
import sanitizeHtml from "sanitize-html";
import type { BlockDocument } from "./types";

// A full designed page with inline CSS; also caps abuse / DB bloat.
const MAX_HTML = 100_000;

export function sanitizeStoreHtml(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  const cleaned = sanitizeHtml(html.slice(0, MAX_HTML), {
    allowedTags: [
      "div", "section", "article", "header", "footer", "nav", "main", "aside", "figure", "figcaption",
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "ul", "ol", "li", "blockquote", "br", "hr",
      "strong", "em", "b", "i", "u", "small", "mark", "sub", "sup", "time", "address", "label",
      "img", "picture", "source", "button", "style",
      // inline SVG for icons / shapes — lets the model design without external images
      "svg", "path", "g", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs",
      "lineargradient", "radialgradient", "stop", "clippath", "use", "text", "tspan", "symbol", "title",
    ],
    allowedAttributes: {
      "*": ["class", "id", "style", "role", "aria-label", "aria-hidden", "aria-labelledby", "title", "data-*"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
      source: ["src", "srcset", "sizes", "type", "media"],
      button: ["type"],
      time: ["datetime"],
      label: ["for"],
      svg: ["viewbox", "xmlns", "width", "height", "fill", "stroke", "stroke-width", "preserveaspectratio", "aria-hidden", "role", "class", "style"],
      path: ["d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "transform", "fill-rule", "clip-rule"],
      g: ["fill", "stroke", "transform", "opacity", "clip-path"],
      circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width", "opacity", "transform"],
      ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke", "opacity", "transform"],
      rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "opacity", "transform"],
      line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "opacity"],
      polyline: ["points", "fill", "stroke", "stroke-width", "opacity"],
      polygon: ["points", "fill", "stroke", "stroke-width", "opacity"],
      lineargradient: ["id", "x1", "y1", "x2", "y2", "gradientunits", "gradienttransform"],
      radialgradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientunits", "gradienttransform"],
      stop: ["offset", "stop-color", "stop-opacity"],
      use: ["href", "x", "y", "width", "height"],
      text: ["x", "y", "dx", "dy", "fill", "font-size", "font-family", "font-weight", "text-anchor", "transform", "opacity"],
      tspan: ["x", "y", "dx", "dy", "fill", "font-size", "font-weight"],
      clippath: ["id"],
      symbol: ["id", "viewbox"],
    },
    // Script vectors: script/iframe/object/embed/form/input are NOT in allowedTags, so they are
    // dropped; on* handlers are stripped by default; only these URL schemes survive on links.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    // We intentionally keep <style> (never <script>) so the design can use real CSS; acknowledge
    // sanitize-html's vulnerable-tag flag rather than hand-rolling a CSS parser.
    allowVulnerableTags: true,
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
    // sanitize-html drops HTML comments by default → no AI/provenance leak into browser source.
    transformTags: {
      // External links open in a new tab with noopener (no reverse-tabnabbing); internal stay plain.
      a: (tagName, attribs) =>
        /^https?:\/\//i.test(attribs.href ?? "")
          ? { tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }
          : { tagName, attribs },
    },
  });
  // sanitize-html passes <style> CSS through verbatim; strip the two CSS vectors it does not:
  // @import (external fetch / privacy leak) and the legacy IE expression() JS sink. External url()
  // loads are separately blocked by the storefront CSP. The @import class excludes `<` so a rule
  // missing its `;` cannot greedily delete across a tag boundary and corrupt following markup.
  return cleaned.replace(/@import\b[^;<]*;?/gi, "").replace(/expression\s*\(/gi, "(");
}

/**
 * Sanitize every `rawHtml` block in a document. This is the invariant enforced at EVERY
 * BlockDocument persistence boundary (saveDraft, and the experiment variant_doc write) so
 * AI/merchant HTML is cleaned by code, never by author discipline. Docs with no rawHtml block —
 * and every non-rawHtml block — pass through untouched.
 */
export function sanitizeDocHtml(doc: BlockDocument): BlockDocument {
  if (!doc.blocks?.some((b) => b.type === "rawHtml")) return doc;
  return {
    ...doc,
    blocks: doc.blocks.map((b) =>
      b.type === "rawHtml"
        ? { ...b, props: { ...b.props, html: sanitizeStoreHtml((b.props as { html?: unknown }).html) } }
        : b,
    ),
  };
}
