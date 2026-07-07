// app/routes/[sitemap.xml].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { buildSitemapXml } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

// Minimal but schema-valid sitemap served when the catalog read fails, so a DB
// hiccup degrades to an empty urlset instead of a 500 (mirrors [robots.txt]).
const EMPTY_SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n';

export async function loader({ request }: LoaderFunctionArgs) {
  let body = EMPTY_SITEMAP;
  try {
    const shopId = await resolveStorefrontShop(request);
    body = await buildSitemapXml(shopId, storefrontOrigin(request));
  } catch (err) {
    console.error("[storefront] sitemap.xml build failed:", err);
  }
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
