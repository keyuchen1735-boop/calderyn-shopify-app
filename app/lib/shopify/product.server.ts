// app/lib/shopify/product.server.ts
// Discontinue / restore a Shopify product for the discontinue_sku executor.
// Same shape as inventory.server.ts: a typed AdminGraphqlClient, a GraphQL
// string, and response/userErrors checking that THROWS on failure (rule 12 —
// a failed productUpdate must never read as success). Archiving (not deleting)
// keeps the action reversible: restoreProduct flips ProductStatus back.

import type { AdminGraphqlClient } from "./inventory.server";

/** Shopify ProductStatus values we move between. We only ever set ARCHIVED
 *  (discontinue) or restore to the pre-state (typically ACTIVE/DRAFT). */
export type ShopifyProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT";

export interface ProductUpdateResult {
  productId: string;
  /** Status returned by Shopify after the write. */
  status: string;
  /** Reserved for callers that pre-read status; the write path leaves it null. */
  previousStatus: string | null;
}

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation calderynProductStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function runProductUpdate(
  admin: AdminGraphqlClient,
  productId: string,
  status: ShopifyProductStatus,
): Promise<ProductUpdateResult> {
  if (!productId) throw new Error("productUpdate called with empty product id");
  const response = await admin.graphql(PRODUCT_UPDATE, {
    variables: { product: { id: productId, status } },
  });
  const body = (await response.json()) as {
    data?: {
      productUpdate?: {
        product?: { id: string; status: string } | null;
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const payload = body.data?.productUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((e) => e.message).join("; "));
  }
  const product = payload?.product;
  if (!product?.id) {
    throw new Error("productUpdate returned no product");
  }
  return { productId: product.id, status: product.status, previousStatus: null };
}

/** Archive (and thereby hide from the online store) a product. Reversible via
 *  restoreProduct. */
export async function discontinueProduct(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<ProductUpdateResult> {
  return runProductUpdate(admin, productId, "ARCHIVED");
}

/** Restore a previously-archived product to its recorded prior status. Defaults
 *  to ACTIVE when the pre-state wasn't captured (best-effort, never DRAFT-traps
 *  a previously-live product). */
export async function restoreProduct(
  admin: AdminGraphqlClient,
  productId: string,
  priorStatus: ShopifyProductStatus = "ACTIVE",
): Promise<ProductUpdateResult> {
  return runProductUpdate(admin, productId, priorStatus);
}
