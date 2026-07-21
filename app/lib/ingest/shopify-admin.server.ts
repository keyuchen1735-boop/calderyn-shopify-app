import { unauthenticated } from "../../shopify.server";
import type { ShopifyFactProduct } from "./product-facts.server";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

async function adminFor(shopDomain: string): Promise<AdminClient> {
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await resp.json()) as { data?: T; errors?: unknown };
  if (body.errors) {
    throw new Error(`Admin GraphQL error: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("Admin GraphQL returned no data");
  return body.data;
}

export async function fetchLocations(shopDomain: string) {
  const admin = await adminFor(shopDomain);
  const data = await gql<{ locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> } }>(
    admin,
    `#graphql
    query Locations {
      locations(first: 100) { nodes { id name isActive } }
    }`,
  );
  return data.locations.nodes;
}

export type AdminVariant = {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryItem: {
    id: string | null;
    tracked: boolean;
    unitCost: { amount: string } | null;
    inventoryLevels: {
      nodes: Array<{ location: { id: string }; quantities: Array<{ name: string; quantity: number }> }>;
    };
  } | null;
};
export type AdminProduct = {
  id: string;
  title: string;
  status: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  featuredImage: { url: string | null } | null;
  collections: { nodes: Array<{ title: string }> };
  variants: { nodes: AdminVariant[] };
};

type ProductsPage = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminProduct[] } };

export type AdminProductFactSource = ShopifyFactProduct;
type ProductFactsPage = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminProductFactSource[] } };

export async function* fetchProductFactPages(shopDomain: string): AsyncGenerator<AdminProductFactSource[]> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data: ProductFactsPage = await gql<ProductFactsPage>(admin, `#graphql
      query ProductFacts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title
            calderynWidth: metafield(namespace: "custom", key: "calderyn_width") { id type jsonValue }
            calderynDepth: metafield(namespace: "custom", key: "calderyn_depth") { id type jsonValue }
            calderynHeight: metafield(namespace: "custom", key: "calderyn_height") { id type jsonValue }
            calderynMaterials: metafield(namespace: "custom", key: "calderyn_materials") { id type jsonValue }
            calderynCompatibility: metafield(namespace: "custom", key: "calderyn_compatibility") { id type jsonValue }
            calderynIngredients: metafield(namespace: "custom", key: "calderyn_ingredients") { id type jsonValue }
            calderynConcerns: metafield(namespace: "custom", key: "calderyn_concerns") { id type jsonValue }
            calderynHeatLevel: metafield(namespace: "custom", key: "calderyn_heat_level") { id type jsonValue }
            calderynDocumentUrl: metafield(namespace: "custom", key: "calderyn_document_url") { id type jsonValue }
            calderynArModelUrl: metafield(namespace: "custom", key: "calderyn_ar_model_url") { id type jsonValue }
          }
        }
      }`, { cursor });
    yield data.products.nodes;
    if (data.products.pageInfo.hasNextPage) {
      const nextCursor = data.products.pageInfo.endCursor;
      if (!nextCursor || nextCursor === cursor) {
        throw new Error("Shopify product fact pagination returned an invalid next cursor");
      }
      cursor = nextCursor;
    } else {
      cursor = null;
    }
  } while (cursor);
}

export async function* fetchProducts(shopDomain: string): AsyncGenerator<AdminProduct> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data: ProductsPage = await gql<ProductsPage>(
      admin,
      `#graphql
      query Products($cursor: String) {
        products(first: 25, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status vendor productType tags
            # Featured image url for the mirror->product_media promote (#13.promote):
            # hotlinked into product_media at cutover so imported products keep their
            # imagery. Null when the product has no image.
            featuredImage { url }
            # Collection membership for the inventory facet filters; first page
            # only (a product in >20 collections is truncated — acceptable for
            # facet slicing).
            collections(first: 20) { nodes { title } }
            # Slice-1 caps: page sizes kept small so the nested
            # products×variants×inventoryLevels query stays under Shopify's
            # 1000 single-query cost limit. variants/inventoryLevels are
            # single-page — products with >40 variants, or variants stocked in
            # >20 locations, are truncated; revisit if real catalogs exceed this.
            variants(first: 40) {
              nodes {
                id sku title inventoryPolicy price
                inventoryItem {
                  id tracked
                  unitCost { amount }
                  inventoryLevels(first: 20) {
                    nodes { location { id } quantities(names: ["available"]) { name quantity } }
                  }
                }
              }
            }
          }
        }
      }`,
      { cursor },
    );
    for (const node of data.products.nodes) yield node;
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
}

// Weight on a line item is not a field on LineItem itself — it lives on the
// variant's inventoryItem.measurement.weight (Admin GraphQL 2025-01+).
// The Weight object carries { value: Float, unit: WeightUnit } where WeightUnit
// is one of GRAMS | KILOGRAMS | POUNDS | OUNCES. The mapper converts to grams.
export type AdminOrderLineItemWeight = {
  value: number;
  unit: "GRAMS" | "KILOGRAMS" | "POUNDS" | "OUNCES";
} | null;

export type AdminOrder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  totalShippingPriceSet: { shopMoney: { amount: string } };
  currentTotalTaxSet: { shopMoney: { amount: string } };
  currentTotalDiscountsSet: { shopMoney: { amount: string } };
  shippingAddress: {
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    country: string | null;
    countryCodeV2: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      quantity: number;
      variant: {
        id: string;
        inventoryItem: {
          measurement: { weight: AdminOrderLineItemWeight };
        } | null;
      } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
};

type OrdersPage = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminOrder[] } };

export type AdminOrderDestination = {
  id: string;
  city: string | null;
  region: string | null;
  country: string | null;
};

const MAX_DESTINATION_BATCH_SIZE = 50;
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9]\d*$/;

/**
 * Fetch an exact batch of repair candidates without the full order payload.
 * Null nodes (deleted/inaccessible orders) are omitted; the caller has the
 * requested IDs and treats an absent node as a terminal checked result.
 */
export async function fetchOrderDestinationsByIds(
  shopDomain: string,
  ids: string[],
): Promise<AdminOrderDestination[]> {
  if (ids.length < 1 || ids.length > MAX_DESTINATION_BATCH_SIZE) {
    throw new Error(`Order destination batch must contain between 1 and ${MAX_DESTINATION_BATCH_SIZE} IDs`);
  }
  if (ids.some((id) => !SHOPIFY_ORDER_GID.test(id))) {
    throw new Error("Order destination batch contains an invalid Shopify Order GID");
  }

  const admin = await adminFor(shopDomain);
  const data = await gql<{
    nodes: Array<{
      id: string;
      shippingAddress: {
        city: string | null;
        provinceCode: string | null;
        countryCodeV2: string | null;
      } | null;
    } | null>;
  }>(
    admin,
    `#graphql
    query OrderDestinations($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          shippingAddress { city provinceCode countryCodeV2 }
        }
      }
    }`,
    { ids },
  );

  return data.nodes.flatMap((order) =>
    order
      ? [{
          id: order.id,
          city: order.shippingAddress?.city ?? null,
          region: order.shippingAddress?.provinceCode ?? null,
          country: order.shippingAddress?.countryCodeV2 ?? null,
        }]
      : [],
  );
}

export async function* fetchRecentOrders(shopDomain: string, sinceISO: string): AsyncGenerator<AdminOrder> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  const search = `created_at:>=${sinceISO}`;
  do {
    const data: OrdersPage = await gql<OrdersPage>(
      admin,
      `#graphql
      query Orders($cursor: String, $q: String!) {
        orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name createdAt updatedAt displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            currentSubtotalPriceSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            currentTotalTaxSet { shopMoney { amount } }
            currentTotalDiscountsSet { shopMoney { amount } }
            # Retain only coarse destination geography for the shipping route
            # read model. Street, postal, recipient, and contact fields are
            # intentionally not requested from Shopify.
            shippingAddress { city province provinceCode country countryCodeV2 }
            # Slice-1 cap: single-page (orders with >100 line items truncate).
            # Weight is NOT a field on LineItem — it lives on the variant's
            # inventoryItem.measurement.weight. We select unit alongside value
            # because the API returns the variant's stored unit (GRAMS,
            # KILOGRAMS, POUNDS, or OUNCES); the mapper converts to grams.
            lineItems(first: 100) {
              nodes {
                id quantity
                variant {
                  id
                  inventoryItem {
                    measurement { weight { value unit } }
                  }
                }
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }`,
      { cursor, q: search },
    );
    for (const node of data.orders.nodes) yield node;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
}

// One (Order GID, customer email) pair for the #13.customers relink pass. email is null for a
// guest / customerless order.
export type AdminOrderCustomerEmail = { id: string; email: string | null };

type OrderEmailsPage = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; customer: { email: string | null } | null }>;
  };
};

// Lightweight order->customer email walk for the #13.customers relink. Selects ONLY the Order
// GID + customer email (no line items), so the relink can resolve email->buyer_dim without
// re-pulling the heavy order payload fetchRecentOrders carries. The email stays in memory — the
// relink persists only the resolved buyer_id UUID, never the email, keeping buyer PII inside the
// buyer_* store. Requires read_customers + protected-customer-data approval, the same gate as
// fetchCustomers; without it the query errors ACCESS_DENIED (the caller only runs this pass once
// the customer stage has confirmed access, so a blocked shop never reaches here).
export async function* fetchOrderCustomerEmails(
  shopDomain: string,
  sinceISO: string,
): AsyncGenerator<AdminOrderCustomerEmail> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  const search = `created_at:>=${sinceISO}`;
  do {
    const data: OrderEmailsPage = await gql<OrderEmailsPage>(
      admin,
      `#graphql
      query OrderCustomerEmails($cursor: String, $q: String!) {
        orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { id customer { email } }
        }
      }`,
      { cursor, q: search },
    );
    for (const node of data.orders.nodes) yield { id: node.id, email: node.customer?.email ?? null };
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
}

export type AdminCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  defaultAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  emailMarketingConsent: { marketingState: string; consentUpdatedAt: string | null } | null;
};

type CustomersPage = { customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminCustomer[] } };

// Requires the read_customers scope AND Shopify's protected-customer-data
// approval (Partner Dashboard). Without them the query errors ACCESS_DENIED —
// the import stage classifies that as "blocked", never a silent skip.
export async function* fetchCustomers(shopDomain: string): AsyncGenerator<AdminCustomer> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data: CustomersPage = await gql<CustomersPage>(
      admin,
      `#graphql
      query Customers($cursor: String) {
        customers(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id email phone
            defaultAddress { name address1 address2 city province zip country phone }
            emailMarketingConsent { marketingState consentUpdatedAt }
          }
        }
      }`,
      { cursor },
    );
    for (const node of data.customers.nodes) yield node;
    cursor = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
  } while (cursor);
}
