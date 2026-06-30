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

export async function completeAcpSession(sessionId: string, orderId: string): Promise<void> {
  const up = await getSupabase()
    .from("acp_session")
    .update({ order_id: orderId, status: "completed", updated_at: new Date().toISOString() })
    .eq("session_id", sessionId);
  if (up.error) throw up.error;
}
