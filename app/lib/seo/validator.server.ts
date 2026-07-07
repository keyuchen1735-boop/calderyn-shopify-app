// Gate: a draft that fails here must never be served or (in Plan B) published.
// Bounds follow common SERP truncation limits; JSON-LD checks assert schema.org required fields.
import type { JsonLd, SeoDraft, SeoIssue } from "./types";

const TITLE_MIN = 10, TITLE_MAX = 60, DESC_MIN = 50, DESC_MAX = 160;

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Per-node schema.org problems. Exported so the serve path can drop exactly the
 *  invalid node(s) rather than shipping malformed structured data. */
export function jsonLdNodeIssues(node: JsonLd): string[] {
  const out: string[] = [];
  if (node["@context"] !== "https://schema.org") out.push("missing @context https://schema.org");
  if (typeof node["@type"] !== "string" || !node["@type"]) out.push("missing @type");
  if (node["@type"] === "Product") {
    if (!node.name) out.push("Product.name is required");
    const offers = node.offers as Record<string, unknown> | undefined;
    if (offers) {
      const t = offers["@type"];
      if (t === "Offer" && (!offers.price || !offers.priceCurrency || !offers.availability)) {
        out.push("Offer requires price, priceCurrency, availability");
      }
      if (t === "AggregateOffer" && (!offers.lowPrice || !offers.priceCurrency)) {
        out.push("AggregateOffer requires lowPrice, priceCurrency");
      }
    }
  }
  return out;
}

export function validateDraft(draft: SeoDraft): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const t = draft.title.trim().length;
  if (t < TITLE_MIN || t > TITLE_MAX) issues.push({ field: "title", message: `title must be ${TITLE_MIN}-${TITLE_MAX} chars (got ${t})` });
  const d = draft.description.trim().length;
  if (d < DESC_MIN || d > DESC_MAX) issues.push({ field: "description", message: `description must be ${DESC_MIN}-${DESC_MAX} chars (got ${d})` });
  if (!isAbsoluteHttpUrl(draft.canonical)) issues.push({ field: "canonical", message: "canonical must be an absolute http(s) URL" });
  if (draft.jsonLd.length === 0) issues.push({ field: "jsonLd", message: "at least one schema.org node is required" });
  for (const node of draft.jsonLd) {
    for (const msg of jsonLdNodeIssues(node)) issues.push({ field: "jsonLd", message: msg });
  }
  return issues;
}
