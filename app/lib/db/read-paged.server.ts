// app/lib/db/read-paged.server.ts
// Shared window-read pager for Supabase reads that can exceed PostgREST's
// clamp: any single response is capped at its max-rows setting (1,000 on
// Supabase) REGARDLESS of .limit(), so reaching a caller's explicit cap
// requires walking .range() pages. Used by analytics/commerce.server.ts and
// experiments/store-experiment.server.ts (identical shape, now consolidated).
const PAGE = 1000;

/**
 * Page through `fetchPage` up to `cap` rows, threaded by shopId (callers scope
 * their own query). Degrades to a floor with a console.warn instead of
 * failing the screen when the window truly exceeds the cap — but a run of
 * full pages up to the cap alone doesn't prove that (the true count could
 * land exactly on it), so the warn only fires after a one-row probe just past
 * the cap confirms there's a row beyond it (never a false alarm).
 */
export async function readPaged<T>(
  label: string,
  shopId: string,
  cap: number,
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await fetchPage(from, Math.min(from + PAGE, cap) - 1);
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows; // short page = window exhausted
  }
  const { data: probe, error: probeError } = await fetchPage(cap, cap);
  if (probeError) throw new Error(`${label} read failed: ${probeError.message}`);
  if (((probe ?? []) as T[]).length > 0) {
    console.warn(`[read-paged] ${label} window capped at ${cap} rows for shop ${shopId}; results under-report`);
  }
  return rows;
}
