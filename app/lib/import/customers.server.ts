// Import-from-Shopify: the customer stage. Shopify customers land in the buyer
// PII store (buyer_dim / buyer_address / buyer_consent) — DELIBERATELY outside
// the analytics warehouse, via the same identity helpers the storefront uses.
// Requires read_customers + Shopify's protected-customer-data approval; until
// granted the stage reports itself blocked (visible in the import report),
// never silently empty.
import { fetchCustomers, type AdminCustomer } from "../ingest/shopify-admin.server";
import { getSupabase } from "../supabase.server";
import { upsertGuestBuyer, addBuyerAddress, recordConsent } from "../buyer/identity.server";

export interface CustomerImportResult {
  imported: number;
  skipped: number; // customers with no usable email — buyer identity is email-keyed
  blocked: boolean; // protected-customer-data access not granted yet
}

function isAccessDenied(err: unknown): boolean {
  return err instanceof Error && err.message.includes("ACCESS_DENIED");
}

async function hasShippingAddress(shopId: string, buyerId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("buyer_address")
    .select("id")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("kind", "shipping")
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function importOne(shopId: string, c: AdminCustomer): Promise<void> {
  const buyer = await upsertGuestBuyer(shopId, { email: c.email as string, phone: c.phone ?? undefined });

  const a = c.defaultAddress;
  // addBuyerAddress INSERTS (append) — only add when the buyer has no shipping
  // address yet, so a re-import doesn't stack duplicates. line1+country are the
  // helper's presence guard; an address without them is unusable anyway.
  if (a?.address1 && a.country && !(await hasShippingAddress(shopId, buyer.id))) {
    await addBuyerAddress(shopId, buyer.id, {
      kind: "shipping",
      isDefault: true,
      name: a.name,
      line1: a.address1,
      line2: a.address2,
      city: a.city,
      region: a.province,
      postal: a.zip,
      country: a.country,
      phone: a.phone,
    });
  }

  // Marketing consent: only explicit states carry over; PENDING/INVALID/unknown
  // record nothing. Version stamps the provenance so the append-only consent
  // ledger shows this row came from the Shopify port, dated by Shopify's own
  // consent timestamp when it has one.
  const state = c.emailMarketingConsent?.marketingState;
  if (state === "SUBSCRIBED" || state === "UNSUBSCRIBED") {
    await recordConsent(shopId, buyer.id, {
      policy: "marketing",
      version: "shopify-import-2026-07",
      accepted: state === "SUBSCRIBED",
      capturedAt: c.emailMarketingConsent?.consentUpdatedAt ?? undefined,
    });
  }
}

export async function importCustomers(shopDomain: string, shopId: string): Promise<CustomerImportResult> {
  const result: CustomerImportResult = { imported: 0, skipped: 0, blocked: false };
  try {
    for await (const c of fetchCustomers(shopDomain)) {
      if (!c.email || !c.email.includes("@")) {
        result.skipped += 1;
        continue;
      }
      await importOne(shopId, c);
      result.imported += 1;
    }
  } catch (err) {
    if (isAccessDenied(err)) return { ...result, blocked: true };
    throw err; // anything else fails the run visibly (state='error')
  }
  return result;
}
