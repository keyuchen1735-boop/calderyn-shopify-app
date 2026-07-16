import { getAnthropic } from "~/lib/assistant/anthropic.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { listRedirectOldHandles } from "~/lib/storefront/handle-redirect.server";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import type { BlockDocument } from "~/lib/storebuilder/types";
import type { ValidIds } from "~/lib/storebuilder/validate";
import type { BrandPlan } from "./block-plan";
import { spliceCatalogBlocks } from "./hybrid";
import {
  HOME_HTML_SYSTEM_PROMPT,
  buildHomeHtmlUserMessage,
  type CatalogMenu,
} from "./prompts";
import type { StorefrontLinkSet } from "~/lib/storefront/links";

const MENU_PRODUCT_CAP = 60;
const MENU_COLLECTION_CAP = 30;

function storegenHtmlModel(): string {
  return process.env.STOREGEN_HTML_MODEL || "claude-sonnet-5";
}

function textOf(msg: { content: { type: string; text?: string }[] }): string {
  return msg.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("").trim();
}

export function extractStoreHtml(raw: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(raw);
  let value = (fenced ? fenced[1] : raw).trim().replace(/```\s*$/i, "").trim();
  const firstTag = value.indexOf("<");
  if (firstTag > 0) value = value.slice(firstTag);
  if (!/^<div[\s>]/i.test(value)) return "";
  const tag = /<div\b[^>]*>|<\/div>/gi;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(value)) !== null) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return value.slice(0, match.index + match[0].length);
  }
  return "";
}

function catalogMenuOf(
  products: { id: string; handle: string; title: string; images: { url: string }[] }[],
  collections: { handle: string; title: string }[],
): CatalogMenu {
  return {
    products: products.slice(0, MENU_PRODUCT_CAP).map((product) => ({
      id: product.id,
      handle: product.handle,
      title: product.title,
      ...(product.images.length > 0 ? { photo: true as const } : {}),
    })),
    collections: collections.slice(0, MENU_COLLECTION_CAP).map(({ handle, title }) => ({ handle, title })),
  };
}

function linkSetOf(
  products: { handle: string }[],
  collections: { handle: string }[],
  oldProductHandles: string[],
): StorefrontLinkSet {
  return {
    productHandles: new Set([...products.map(({ handle }) => handle), ...oldProductHandles]),
    collectionHandles: new Set(collections.map(({ handle }) => handle)),
  };
}

export async function generateChallengerHome(shopId: string): Promise<BlockDocument | null> {
  const catalog = getCatalog();
  const [products, collections, settings, oldHandles] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
    getStoreSettings(shopId),
    listRedirectOldHandles(shopId),
  ]);
  const menu = catalogMenuOf(products, collections);
  const valid: ValidIds = {
    productIds: new Set(products.map(({ id }) => id)),
    collectionHandles: new Set(collections.map(({ handle }) => handle)),
  };
  const byCollection: Record<string, number> = {};
  for (const product of products) {
    for (const handle of product.collections) byCollection[handle] = (byCollection[handle] ?? 0) + 1;
  }
  const brand: BrandPlan = {
    storeName: settings.storeName,
    palette: settings.palette,
    voiceTagline: settings.voiceTagline ?? "",
    vibe: settings.vibe,
    typeStyle: settings.typeStyle,
    density: settings.density,
  };
  const brief = "Design a different home-page composition and copy angle for a first-time visitor. Keep the same brand, palette, and catalog facts.";
  try {
    const msg = await getAnthropic().messages.create({
      model: storegenHtmlModel(),
      max_tokens: 12000,
      system: HOME_HTML_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: buildHomeHtmlUserMessage(brand, brief, menu, false, { products: products.length, byCollection }),
      }],
    });
    if ((msg as { stop_reason?: string | null }).stop_reason === "max_tokens") return null;
    const html = extractStoreHtml(textOf(msg));
    const clean = html ? sanitizeStoreHtml(html, { links: linkSetOf(products, collections, oldHandles) }) : "";
    const blocks = clean ? spliceCatalogBlocks(clean, valid) : [];
    return blocks.length > 0 ? { kind: "singleton", pageKey: "home", blocks } : null;
  } catch (error) {
    console.error("[storegen] challenger home generation failed", error);
    return null;
  }
}
