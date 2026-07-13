// Shared enum vocabularies for the unified orders list's query params (fulfillment_status,
// source, sort, dir). Pure — no server import — so both the server-side query-param parser
// (list-params.server.ts) and the client-shareable saved-view filter validator (view-filters.ts,
// deliberately kept server-free) enforce the identical vocabulary from one place instead of
// duplicating it and risking drift.

export const FULFILLMENT_STATUSES = new Set(["unfulfilled", "partially_fulfilled", "fulfilled"]);
export const SOURCES = new Set(["calderyn", "shopify"]);
export const SORTS = new Set(["date", "total", "customer"]);
export const DIRS = new Set(["asc", "desc"]);
