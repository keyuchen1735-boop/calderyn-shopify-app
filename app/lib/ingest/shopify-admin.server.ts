import { unauthenticated } from "../../shopify.server";

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
  inventoryItem: {
    id: string | null;
    unitCost: { amount: string } | null;
    inventoryLevels: {
      nodes: Array<{ location: { id: string }; quantities: Array<{ name: string; quantity: number }> }>;
    };
  } | null;
};
export type AdminProduct = { id: string; title: string; variants: { nodes: AdminVariant[] } };

type ProductsPage = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminProduct[] } };

export async function* fetchProducts(shopDomain: string): AsyncGenerator<AdminProduct> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data: ProductsPage = await gql<ProductsPage>(
      admin,
      `#graphql
      query Products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title
            # Slice-1 cap: variants/inventoryLevels are single-page (not
            # paginated). Products with >100 variants or variants stocked in
            # >50 locations are truncated; revisit if real catalogs exceed this.
            variants(first: 100) {
              nodes {
                id sku title
                inventoryItem {
                  id
                  unitCost { amount }
                  inventoryLevels(first: 50) {
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
  lineItems: {
    nodes: Array<{
      id: string;
      quantity: number;
      variant: { id: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
};

type OrdersPage = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminOrder[] } };

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
            # Slice-1 cap: single-page (orders with >100 line items truncate).
            lineItems(first: 100) {
              nodes { id quantity variant { id } originalUnitPriceSet { shopMoney { amount } } }
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
