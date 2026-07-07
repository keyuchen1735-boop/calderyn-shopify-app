// Turn a validated SeoDraft into Remix meta descriptors. Remix 2.17 serializes the special
// "script:ld+json" descriptor into a <script type="application/ld+json"> tag in <head>.
import type { MetaDescriptor } from "@remix-run/node";
import type { SeoDraft } from "./types";

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
