// Import-from-Shopify: order<->customer relink (#13.customers). The final honest step of the
// import. After the customer stage populated buyer_dim (the PII store) and the promote
// materialized imported_order, this connects each promoted order to its buyer by matching the
// order's Shopify customer email to buyer_dim.email_normalized.
//
// PII invariant: only the buyer_id UUID is written onto imported_order — the customer email is
// resolved IN MEMORY and never persisted outside the buyer_* store (order_fact / imported_order
// hold no buyer PII). The email-bearing order query is protected-customer-data gated, so the
// caller runs this pass only when the customer stage confirmed access (customers.blocked === false);
// a blocked shop imported no buyers and this pass is skipped rather than ACCESS_DENIED-ing.
//
// Idempotent: every UPDATE fills only a NULL buyer_id, so a re-run matches the same orders to the
// same buyers and writes nothing new. Counts are read from imported_order state after the writes,
// so they are stable across re-runs and can never overstate what was linked (rule 12).
import { fetchOrderCustomerEmails } from "../ingest/shopify-admin.server";
import { getSupabase } from "../supabase.server";
import { normalizeEmail } from "../buyer/identity.server";

export interface RelinkResult {
  /** Promoted orders now attributed to a re-pulled customer. */
  linked: number;
  /** Promoted orders with no linkable customer (guest checkout, or customer not imported). */
  unmatched: number;
}

export async function relinkOrdersToBuyers(
  shopDomain: string,
  shopId: string,
  sinceISO: string,
): Promise<RelinkResult> {
  const sb = getSupabase();

  // 1) Walk (Order GID -> normalized customer email). The email lives only in this map.
  const emailByOrder = new Map<string, string>();
  for await (const o of fetchOrderCustomerEmails(shopDomain, sinceISO)) {
    if (!o.email) continue;
    let normalized: string;
    try {
      normalized = normalizeEmail(o.email);
    } catch {
      continue; // unusable email — not a linkable customer
    }
    emailByOrder.set(o.id, normalized);
  }

  // 2) Resolve the distinct emails to buyer_dim ids in one shop-scoped lookup.
  const emails = [...new Set(emailByOrder.values())];
  const buyerByEmail = new Map<string, string>();
  if (emails.length) {
    const { data, error } = await sb
      .from("buyer_dim")
      .select("id, email_normalized")
      .eq("shop_id", shopId)
      .in("email_normalized", emails);
    if (error) throw error;
    for (const r of data ?? []) buyerByEmail.set(String(r.email_normalized), String(r.id));
  }

  // 3) Group orders by resolved buyer, then one UPDATE per buyer. `is('buyer_id', null)` makes each
  //    write fill-only, so a re-run converges and a manually-relinked order is never overwritten.
  const ordersByBuyer = new Map<string, string[]>();
  for (const [gid, email] of emailByOrder) {
    const buyerId = buyerByEmail.get(email);
    if (!buyerId) continue;
    const gids = ordersByBuyer.get(buyerId) ?? [];
    gids.push(gid);
    ordersByBuyer.set(buyerId, gids);
  }
  for (const [buyerId, gids] of ordersByBuyer) {
    const { error } = await sb
      .from("imported_order")
      .update({ buyer_id: buyerId })
      .eq("shop_id", shopId)
      .in("external_id", gids)
      .is("buyer_id", null);
    if (error) throw error;
  }

  // 4) Honest counts from post-write state (rule 12): linked + unmatched == promoted orders.
  const linked = await countImportedOrders(shopId, true);
  const unmatched = await countImportedOrders(shopId, false);
  return { linked, unmatched };
}

/** Count this shop's imported_order rows that are (linked) / are not (unmatched) tied to a buyer. */
async function countImportedOrders(shopId: string, linked: boolean): Promise<number> {
  const base = getSupabase()
    .from("imported_order")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId);
  const { count, error } = await (linked ? base.not("buyer_id", "is", null) : base.is("buyer_id", null));
  if (error) throw error;
  return count ?? 0;
}
