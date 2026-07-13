// Meta's call_to_action.type is an enum, not free text — an ad create with an
// unknown value is rejected by the Graph API. This browser-safe module is the
// single source for the wizard's allowed CTA values: the first-run parser
// normalizes against it server-side (the real guard) and the wizard offers the
// same list in its CTA input so hand-typed values aren't a trap.

/** The Meta call_to_action types the first-run wizard supports. */
export const META_CTA_TYPES = [
  "SHOP_NOW",
  "LEARN_MORE",
  "SIGN_UP",
  "SUBSCRIBE",
  "GET_OFFER",
  "BUY_NOW",
  "ORDER_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_QUOTE",
  "APPLY_NOW",
  "BOOK_TRAVEL",
] as const;

const META_CTA_SET: ReadonlySet<string> = new Set(META_CTA_TYPES);

/**
 * Normalize a free-text CTA to a valid Meta call_to_action type: trim,
 * uppercase, spaces → underscores, then whitelist. Anything unrecognized
 * (including AI-generated free text) becomes SHOP_NOW rather than a Graph
 * API rejection at create time.
 */
export function normalizeMetaCta(raw: string): string {
  const candidate = raw.trim().toUpperCase().replace(/\s+/g, "_");
  return META_CTA_SET.has(candidate) ? candidate : "SHOP_NOW";
}
