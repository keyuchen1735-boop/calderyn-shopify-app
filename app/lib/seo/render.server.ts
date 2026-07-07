// Turn a validated SeoDraft into Remix meta descriptors. Remix 2.17 serializes the special
// "script:ld+json" descriptor into a <script type="application/ld+json"> tag in <head>.
import type { MetaDescriptor } from "@remix-run/node";
import type { SeoDraft } from "./types";
import { validateDraft, jsonLdNodeIssues } from "./validator.server";

export function metaFromDraft(draft: SeoDraft): MetaDescriptor[] {
  const out: MetaDescriptor[] = [
    { title: draft.title },
    { name: "description", content: draft.description },
    { tagName: "link", rel: "canonical", href: draft.canonical },
    { property: "og:title", content: draft.title },
    { property: "og:description", content: draft.description },
    { property: "og:type", content: draft.ogType },
    { property: "og:url", content: draft.canonical },
  ];
  if (draft.ogImage) out.push({ property: "og:image", content: draft.ogImage });
  out.push({ name: "twitter:card", content: draft.ogImage ? "summary_large_image" : "summary" });
  for (const node of draft.jsonLd) out.push({ "script:ld+json": node });
  return out;
}

/**
 * Serve-path meta builder: invalid structured data must never ship. If the draft
 * has any JSON-LD problem, drop only the offending node(s) and serve the valid
 * meta tags plus any remaining valid schema (e.g. an empty Product.name is
 * stripped, but title/description/canonical/OG tags still render). Title and
 * description bounds are advisory (scored, not gated), so the tags always ship.
 */
export function safeMetaFromDraft(draft: SeoDraft): MetaDescriptor[] {
  if (!validateDraft(draft).some((i) => i.field === "jsonLd")) return metaFromDraft(draft);
  const jsonLd = draft.jsonLd.filter((node) => jsonLdNodeIssues(node).length === 0);
  return metaFromDraft({ ...draft, jsonLd });
}
