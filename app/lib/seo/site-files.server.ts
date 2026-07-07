// app/lib/seo/site-files.server.ts
// Public per-tenant text/xml files. Generated from the owned catalog; failure-isolated by callers.
import { getCatalog } from "~/lib/storefront/catalog.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const AI_BOTS_ALLOWED = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended"];

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildRobotsTxt(origin: string): string {
  const aiBlocks = AI_BOTS_ALLOWED.map((b) => `User-agent: ${b}\nAllow: /`).join("\n\n");
  return [
    "User-agent: *",
    "Allow: /",
    "",
    "# AI assistants are welcome to read and cite this store.",
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
    const sellable = p.variants.filter((v) => v.priceCents > 0);
    const priceCents = sellable.length ? Math.min(...sellable.map((v) => v.priceCents)) : 0;
    const currency = sellable[0]?.currency ?? "";
    const available = p.variants.some((v) => v.available);
    const price = priceCents ? `${(priceCents / 100).toFixed(2)} ${currency}` : "Not for sale";
    const stock = available ? "In stock" : "Out of stock";
    lines.push(`- [${p.title}](${url}): ${price}, ${stock}`);
  }
  lines.push("");
  return lines.join("\n");
}
