// Shared PostgREST pagination for the cutover modules. PostgREST silently truncates
// unbounded selects at 1000 rows, so every read pages explicitly until a short page.
// The MAX_PAGES cap is a visible-failure backstop (rule 12), far above any real shop,
// never a silent truncation. One copy here so the go-live gates and the drift report
// can never disagree about what a "complete" row set is.

import { getSupabase } from "~/lib/supabase.server";

export const PAGE = 1000;
export const MAX_PAGES = 200;

export interface PagedFilter {
  /** Column that must be non-null (e.g. external_id — the Shopify-originated rows). */
  notNull?: string;
  eq?: Record<string, string | boolean>;
}

/** Page through `select columns from table where shop_id = ...` and return every row.
 *  Ordered by `orderBy` so pages are stable. */
export async function pagedRows(
  shopId: string,
  table: string,
  columns: string,
  orderBy: string[],
  filter?: PagedFilter,
): Promise<Array<Record<string, unknown>>> {
  const sb = getSupabase();
  const out: Array<Record<string, unknown>> = [];
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(
        `cutover paged read: ${table} exceeded ${MAX_PAGES * PAGE} rows for shop ${shopId}; refusing to use a truncated set`,
      );
    }
    let q = sb.from(table).select(columns).eq("shop_id", shopId);
    if (filter?.notNull) q = q.not(filter.notNull, "is", null);
    for (const [col, val] of Object.entries(filter?.eq ?? {})) q = q.eq(col, val);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}
