// app/lib/commerce/shopify-shop-address.server.ts
// Fetches the shop's billing address from the Shopify Admin API using the
// offline-session client pattern (unauthenticated.admin) already established
// in app/lib/ingest/shopify-admin.server.ts. Requires a shopId → shopDomain
// lookup from the shops table first.
//
// Returns Address | null. null means "could not obtain a usable address" —
// missing offline session, API error, or incomplete billingAddress fields.
// The caller (getShopOrigin) decides if null is fatal.

import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getSupabase } from "~/lib/supabase.server";
// NOTE: unauthenticated is imported lazily inside fetchShopifyShopAddress (not
// at module top-level) because shopify.server.ts calls shopifyApp() synchronously
// at load time and throws when SHOPIFY_API_SECRET is absent (e.g. in tests).
// Same pattern used by backfillShop in shopify.server.ts afterAuth hook.

// Per-process cache: shopId → shopDomain (immutable once provisioned, safe to memoize).
const domainCache = new Map<string, string>();

async function resolveShopDomain(shopId: string): Promise<string | null> {
  const cached = domainCache.get(shopId);
  if (cached) return cached;

  const { data, error } = await getSupabase()
    .from("shops")
    .select("shop_domain")
    .eq("id", shopId)
    .maybeSingle();
  if (error || !data?.shop_domain) return null;
  domainCache.set(shopId, data.shop_domain);
  return data.shop_domain;
}

const BILLING_ADDRESS_QUERY = /* GraphQL */ `
  {
    shop {
      billingAddress {
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
      }
    }
  }
`;

/**
 * Pull the shop's billing address from Shopify Admin GraphQL.
 * Uses the unauthenticated offline-session client (same pattern as
 * app/lib/ingest/shopify-admin.server.ts — requires expiringOfflineAccessTokens).
 *
 * Returns null when:
 * - shopId cannot be resolved to a shop_domain (shop not provisioned)
 * - no offline session exists yet (merchant hasn't installed the app)
 * - the billingAddress is missing required fields (street1, city, state, zip, country)
 * - any network/API error occurs
 *
 * Caching is handled by the caller (getShopOrigin upserts the result into shop_origin).
 */
export async function fetchShopifyShopAddress(shopId: string): Promise<Address | null> {
  try {
    const shopDomain = await resolveShopDomain(shopId);
    if (!shopDomain) return null;

    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const resp = await admin.graphql(BILLING_ADDRESS_QUERY);
    const body = (await resp.json()) as {
      data?: {
        shop?: {
          billingAddress?: {
            address1?: string | null;
            address2?: string | null;
            city?: string | null;
            provinceCode?: string | null;
            zip?: string | null;
            countryCodeV2?: string | null;
          } | null;
        } | null;
      };
      errors?: unknown;
    };

    const ba = body.data?.shop?.billingAddress;
    if (!ba) return null;

    const { address1, address2, city, provinceCode, zip, countryCodeV2 } = ba;
    // All five required Address fields must be present; return null otherwise
    // so the caller falls through to require-setup (never quote from a partial address).
    if (!address1 || !city || !provinceCode || !zip || !countryCodeV2) return null;

    return {
      street1: address1,
      ...(address2 ? { street2: address2 } : {}),
      city,
      state: provinceCode,
      zip,
      country: countryCodeV2,
    };
  } catch {
    // Any error (no offline session, API down, bad token) → null.
    // The caller's require-setup path is the safety net.
    return null;
  }
}
