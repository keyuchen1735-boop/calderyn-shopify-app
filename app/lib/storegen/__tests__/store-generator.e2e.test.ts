// app/lib/storegen/__tests__/store-generator.e2e.test.ts
// End-to-end smoke suite for the store generator (Phases A+B+C). Drives the WHOLE chain with
// REAL internal logic — generateStore → assembleDocument/validateDocument → saveDraft →
// loadDraftDoc/loadPublishedDoc → resolveRenderData → renderBlocks → renderToStaticMarkup, plus
// the imagery path (findImprovableListings → enhanceListing → applyAssetOverrides). The only
// stubs are the true external boundaries: Supabase (in-memory tables), Anthropic (scripted
// messages.create), and the image provider (fake/throwing). The catalog is the REAL
// fixture.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// REAL modules under test (vitest hoists the vi.mock/vi.hoisted calls below above these imports).
import { generateStore } from "~/lib/storegen/generate.server";
import { loadDraftDoc, loadPublishedDoc, publishDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { findImprovableListings } from "~/lib/storegen/imagery/detector";
import { enhanceListing, applyAssetOverrides } from "~/lib/storegen/imagery/asset.server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import type { BlockDocument, RenderContext } from "~/lib/storebuilder/types";

// ── hoisted mock state (built before module imports) ────────────────────────
const { createMock, getCatalogMock, providerMock, db } = vi.hoisted(() => {
  // In-memory Supabase. page_document + store_asset are real round-tripping tables; the rest are
  // capture buffers (we only assert the audit/settings writes happened with the right shape).
  const pageDocs = new Map<string, Record<string, unknown>>(); // key: shop|page
  const assets = new Map<string, Record<string, unknown>>(); // key: shop|product|source
  const captured: Record<string, Record<string, unknown>[]> = {
    store_settings: [],
    store_generation: [],
    store_generation_proposal: [],
  };

  function from(table: string) {
    const filters: Record<string, string> = {};
    let op: "select" | "update" | null = null;
    let updatePayload: Record<string, unknown> = {};

    const readSingle = () => {
      if (table === "page_document") return pageDocs.get(`${filters.shop_id}|${filters.page_key}`) ?? null;
      return null;
    };
    const readList = () => {
      if (table === "store_asset") return [...assets.values()].filter((r) => r.shop_id === filters.shop_id);
      return [];
    };
    const applyUpdate = () => {
      if (table === "page_document") {
        const key = `${filters.shop_id}|${filters.page_key}`;
        const prev = pageDocs.get(key);
        if (prev) pageDocs.set(key, { ...prev, ...updatePayload });
      }
      return { error: null };
    };

    const builder = {
      upsert(row: Record<string, unknown>) {
        if (table === "page_document") {
          const key = `${row.shop_id}|${row.page_key}`;
          pageDocs.set(key, { ...(pageDocs.get(key) ?? {}), ...row });
        } else if (table === "store_asset") {
          assets.set(`${row.shop_id}|${row.product_id}|${row.source}`, { ...row });
        } else if (captured[table]) {
          captured[table].push(row);
        }
        return Promise.resolve({ error: null });
      },
      insert(row: Record<string, unknown>) {
        if (captured[table]) captured[table].push(row);
        return Promise.resolve({ error: null });
      },
      update(payload: Record<string, unknown>) {
        op = "update";
        updatePayload = payload;
        return builder;
      },
      select(_cols?: string) {
        op = "select";
        return builder;
      },
      eq(col: string, val: string) {
        filters[col] = val;
        return builder;
      },
      order() {
        return builder;
      },
      range() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: readSingle(), error: null });
      },
      // Thenable: `.select().eq()` (store_asset) and `.update().eq().eq()` (publishDoc) are awaited
      // directly without a terminal call.
      then(onF: (v: { data?: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) {
        const result = op === "update" ? applyUpdate() : { data: readList(), error: null };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return builder;
  }

  return {
    createMock: vi.fn(),
    getCatalogMock: vi.fn(),
    providerMock: vi.fn(),
    db: {
      client: { from },
      pageDocs,
      assets,
      captured,
      reset() {
        pageDocs.clear();
        assets.clear();
        for (const k of Object.keys(captured)) captured[k].length = 0;
      },
    },
  };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => db.client }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
  digestModel: () => "claude-haiku-4-5",
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storegen/imagery/provider.server", () => ({
  getImageProvider: () => ({ name: "fake", generateListingImage: providerMock }),
}));
// Owned-asset persistence is a true external boundary (network fetch + Storage);
// stub it as a passthrough so this smoke suite stays offline and the provider url
// flows through to store_asset unchanged.
vi.mock("~/lib/assets/persist.server", () => ({
  persistExternalImage: async (_shop: string, url: string) => ({ persisted: false, url }),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const EMPTY_CATALOG: StorefrontCatalog = {
  listProducts: async () => [],
  getProduct: async () => null,
  listCollections: async () => [],
};

// Scripted Claude reply. `tokens` controls usage so the budget can be tripped on demand.
const reply = (text: string, tokens = 30) => ({
  content: [{ type: "text", text }],
  usage: { input_tokens: tokens, output_tokens: 0 },
});

// Canonical valid plans (one per page) reused across scenarios.
const BRAND = '{"storeName":"Summit Goods","palette":{"primary":"#0f766e","background":"#ffffff","text":"#111827"},"voiceTagline":"Gear for the climb"}';
// The home is generated as a full self-contained HTML page (rawHtml block), not a block plan.
const HOME_HTML =
  '<div class="ai-store"><style>.ai-store .hero{background:linear-gradient(135deg,#0f766e,#0b3b34);color:#fff;padding:120px 24px}.ai-store h1{font-size:clamp(2.5rem,6vw,5rem);margin:0}</style>' +
  '<section class="hero"><h1>Summit Goods</h1><p>Gear for the climb</p><a href="/storefront">Shop the range</a></section>' +
  '<section class="story"><h2>Built for the ascent</h2><p>Durable packs and weather-ready shells for every trail.</p></section></div>';
const COLLECTION_PLAN = JSON.stringify({
  blocks: [{ type: "collectionGrid", props: {}, layout: { x: 0, y: 0, w: 12, h: 6 } }],
});
const PDP_PLAN = JSON.stringify({
  blocks: [
    { type: "productGallery", props: { maxImages: 6 }, layout: { x: 0, y: 0, w: 6, h: 6 } },
    { type: "price", props: {}, layout: { x: 6, y: 0, w: 6, h: 1 } },
    { type: "variantPicker", props: {}, layout: { x: 6, y: 1, w: 6, h: 2 } },
    { type: "addToCart", props: {}, layout: { x: 6, y: 3, w: 6, h: 1 } },
  ],
});

// Render a persisted/produced doc exactly as the storefront route would: resolve catalog data,
// run the pure renderer, emit static HTML.
async function renderDoc(
  doc: BlockDocument,
  record?: RenderContext["record"],
  catalog: StorefrontCatalog = fixtureCatalog,
): Promise<string> {
  const data = await resolveRenderData(doc, SHOP, catalog, record);
  const nodes = renderBlocks(doc, { data, record });
  return renderToStaticMarkup(createElement(Fragment, null, nodes));
}

const types = (doc: BlockDocument): string[] => doc.blocks.map((b) => b.type);
const product = (handle: string): Promise<StoreProduct> =>
  fixtureCatalog.getProduct(SHOP, handle).then((p) => {
    if (!p) throw new Error(`fixture missing ${handle}`);
    return p;
  });

beforeEach(() => {
  createMock.mockReset();
  getCatalogMock.mockReset();
  providerMock.mockReset();
  db.reset();
  getCatalogMock.mockReturnValue(fixtureCatalog);
  // Single-candidate mode: these e2e flows queue exact reply sequences; the
  // multi-candidate judge pipeline is covered by generate.server.test.ts.
  process.env.STOREGEN_HOME_CANDIDATES = "1";
});

describe("store generator e2e", () => {
  it("1. AI happy path: all 3 docs generated, persisted, and render correctly", async () => {
    createMock
      .mockResolvedValueOnce(reply(BRAND))
      .mockResolvedValueOnce(reply(HOME_HTML))
      .mockResolvedValueOnce(reply(COLLECTION_PLAN))
      .mockResolvedValueOnce(reply(PDP_PLAN));

    const result = await generateStore({ shopId: SHOP, mode: "catalog" });
    expect(result.status).toBe("draft");

    // 3 drafts persisted through the real saveDraft → in-memory page_document.
    expect(db.pageDocs.size).toBe(3);
    const home = await loadDraftDoc(SHOP, "home");
    const collection = await loadDraftDoc(SHOP, "collection");
    const pdp = await loadDraftDoc(SHOP, "pdp");
    expect(home).not.toBeNull();
    expect(collection).not.toBeNull();
    expect(pdp).not.toBeNull();

    // Real audit + settings writes ran through real code paths.
    expect(db.captured.store_settings).toHaveLength(1);
    expect(db.captured.store_settings[0].store_name).toBe("Summit Goods");
    expect(db.captured.store_generation).toHaveLength(1);
    expect(db.captured.store_generation_proposal).toHaveLength(1);

    // Home: the AI-authored HTML page (one sanitized rawHtml block). Brand copy survives; the live
    // catalog grid now lives on the collection page, not the home.
    expect(home!.blocks[0].type).toBe("rawHtml");
    const homeHtml = await renderDoc(home!);
    expect(homeHtml).toContain("Summit Goods");
    expect(homeHtml).toContain("Gear for the climb");

    // Collection: the record collection's products render in a grid.
    const collHtml = await renderDoc(collection!, { collection: { handle: "apparel", title: "Apparel" } });
    expect(collHtml).toContain("cd-store__grid");
    expect(collHtml).toContain("Cotton Tee");
    expect(collHtml).toContain("Zip Hoodie");

    // PDP: gallery + a real price + a native buy form.
    const pdpHtml = await renderDoc(pdp!, { product: await product("zip-hoodie") });
    expect(pdpHtml).toContain("cd-block--gallery");
    expect(pdpHtml).toMatch(/\$/);
    expect(pdpHtml).toContain('method="post"');

    // draft → publish → loadPublishedDoc round-trip through the real repo.
    await publishDoc(SHOP, "home");
    const published = await loadPublishedDoc(SHOP, "home");
    expect(published).not.toBeNull();
    expect(await renderDoc(published!)).toContain("Summit Goods");
  });

  it("2. buy-path invariant: PDP plan omitting functional blocks still persists a buyable PDP", async () => {
    // PDP plan carries only a static block — the three functional blocks are absent.
    const pdpNoBuy = JSON.stringify({ blocks: [{ type: "richText", props: { text: "Buy this thing" }, layout: { x: 0, y: 0, w: 12, h: 2 } }] });
    createMock
      .mockResolvedValueOnce(reply(BRAND))
      .mockResolvedValueOnce(reply(HOME_HTML))
      .mockResolvedValueOnce(reply(COLLECTION_PLAN))
      .mockResolvedValueOnce(reply(pdpNoBuy));

    await generateStore({ shopId: SHOP, mode: "catalog" });

    const pdp = await loadDraftDoc(SHOP, "pdp");
    expect(pdp).not.toBeNull();
    // assembleDocument injects the missing required functional blocks (rule 12 invariant).
    expect(types(pdp!)).toEqual(expect.arrayContaining(["addToCart", "variantPicker", "price"]));

    const html = await renderDoc(pdp!, { product: await product("zip-hoodie") });
    expect(html).toContain('method="post"');
    expect(html).toMatch(/\$/);
  });

  it("3. isolated fallback: a garbage PDP response does not poison a good home doc", async () => {
    createMock
      .mockResolvedValueOnce(reply(BRAND))
      .mockResolvedValueOnce(reply(HOME_HTML))
      .mockResolvedValueOnce(reply(COLLECTION_PLAN))
      .mockResolvedValueOnce(reply("this is not json at all <<<"));

    await generateStore({ shopId: SHOP, mode: "catalog" });

    // Home draft is the AI HTML document — isolated from the bad PDP, its brand copy survived.
    const home = await loadDraftDoc(SHOP, "home");
    expect(home!.blocks[0].type).toBe("rawHtml");
    expect(home!.blocks[0].props.html as string).toContain("Summit Goods");

    // PDP draft is the deterministic fallback (its hand-authored block ids), yet still buyable.
    const pdp = await loadDraftDoc(SHOP, "pdp");
    expect(pdp!.blocks.map((b) => b.id)).toContain("fb-gallery");
    expect(types(pdp!)).toEqual(expect.arrayContaining(["productGallery", "price", "variantPicker", "addToCart"]));

    const html = await renderDoc(pdp!, { product: await product("zip-hoodie") });
    expect(html).toContain("cd-block--gallery");
    expect(html).toContain('method="post"');
  });

  it("4. empty catalog: status is no_products, LLM skipped, 3 fallback drafts still render cleanly", async () => {
    getCatalogMock.mockReturnValue(EMPTY_CATALOG);

    const result = await generateStore({ shopId: SHOP, mode: "catalog" });
    expect(result.status).toBe("no_products");
    expect(db.pageDocs.size).toBe(3);
    // No catalog and no brief gives the model nothing to work with — the run
    // is deterministic and free.
    expect(createMock).not.toHaveBeenCalled();
    expect(result.tokenCost).toBe(0);

    // Home must render against an empty catalog without throwing or blanking the hero.
    const home = await loadDraftDoc(SHOP, "home");
    const html = await renderDoc(home!, undefined, EMPTY_CATALOG);
    expect(html).toContain("Your store"); // brand fallback now derives from the shop, not a placeholder
    expect(html).toContain("cd-block--features"); // hollow store shows real value props, not an empty product grid
  });

  it("5. budget breach: brand call trips the token budget, all 3 docs are deterministic fallbacks", async () => {
    // Brand reply reports usage above TOKEN_BUDGET (20000) — every subsequent call short-circuits.
    createMock.mockResolvedValueOnce(reply(BRAND, 99999));

    await generateStore({ shopId: SHOP, mode: "catalog" });

    // Only the brand call happened; the 3 per-doc calls never fired.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(db.pageDocs.size).toBe(3);

    const home = await loadDraftDoc(SHOP, "home");
    const collection = await loadDraftDoc(SHOP, "collection");
    const pdp = await loadDraftDoc(SHOP, "pdp");
    // Deterministic fallback signatures (their hand-authored block ids).
    expect(home!.blocks.map((b) => b.id)).toEqual(expect.arrayContaining(["fb-hero", "fb-grid"]));
    expect(collection!.blocks.map((b) => b.id)).toContain("fb-coll-grid");
    expect(pdp!.blocks.map((b) => b.id)).toContain("fb-gallery");

    // All still render: home shows the (fallback) hero + grid; PDP is buyable.
    const homeHtml = await renderDoc(home!);
    expect(homeHtml).toContain("Summit Goods");
    expect(homeHtml).toContain("cd-store__grid");
    expect(homeHtml).toContain("Cotton Tee");
    const pdpHtml = await renderDoc(pdp!, { product: await product("cotton-tee") });
    expect(pdpHtml).toContain("cd-block--gallery");
    expect(pdpHtml).toContain('method="post"');
  });

  // PDP doc with just the gallery — enough to prove an overridden image surfaces in the render.
  const galleryDoc: BlockDocument = {
    kind: "template",
    pageKey: "pdp",
    blocks: [{ id: "g", type: "productGallery", props: { maxImages: 6 }, layout: { x: 0, y: 0, w: 6, h: 6 } }],
  };

  it("6a. imagery happy path: detect → enhance (ready) → override → new image renders in the gallery", async () => {
    const products = await fixtureCatalog.listProducts(SHOP);

    // Detector flags weak listings (every fixture product has a single image → severity 1).
    const improvable = findImprovableListings(products);
    expect(improvable.length).toBeGreaterThan(0);
    const flagged = improvable.find((l) => l.productId === "p-tee");
    expect(flagged).toBeDefined();

    const target = products.find((p) => p.id === "p-tee")!;
    providerMock.mockResolvedValue({ url: "https://img/generated.png" });

    const out = await enhanceListing(SHOP, target);
    expect(out.status).toBe("ready");
    expect(out.url).toBe("https://img/generated.png");
    // Asset persisted as ready through the real store_asset upsert.
    const assetRow = db.assets.get(`${SHOP}|p-tee|gemini`);
    expect(assetRow).toMatchObject({ status: "ready", url: "https://img/generated.png" });

    const overridden = await applyAssetOverrides(SHOP, products);
    const overTee = overridden.find((p) => p.id === "p-tee")!;
    const overCap = overridden.find((p) => p.id === "p-cap")!;
    expect(overTee.images[0].url).toBe("https://img/generated.png");
    // Untouched products keep their source image.
    expect(overCap.images[0].url).toBe(products.find((p) => p.id === "p-cap")!.images[0].url);

    // The generated url surfaces in a rendered PDP gallery.
    const html = await renderDoc(galleryDoc, { product: overTee });
    expect(html).toContain("cd-block--gallery");
    expect(html).toContain("https://img/generated.png");
  });

  it("6b. imagery failure: provider throws → failed asset → override leaves the source image intact", async () => {
    const products = await fixtureCatalog.listProducts(SHOP);
    const target = products.find((p) => p.id === "p-hoodie")!;
    const sourceUrl = target.images[0].url;

    providerMock.mockRejectedValue(new Error("higgs down"));

    const out = await enhanceListing(SHOP, target);
    expect(out.status).toBe("failed");
    expect(out.url).toBeNull();
    expect(db.assets.get(`${SHOP}|p-hoodie|gemini`)).toMatchObject({ status: "failed" });

    // A failed asset is filtered out — the product keeps its original image.
    const overridden = await applyAssetOverrides(SHOP, products);
    expect(overridden.find((p) => p.id === "p-hoodie")!.images[0].url).toBe(sourceUrl);

    // And it still renders the source image, never blanking.
    const html = await renderDoc(galleryDoc, { product: overridden.find((p) => p.id === "p-hoodie")! });
    expect(html).toContain(sourceUrl);
  });
});
