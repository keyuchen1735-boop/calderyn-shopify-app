// app/lib/screener/product-creative.server.ts
// Pure builder: turns a catalog product into the CreativeInput shape the
// screener's scorer/generator gate operates on. Used by the first-campaign
// wizard to seed both the manual-edit defaults and the generation request.
import type { CreativeInput } from "./types";

const HEADLINE_MAX_CHARS = 40;
const PRIMARY_TEXT_TARGET_CHARS = 125;
const DEFAULT_PRIMARY_TEXT = "Now available at our store.";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

export function buildProductCreative(p: {
  title: string;
  description: string | null;
  imageUrl: string | null;
  productUrl: string;
  price: string | null;
}): CreativeInput {
  const headline = truncate(p.title.trim(), HEADLINE_MAX_CHARS);
  const description = (p.description ?? "").trim();
  const base = description ? truncate(description, PRIMARY_TEXT_TARGET_CHARS) : DEFAULT_PRIMARY_TEXT;
  const price = p.price?.trim();
  const primaryText = price ? `${base} ${price}.` : base;

  return {
    imageUrl: p.imageUrl,
    mediaKind: p.imageUrl ? "image" : null,
    headline,
    primaryText,
    cta: "SHOP_NOW",
    destinationUrl: p.productUrl,
    audience: "",
  };
}
