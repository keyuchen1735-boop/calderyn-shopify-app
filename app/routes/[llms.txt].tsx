// app/routes/[llms.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildLlmsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const origin = storefrontOrigin(request);
  // Failure-isolated (mirrors [robots.txt]): a settings/catalog hiccup degrades to
  // a minimal but valid llms.txt instead of a 500.
  let body = `# Store\n\n> Browse this store.\n\nStore: ${origin}/storefront\n`;
  try {
    const shopId = await resolveStorefrontShop(request);
    const store = await getStoreSettings(shopId);
    body = await buildLlmsTxt(shopId, store, origin);
  } catch (err) {
    console.error("[storefront] llms.txt build failed:", err);
  }
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
