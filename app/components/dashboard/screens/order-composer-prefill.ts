// Encodes/parses the composer's replacement-order prefill as the "orders" screen's nav.param,
// so opening the composer from a closed return's "Create replacement order" button is a normal
// deep-linkable URL (/dashboard/orders/new_<orderId>_<returnId>) rather than sessionStorage or
// router-state handoff — a refresh re-parses the same URL and re-fetches by id, so nothing is
// lost across a reload (the "smallest mechanism, robust to refresh" the plan asked for).
//
// Reuses the SAME reserved-param idiom Orders.tsx already has for a from-scratch composer visit
// (nav.param === "new"): this is just "new" with two uuids appended, so the existing bare-"new"
// check and this one can never collide (a bare "new" never starts with "new_").
const PREFIX = "new_";

export interface ComposerPrefillParam {
  orderId: string;
  returnId: string;
}

/** "new_<orderId>_<returnId>" — safe as a single path segment (uuids are hex+dash only, so the
 *  "_" separators can never be ambiguous with either id). */
export function buildPrefillParam(orderId: string, returnId: string): string {
  return `${PREFIX}${orderId}_${returnId}`;
}

/** True for any prefilled composer param (including a malformed one) — Orders.tsx uses this,
 *  not a bare `=== "new"` check, to decide whether to route to the composer at all. */
export function isPrefillParam(raw: string): boolean {
  return raw.startsWith(PREFIX);
}

/** Parses a prefill param built by buildPrefillParam. Returns null for a bare "new" (no prefill)
 *  or a malformed/truncated value, so the composer can fall back to a blank draft rather than
 *  throwing on a hand-edited or stale URL. */
export function parsePrefillParam(raw: string): ComposerPrefillParam | null {
  if (!raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return { orderId: rest.slice(0, sep), returnId: rest.slice(sep + 1) };
}
