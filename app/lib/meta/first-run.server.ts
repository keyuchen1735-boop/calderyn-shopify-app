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
  } catch {
    conn = null;
  }

  if (!conn) {
    return { metaConnected: false, adsScope: false, pageOk: false, fundingOk: null };
  }

  const metaConnected = true;
  const adsScope = await metaDraftPushEnabled(sb, shopId);

  let pageOk = false;
  try {
    const res = await conn.client.get(`/${conn.adAccountId}/promote_pages`, { fields: "id" });
    const pages = (res.data as Array<{ id?: string }> | undefined) ?? [];
    pageOk = !res.error && pages.length > 0;
  } catch {
    pageOk = false;
  }

  let fundingOk: boolean | null = null;
  try {
    const res = await conn.client.get(`/${conn.adAccountId}`, { fields: "funding_source_details" });
    fundingOk = res.error ? null : res.funding_source_details != null ? true : null;
  } catch {
    fundingOk = null;
  }

  return { metaConnected, adsScope, pageOk, fundingOk };
}
