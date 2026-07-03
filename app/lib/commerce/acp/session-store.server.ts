// Persist the ACP session <-> locked-quote <-> order mapping.
// shop_id is uuid (matches live schema); order_id is uuid (orders.id).
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";

export interface AcpSession {
  sessionId: string;
  shopId: string;
  clientId: string;
  quoteId: string | null;
  orderId: string | null;
  status: string;
}

export async function createAcpSession(shopId: string, clientId: string, quoteId: string): Promise<string> {
  const sessionId = `acp_${randomBytes(16).toString("hex")}`;
  const ins = await getSupabase()
    .from("acp_session")
    .insert({ session_id: sessionId, shop_id: shopId, client_id: clientId, quote_id: quoteId, status: "open" });
  if (ins.error) throw ins.error;
  return sessionId;
}

export async function updateAcpSessionQuote(sessionId: string, quoteId: string): Promise<void> {
  const up = await getSupabase()
    .from("acp_session")
    .update({ quote_id: quoteId, updated_at: new Date().toISOString() })
    .eq("session_id", sessionId);
  if (up.error) throw up.error;
}

export async function getAcpSession(sessionId: string): Promise<AcpSession | null> {
  const res = await getSupabase()
    .from("acp_session")
    .select("session_id, shop_id, client_id, quote_id, order_id, status")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (res.error) throw res.error;
  const r = res.data as Record<string, unknown> | null;
  if (!r) return null;
  return {
    sessionId: String(r.session_id),
    shopId: String(r.shop_id),
    clientId: String(r.client_id),
    quoteId: r.quote_id ? String(r.quote_id) : null,
    orderId: r.order_id ? String(r.order_id) : null,
    status: String(r.status),
  };
}

// Atomically claim an open session for completion. The `.eq("status", "open")`
// predicate is the guard: only the first caller flips open->completing, so a
// retried or concurrent `complete` can't place+charge the same session twice.
// Returns true only for the caller that won the claim.
export async function claimAcpSessionForCompletion(sessionId: string): Promise<boolean> {
  const up = await getSupabase()
    .from("acp_session")
    .update({ status: "completing", updated_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("status", "open")
    .select("session_id");
  if (up.error) throw up.error;
  return (up.data?.length ?? 0) > 0;
}

// Release a completion claim (completing -> open) when the flow fails BEFORE any
// charge is attempted. Without this a transient cap/place failure leaves the
// session wedged in `completing` forever — the buyer is never charged, yet every
// retry loses the `.eq("status","open")` claim and gets a permanent 409. The
// `.eq("status","completing")` guard makes this a no-op on an already-completed
// session, so it can never reopen (and re-charge) a finished order. MUST NOT be
// called once a charge may have moved money: placeAgenticOrder is not idempotent,
// so a post-charge reopen would re-place + double-charge.
export async function releaseAcpSessionClaim(sessionId: string): Promise<void> {
  const up = await getSupabase()
    .from("acp_session")
    .update({ status: "open", updated_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("status", "completing");
  if (up.error) throw up.error;
}

export async function completeAcpSession(sessionId: string, orderId: string): Promise<void> {
  const up = await getSupabase()
    .from("acp_session")
    .update({ order_id: orderId, status: "completed", updated_at: new Date().toISOString() })
    .eq("session_id", sessionId);
  if (up.error) throw up.error;
}
