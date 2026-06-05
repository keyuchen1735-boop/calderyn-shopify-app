// app/lib/simulator/fetch-pages.server.ts
import type { unauthenticated as _unauthenticated } from "../../shopify.server";
import { htmlToText } from "./html-to-text";
import type { StoreSnapshot } from "./types";

type AdminClient = Awaited<ReturnType<typeof _unauthenticated.admin>>["admin"];

export interface FetchDeps {
  fetchImpl: typeof fetch;
  admin: Pick<AdminClient, "graphql">;
}

const DEFAULT_SHIPPING = { amount: 7.95, currency: "USD", estimated: true } as const;

const SHIPPING_QUERY = `#graphql
  query SimShippingRates {
    deliveryProfiles(first: 1) {
      nodes {
        profileLocationGroups {
          locationGroupZones(first: 5) {
            nodes {
              methodDefinitions(first: 10) {
                nodes {
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { price { amount currencyCode } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

// Hand-typed (this repo types Admin responses by hand — see ingest/shopify-admin.server.ts).
type ShippingData = {
  deliveryProfiles: {
    nodes: Array<{
      profileLocationGroups: Array<{
        locationGroupZones: {
          nodes: Array<{
            methodDefinitions: {
              nodes: Array<{
                active: boolean;
                rateProvider:
                  | { __typename: "DeliveryRateDefinition"; price: { amount: string; currencyCode: string } }
                  | { __typename: string };
              }>;
            };
          }>;
        };
      }>;
    }>;
  };
};

/** Lowest active flat-rate shipping price, or a labeled estimate. Pure (unit-tested). */
export function pickShippingRate(data: ShippingData): StoreSnapshot["shipping"] {
  const rates: Array<{ amount: number; currency: string }> = [];
  for (const profile of data.deliveryProfiles.nodes) {
    for (const group of profile.profileLocationGroups) {
      for (const zone of group.locationGroupZones.nodes) {
        for (const md of zone.methodDefinitions.nodes) {
          const rp = md.rateProvider;
          if (md.active && rp.__typename === "DeliveryRateDefinition") {
            const price = (rp as { price: { amount: string; currencyCode: string } }).price;
            rates.push({ amount: Number(price.amount), currency: price.currencyCode });
          }
        }
      }
    }
  }
  if (rates.length === 0) return { ...DEFAULT_SHIPPING };
  rates.sort((a, b) => a.amount - b.amount);
  return { amount: rates[0].amount, currency: rates[0].currency, estimated: false };
}

async function getText(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchSnapshot(shop: string, deps?: Partial<FetchDeps>): Promise<StoreSnapshot> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  let admin: Pick<AdminClient, "graphql">;
  if (deps?.admin) {
    admin = deps.admin;
  } else {
    const { unauthenticated } = await import("../../shopify.server");
    admin = (await unauthenticated.admin(shop)).admin;
  }
  const base = `https://${shop}`;

  const homeHtml = (await getText(fetchImpl, `${base}/`)) ?? "";
  const homeText = htmlToText(homeHtml);

  let product: StoreSnapshot["product"] = null;
  const productsRaw = await getText(fetchImpl, `${base}/products.json?limit=5`);
  if (productsRaw) {
    try {
      const parsed = JSON.parse(productsRaw) as {
        products?: Array<{ title: string; handle: string; body_html?: string; variants?: Array<{ price?: string }> }>;
      };
      const p = parsed.products?.[0];
      if (p) {
        product = {
          title: p.title,
          descriptionText: htmlToText(p.body_html ?? "", 2000),
          priceText: p.variants?.[0]?.price ?? "",
          url: `${base}/products/${p.handle}`,
        };
      }
    } catch {
      product = null;
    }
  }

  let shipping: StoreSnapshot["shipping"] = { ...DEFAULT_SHIPPING };
  try {
    const resp = await admin.graphql(SHIPPING_QUERY);
    const body = (await resp.json()) as { data?: ShippingData; errors?: unknown };
    if (!body.errors && body.data) shipping = pickShippingRate(body.data);
  } catch {
    // keep labeled estimate
  }

  return { shop, homeText, product, shipping };
}
