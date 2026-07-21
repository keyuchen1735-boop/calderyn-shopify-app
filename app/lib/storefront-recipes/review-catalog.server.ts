import type { StoreTemplateId } from "~/lib/storefront-bundle/types";
import type { StoreCollection, StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { decodeProductPageCursor, encodeProductPageCursor, MAX_PUBLIC_PRODUCT_PAGE_SIZE } from "~/lib/storefront/catalog";
import { searchProductPageInMemory } from "~/lib/storefront/catalog.stub.server";

interface ReviewCatalogSpec {
  collections: readonly [readonly [handle: string, title: string], readonly [handle: string, title: string]];
  products: readonly [string, string, string, string];
  description: string;
}

const REVIEW_CATALOGS = {
  volt: { collections: [["listening-room", "Listening Room"], ["portable-audio", "Portable Audio"]], products: ["Meridian Headphones", "Relay Speaker", "Arc Soundbar", "Signal Amp"], description: "Purpose-built audio for considered listening." },
  atelier: { collections: [["wardrobe", "Wardrobe"], ["accessories", "Accessories"]], products: ["Column Tee", "Studio Zip", "Canvas Cap", "Carry Tote"], description: "Everyday pieces with clear material and fit details." },
  gilt: { collections: [["jewelry", "Jewelry"], ["gifts", "Gifts"]], products: ["Signet Pendant", "Orbit Hoops", "Link Bracelet", "Keepsake Ring"], description: "Considered objects made for wearing and giving." },
  ember: { collections: [["sauces", "Sauces"], ["pantry", "Pantry"]], products: ["Ember No. 1", "Smoked Jalapeno", "Citrus Habanero", "Chili Crisp"], description: "Small-batch pantry heat with a clear flavor profile." },
  roast: { collections: [["filter", "Filter Coffee"], ["espresso", "Espresso"]], products: ["Kayon Mountain Filter Roast", "Northline Espresso", "Daybreak Decaf", "Field Blend"], description: "Fresh coffee selected for a dependable daily brew." },
  fizz: { collections: [["cans", "Cans"], ["variety", "Variety Packs"]], products: ["Citrus Lift", "Cherry Dry", "Ginger Spark", "Variety Four"], description: "Bright sparkling drinks with straightforward flavor." },
  forge: { collections: [["hand-tools", "Hand Tools"], ["layout", "Layout Tools"]], products: ["Framing Hammer", "Ratchet Set", "Precision Driver", "Layout Square"], description: "Work-ready tools with practical specifications." },
  haven: { collections: [["seating", "Seating"], ["storage", "Storage"]], products: ["Low Modular Sofa", "Ash Side Table", "Sliding Cabinet", "Lounge Chair"], description: "Quiet furniture designed for daily rooms." },
  glow: { collections: [["cleanse", "Cleanse"], ["hydrate", "Hydrate"]], products: ["Barrier Cleanser", "Daily Serum", "Mineral Moisturizer", "Night Balm"], description: "A simple skincare routine with clear directions." },
} satisfies Partial<Record<StoreTemplateId, ReviewCatalogSpec>>;

function slug(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function makeCatalog(spec: ReviewCatalogSpec): StorefrontCatalog {
  const collections: StoreCollection[] = spec.collections.map(([handle, title]) => ({ handle, title }));
  const products: StoreProduct[] = spec.products.map((title, index) => {
    const handle = slug(title);
    return {
      id: `review-product-${handle}`,
      handle,
      title,
      description: spec.description,
      images: [],
      variants: [{
        id: `review-variant-${handle}`,
        sku: null,
        title: "Standard",
        priceCents: 2400 + index * 800,
        currency: "USD",
        available: true,
      }],
      collections: [spec.collections[index % spec.collections.length]![0]],
    };
  });

  return {
    async searchProductPage(_shopId, options) {
      return searchProductPageInMemory(products, options);
    },
    async listProductPage(_shopId, options) {
      let selected = options.collection
        ? products.filter((product) => product.collections.includes(options.collection!))
        : [...products];
      if (options.query) {
        const query = options.query.toLocaleLowerCase("en-US");
        selected = selected.filter((product) => `${product.title} ${product.description}`.toLocaleLowerCase("en-US").includes(query));
      }
      selected.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      const cursor = options.cursor ? decodeProductPageCursor(options.cursor) : null;
      const remaining = cursor
        ? selected.filter((product) => product.title.localeCompare(cursor.title) > 0 ||
          (product.title === cursor.title && product.id.localeCompare(cursor.id) > 0))
        : selected;
      const limit = Math.min(Math.max(Math.trunc(options.limit), 1), MAX_PUBLIC_PRODUCT_PAGE_SIZE);
      const items = remaining.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: last && remaining.length > items.length ? encodeProductPageCursor(last.title, last.id) : null,
      };
    },
    async listProducts(_shopId, options) {
      let selected = options?.ids ? products.filter((product) => options.ids!.includes(product.id)) : products;
      if (options?.collection) selected = selected.filter((product) => product.collections.includes(options.collection!));
      if (options?.query) {
        const query = options.query.toLocaleLowerCase("en-US");
        selected = selected.filter((product) => `${product.title} ${product.description}`.toLocaleLowerCase("en-US").includes(query));
      }
      return selected.slice(0, options?.limit);
    },
    async getProduct(_shopId, handle) {
      return products.find((product) => product.handle === handle) ?? null;
    },
    async getVariantById(_shopId, variantId) {
      for (const product of products) {
        const variant = product.variants.find((entry) => entry.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
    async getCollection(_shopId, handle) {
      const collection = collections.find((entry) => entry.handle === handle);
      return collection ? { ...collection, productCount: products.filter((product) => product.collections.includes(handle)).length } : null;
    },
    async listCollections() {
      return collections.map((collection) => ({
        ...collection,
        productCount: products.filter((product) => product.collections.includes(collection.handle)).length,
      }));
    },
  };
}

export function getStorefrontRecipeReviewCatalog(templateId: StoreTemplateId): StorefrontCatalog {
  const spec = REVIEW_CATALOGS[templateId as keyof typeof REVIEW_CATALOGS];
  if (!spec) throw new Error(`No review catalog for ${templateId}`);
  return makeCatalog(spec);
}
