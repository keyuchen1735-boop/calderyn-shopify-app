// app/routes/[llms.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildLlmsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const store = await getStoreSettings(shopId);
  const body = await buildLlmsTxt(shopId, store, storefrontOrigin(request));
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
