// app/lib/shopify/price.server.ts
// Read/write a Shopify variant's selling price for the adjust_price executor.
// Same shape as inventory.server.ts / product.server.ts: a typed
// AdminGraphqlClient, a GraphQL string, and response/userErrors checking that
// THROWS on failure (rule 12 — a failed price write must never read as success).
// October25 Admin API: productVariantsBulkUpdate (productVariantUpdate is removed).
// Price is a Money scalar — a decimal string ("17.25"), not cents.

import type { AdminGraphqlClient } from "./inventory.server";

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

function assertVariantGid(value: string): void {
  if (!VARIANT_GID.test(value)) {
    throw new Error(
      `adjust_price: variantId must be a gid://shopify/ProductVariant/<id> (got "${value}")`,
    );
  }
}

/** Cents → Shopify Money decimal string, e.g. 1725 → "17.25". */
function centsToMoney(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** Money decimal string → cents, e.g. "17.25" → 1725. */
function moneyToCents(money: string): number {
  return Math.round(Number(money) * 100);
}

export interface VariantPrice {
  priceCents: number;
  /** The variant's parent Product GID — productVariantsBulkUpdate needs it. */
  productGid: string;
}

const READ_QUERY = /* GraphQL */ `
  query calderynVariantPrice($id: ID!) {
    productVariant(id: $id) {
      id
      price
      product {
        id
      }
    }
  }
`;

/** Current price (cents) + product gid for a variant. Throws on a missing
 *  variant or a malformed price so the executor never proceeds blind. */
export async function readVariantPrice(
  admin: AdminGraphqlClient,
  variantId: string,
): Promise<VariantPrice> {
  assertVariantGid(variantId);
  const response = await admin.graphql(READ_QUERY, { variables: { id: variantId } });
  const body = (await response.json()) as {
    data?: {
      productVariant?: {
        id: string;
        price?: string | null;
        product?: { id: string } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const v = body.data?.productVariant;
  if (!v?.id) throw new Error(`variant ${variantId} not found`);
  const priceCents = moneyToCents(String(v.price ?? ""));
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    throw new Error(`variant ${variantId} has no usable price (got "${v.price}")`);
  }
  const productGid = v.product?.id;
  if (!productGid) throw new Error(`variant ${variantId} has no parent product`);
  return { priceCents, productGid };
}

const BULK_UPDATE = /* GraphQL */ `
  mutation calderynVariantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface SetVariantPriceInput {
  productGid: string;
  variantId: string;
  newPriceCents: number;
}

export interface SetVariantPriceResult {
  variantId: string;
  /** Price Shopify echoed back, in cents. */
  priceCents: number;
}

/** Set a single variant's price via productVariantsBulkUpdate. Throws on
 *  userErrors/transport errors (rule 12). */
export async function setVariantPrice(
  admin: AdminGraphqlClient,
  input: SetVariantPriceInput,
): Promise<SetVariantPriceResult> {
  assertVariantGid(input.variantId);
  if (!input.productGid) throw new Error("adjust_price: missing productId");
  if (!Number.isFinite(input.newPriceCents) || input.newPriceCents <= 0) {
    throw new Error(`adjust_price: newPriceCents must be a positive number (got ${input.newPriceCents})`);
  }
  const response = await admin.graphql(BULK_UPDATE, {
    variables: {
      productId: input.productGid,
      variants: [{ id: input.variantId, price: centsToMoney(input.newPriceCents) }],
    },
  });
  const body = (await response.json()) as {
    data?: {
      productVariantsBulkUpdate?: {
        productVariants?: Array<{ id: string; price: string }> | null;
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const payload = body.data?.productVariantsBulkUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((e) => e.message).join("; "));
  }
  const updated = payload?.productVariants?.find((p) => p.id === input.variantId);
  if (!updated) throw new Error("productVariantsBulkUpdate returned no variant");
  return { variantId: updated.id, priceCents: moneyToCents(updated.price) };
}
