// app/routes/[robots.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildRobotsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const origin = storefrontOrigin(request);
  // Failure-isolated: a settings hiccup must still return a valid robots.txt.
  // Default to allowing both search + AI crawlers (the product default) on lookup failure.
  let allowAiCrawlers = true;
  let allowSearchEngines = true;
  try {
    const shopId = await resolveStorefrontShop(request);
    const settings = await getSeoSettings(shopId);
    allowAiCrawlers = settings.allowAiCrawlers;
    allowSearchEngines = settings.allowSearchEngines;
  } catch (err) {
    console.error("[storefront] robots.txt settings lookup failed:", err);
  }
  return new Response(buildRobotsTxt(origin, allowAiCrawlers, allowSearchEngines), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
