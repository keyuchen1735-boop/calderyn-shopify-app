// Saved-view filters validation (Phase 2 Task 2): a saved view stores a flat filters blob that
// round-trips straight into the unified-list query params on load, so the shape must stay a
// subset of OrdersListParams' wire keys. Pure — no server/Supabase imports — so both the views
// route and any future client-side re-validation can share it without pulling in server code.
import { FULFILLMENT_STATUSES, SOURCES, SORTS, DIRS } from "./list-vocab";

/** Wire keys the unified list's query string accepts (see dashboard.api.orders.list.tsx) — a
 *  saved view's filters object may only use these, so a stale/renamed key never silently
 *  no-ops when the view is applied later. */
export const VIEW_FILTER_KEYS = [
  "search",
  "payment_status",
  "fulfillment_status",
  "source",
  "date_from",
  "date_to",
  "tag",
  "archived",
  "sort",
  "dir",
] as const;

const KEY_SET = new Set<string>(VIEW_FILTER_KEYS);

// Keys whose value must additionally be one of a fixed vocabulary — the SAME sets the query-param
// parser (list-params.server.ts) accepts, imported from list-vocab.ts so a saved view can never
// persist a value the list route would reject the moment it's applied.
const VOCAB_BY_KEY: Partial<Record<(typeof VIEW_FILTER_KEYS)[number], Set<string>>> = {
  fulfillment_status: FULFILLMENT_STATUSES,
  source: SOURCES,
  sort: SORTS,
  dir: DIRS,
};

// date_from/date_to aren't enum-bounded but the list route (list-params.server.ts) 422s any value
// Date.parse can't read. Gate them the same way here so a saved view can never persist a date the
// route rejects the moment the view is applied — mirroring isParseableDate.
const DATE_KEYS = new Set<string>(["date_from", "date_to"]);

function isAcceptedValue(key: string, value: unknown): boolean {
  const vocab = VOCAB_BY_KEY[key as (typeof VIEW_FILTER_KEYS)[number]];
  if (vocab) return typeof value === "string" && vocab.has(value);
  if (DATE_KEYS.has(key)) {
    return typeof value === "string" && value.length <= 200 && !Number.isNaN(Date.parse(value));
  }
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 200;
  if (Array.isArray(value)) {
    if (value.length > 10) return false;
    return value.every((entry) => typeof entry === "string" && entry.length <= 60);
  }
  return false;
}

/**
 * Validate a saved view's `filters` blob: must be a plain (non-array, non-null) object whose keys
 * are all in VIEW_FILTER_KEYS. fulfillment_status/source/sort/dir must additionally be one of the
 * exact values list-vocab.ts's enums accept; every other key's value is a string, boolean, or
 * string[]. Returns the object unchanged on success (no cloning — the caller owns it) or null on
 * any violation (unknown key, out-of-vocabulary value, nested object/array-of-non-strings,
 * non-object input) so the route can 422 rather than persist a filters blob the list route can't
 * apply.
 */
export function isValidViewFilters(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (!KEY_SET.has(key)) return null;
    if (!isAcceptedValue(key, value)) return null;
  }
  return obj;
}
