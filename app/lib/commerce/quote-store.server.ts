// Persist a LOCKED quote into commerce_quote_fact (append-only) and read it back. A locked
// quote never re-prices: getQuote returns the stored totals verbatim, or null once expired so
// the caller must re-quote (never silently charge a stale price). 15-minute TTL.
import { getSupabase } from "~/lib/supabase.server";
import type { CartQuote } from "./types";

const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface LockedQuote extends CartQuote {
  quoteId: string;
  expiresAt: string;
}

export async function lockQuote(
  shopId: string,
  quote: CartQuote,
  meta: { clientId?: string | null; destinationHash: string; expiresInMs?: number },
): Promise<{ quoteId: string; expiresAt: string }> {
  if (!shopId) throw new Error("shopId is required");
  const expiresAt = new Date(Date.now() + (meta.expiresInMs ?? QUOTE_TTL_MS)).toISOString();
  const ins = await getSupabase()
    .from("commerce_quote_fact")
    .insert({
      shop_id: shopId,
      client_id: meta.clientId ?? null,
      line_items: quote.lines,
      subtotal_cents: quote.subtotalCents,
      shipping_cents: quote.shippingCents,
      tax_cents: quote.taxCents,
      total_cents: quote.totalCents,
      currency: quote.currency,
      destination_hash: meta.destinationHash,
      low_confidence: quote.lowConfidence,
      fallback_used: quote.fallbackUsed,
      delivery_earliest: quote.deliveryEarliest,
      delivery_latest: quote.deliveryLatest,
      expires_at: expiresAt,
    })
    .select("quote_id, expires_at")
    .single();
  if (ins.error) throw ins.error;
  if (!ins.data) throw new Error("commerce_quote_fact insert returned no row");
  return { quoteId: String((ins.data as Record<string, unknown>).quote_id), expiresAt };
}

export async function getQuote(shopId: string, quoteId: string): Promise<LockedQuote | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!quoteId) return null;
  const row = await getSupabase()
    .from("commerce_quote_fact")
    .select("quote_id, line_items, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, low_confidence, fallback_used, delivery_earliest, delivery_latest, expires_at")
    .eq("shop_id", shopId)
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (row.error) throw row.error;
  const r = row.data as Record<string, unknown> | null;
  if (!r) return null;
  if (Date.parse(String(r.expires_at)) <= Date.now()) return null; // expired -> re-quote
  return {
    quoteId: String(r.quote_id),
    lines: r.line_items as LockedQuote["lines"],
    subtotalCents: Number(r.subtotal_cents),
    shippingCents: Number(r.shipping_cents),
    taxCents: Number(r.tax_cents),
    totalCents: Number(r.total_cents),
    currency: String(r.currency),
    deliveryEarliest: r.delivery_earliest == null ? null : String(r.delivery_earliest),
    deliveryLatest: r.delivery_latest == null ? null : String(r.delivery_latest),
    lowConfidence: Boolean(r.low_confidence),
    fallbackUsed: Boolean(r.fallback_used),
    expiresAt: String(r.expires_at),
  };
}
