import { randomBytes } from "node:crypto";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { StorefrontPolicyPage } from "~/lib/storefront/policy-page";
import { loadStorefrontPolicy } from "~/lib/storefront/policies.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export const meta: MetaFunction<typeof loader> = ({ data }) => data ? [
  { title: `${data.policy.title} · ${data.store.name}` },
  { name: "description", content: `${data.policy.title} for ${data.store.name}.` },
] : [{ title: "Store policy" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const policyId = params.policyId ?? "";
  const [policy, settings] = await Promise.all([
    loadStorefrontPolicy(shopId, policyId),
    getStoreSettings(shopId),
  ]);
  if (!policy) throw new Response("Policy not found", { status: 404 });
  const headers = storefrontCacheHeaders({ routeId: "policy", personalized: false, shopId });
  markStorefrontBundleRendered(headers, randomBytes(18).toString("base64url"));
  return json({
    runtime: 1 as const,
    policy,
    store: { name: settings.storeName, logo: settings.logoUrl },
  }, { headers });
}

export default function StorefrontPolicyRoute() {
  const { policy, store } = useLoaderData<typeof loader>();
  return <StorefrontPolicyPage policy={policy} store={store} />;
}
