// app/lib/seo/site-files.server.ts
// Public per-tenant text/xml files. Generated from the owned catalog; failure-isolated by callers.
import { getCatalog } from "~/lib/storefront/catalog.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";
import { AI_BOT_NAMES } from "./crawlers.server";
import { sellablePrice } from "./pricing";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildRobotsTxt(origin: string, allowAiCrawlers = true, allowSearchEngines = true): string {
  // Two independent switches. The `User-agent: *` rule governs standard search
  // crawlers (Google, Bing, ...); the per-AI-bot blocks govern AI assistants.
  // Each flips allow (Allow: /) vs deny (Disallow: /) on its own.
  const searchRule = allowSearchEngines ? "Allow: /" : "Disallow: /";
  const aiRule = allowAiCrawlers ? "Allow: /" : "Disallow: /";
  const aiBlocks = AI_BOT_NAMES.map((b) => `User-agent: ${b}\n${aiRule}`).join("\n\n");
  const heading = allowAiCrawlers
    ? "# AI assistants are welcome to read and cite this store."
    : "# AI assistants are asked not to crawl this store.";
  return [
    "User-agent: *",
    searchRule,
    "",
    heading,
    aiBlocks,
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export async function buildSitemapXml(shopId: string, origin: string): Promise<string> {
  const catalog = getCatalog();
  const [products, collections] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
  ]);
  const locs = [
    `${origin}/storefront`,
    ...collections.map((c) => `${origin}/storefront/collections/${c.handle}`),
    ...products.map((p) => `${origin}/storefront/products/${p.handle}`),
  ];
  const urls = locs.map((loc) => `  <url><loc>${xmlEscape(loc)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export async function buildLlmsTxt(shopId: string, store: StoreSettings, origin: string): Promise<string> {
  const products = await getCatalog().listProducts(shopId);
  const lines: string[] = [
    `# ${store.storeName}`,
    "",
    `> ${store.voiceTagline?.trim() || `Browse ${store.storeName}.`}`,
    "",
    `Store: ${origin}/storefront`,
    "",
    "## Products",
  ];
  for (const p of products) {
    const url = `${origin}/storefront/products/${p.handle}`;
    const { priceCents, currency, available } = sellablePrice(p);
    const price = priceCents ? `${(priceCents / 100).toFixed(2)} ${currency}` : "Not for sale";
    const stock = available ? "In stock" : "Out of stock";
    lines.push(`- [${p.title}](${url}): ${price}, ${stock}`);
  }
  lines.push("");
  return lines.join("\n");
}
