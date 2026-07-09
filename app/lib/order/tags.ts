// Order-tag normalization (Task 10): pure validation/shaping logic for the full-replace tags
// contract, pulled out of the route so it's unit-testable and reusable without a Supabase client
// (no server-only imports here — safe to import from anywhere, same convention as detail-types.ts).

export const MAX_ORDER_TAGS = 20;

/**
 * trim + lowercase + 1-60 chars + dedupe, in first-seen order. Returns null (reject) on any raw
 * entry that isn't a non-empty string in range, or on more than MAX_ORDER_TAGS after dedupe — a
 * full replace is all-or-nothing, never a partial silent drop.
 */
export function normalizeOrderTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    const tag = entry.trim().toLowerCase();
    if (tag.length < 1 || tag.length > 60) return null;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  if (out.length > MAX_ORDER_TAGS) return null;
  return out;
}
