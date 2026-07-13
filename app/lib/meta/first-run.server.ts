// First-campaign wizard preflight: tells the merchant in plain terms whether
// their Meta connection is ready to create anything (connected, write scope,
// a Facebook Page, billing on file). Every check degrades to a red/neutral
// value on failure instead of throwing — the returned shape IS the answer,
// so the wizard can render guidance instead of an error boundary.
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaWriteClientForShopId, metaDraftPushEnabled, type MetaWriteConn } from "./ad-create.server";

export interface FirstRunPreflight {
  metaConnected: boolean;
  adsScope: boolean;
  pageOk: boolean;
  fundingOk: boolean | null; // null = Meta didn't tell us; UI shows a "check billing" link, never blocks
}

export async function firstRunPreflight(
  shopId: string,
  sb: SupabaseClient,
  deps?: { resolveConn?: (shopId: string) => Promise<MetaWriteConn | null> },
): Promise<FirstRunPreflight> {
  const resolveConn = deps?.resolveConn ?? metaWriteClientForShopId;

  // Connection lookup is itself a check: a transient DB/decrypt failure means
  // "not connected right now", not a 500 - same containment as the Meta reads.
  let conn: MetaWriteConn | null = null;
  try {
    conn = await resolveConn(shopId);
  } catch (err) {
    console.error("[first-run preflight] connection resolve failed", err);
    conn = null;
  }

  if (!conn) {
    return { metaConnected: false, adsScope: false, pageOk: false, fundingOk: null };
  }
  // Alias to a const so the closures below (captured by Promise.allSettled)
  // keep the narrowed non-null type — TS doesn't carry narrowing of a `let`
  // into nested function scopes.
  const activeConn = conn;

  const metaConnected = true;
  const adsScope = await metaDraftPushEnabled(sb, shopId);

  // Both reads only depend on `conn`, so run them side by side instead of
  // back to back — same contained (never-throws) semantics, half the latency.
  const [pageResult, fundingResult] = await Promise.allSettled([
    (async () => {
      const res = await activeConn.client.get(`/${activeConn.adAccountId}/promote_pages`, { fields: "id" });
      const pages = (res.data as Array<{ id?: string }> | undefined) ?? [];
      return !res.error && pages.length > 0;
    })(),
    (async () => {
      const res = await activeConn.client.get(`/${activeConn.adAccountId}`, { fields: "funding_source_details" });
      return res.error ? null : res.funding_source_details != null ? true : null;
    })(),
  ]);

  let pageOk = false;
  if (pageResult.status === "fulfilled") {
    pageOk = pageResult.value;
  } else {
    console.error("[first-run preflight] promote_pages check failed", pageResult.reason);
  }

  let fundingOk: boolean | null = null;
  if (fundingResult.status === "fulfilled") {
    fundingOk = fundingResult.value;
  } else {
    console.error("[first-run preflight] funding check failed", fundingResult.reason);
  }

  return { metaConnected, adsScope, pageOk, fundingOk };
}
