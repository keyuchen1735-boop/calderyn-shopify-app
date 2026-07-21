// Deterministic backstop against unhonorable generated copy (designer
// flagship spec D5). The prompt already forbids invented offers; this pass
// catches the obvious shapes that slip through anyway — a percent-off or
// promo-code offer, or a "free shipping over $N" threshold — whenever the
// number or code wasn't supplied by the merchant or the build context.
// Deliberately a targeted check, not a general copy linter: the full
// claims/link audit is a later phase.

export interface UnhonorableClaim {
  kind: "percent-off" | "promo-code" | "free-shipping-threshold";
  /** The matched copy, verbatim, for the repair instruction. */
  excerpt: string;
}

const PERCENT_OFF_RE = /\b(\d{1,2})\s*(?:%|percent)\s+off\b/gi;
// "use code SPRING24" / "with code VIP" — an uppercase-ish token after the
// word "code" is the promo-code shape; prose uses of "code" don't match.
const PROMO_CODE_RE = /\bcode[:\s]+([A-Z][A-Z0-9]{3,11})\b/g;
const FREE_SHIPPING_RE = /\bfree\s+shipping\s+(?:on\s+)?(?:all\s+)?(?:orders?\s+)?(?:over|above|from)\s*\$?\s*(\d{1,4})\b/gi;
// The declared cart-meter threshold makes the same promise as the copy.
const FREE_SHIPPING_ATTR_RE = /\bdata-designer-free-shipping\s*=\s*"(\d{1,4})"/gi;

function factsContainNumber(facts: string, value: string): boolean {
  return new RegExp(`\\b${value}\\b`).test(facts);
}

/** Flags obviously unhonorable offer copy in one page's html. A claim whose
 *  number or code appears in `providedFacts` (the merchant's own words plus
 *  any configured policy facts) is treated as supplied and passes. */
export function findUnhonorableClaims(html: string, opts?: { providedFacts?: string }): UnhonorableClaim[] {
  const facts = opts?.providedFacts ?? "";
  const factsUpper = facts.toUpperCase();
  const found: UnhonorableClaim[] = [];
  const seen = new Set<string>();
  const add = (kind: UnhonorableClaim["kind"], excerpt: string) => {
    const key = `${kind}:${excerpt.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, excerpt });
  };

  for (const match of html.matchAll(PERCENT_OFF_RE)) {
    if (!factsContainNumber(facts, match[1])) add("percent-off", match[0]);
  }
  for (const match of html.matchAll(PROMO_CODE_RE)) {
    if (!factsUpper.includes(match[1].toUpperCase())) add("promo-code", match[0]);
  }
  for (const re of [FREE_SHIPPING_RE, FREE_SHIPPING_ATTR_RE]) {
    for (const match of html.matchAll(re)) {
      if (!factsContainNumber(facts, match[1])) add("free-shipping-threshold", match[0]);
    }
  }
  return found;
}

/** One repair instruction covering every finding, phrased for the review
 *  pass. Empty string when the page is clean. */
export function claimsRepairInstruction(claims: UnhonorableClaim[]): string {
  if (claims.length === 0) return "";
  const list = claims.map((claim) => `"${claim.excerpt}"`).join(", ");
  return `DETERMINISTIC AUDIT — this store has no discount codes and no configured shipping threshold backing these, so each is a promise the platform cannot keep: ${list}. Remove each offer or replace it with number-free copy that promises nothing specific.`;
}
