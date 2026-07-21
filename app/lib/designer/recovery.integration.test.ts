import { beforeEach, describe, expect, it, vi } from "vitest";
import { designerFirstBuild, designerTurn } from "./engine.server";
import { publishDesignerSite } from "./publish.server";

type Row = Record<string, unknown>;
type QueryResult = { data: Row[]; error: null };

const {
  getAnthropic,
  getSupabase,
  getCatalog,
  getStoreSettings,
  loadDesignerAssets,
  generateDesignerAsset,
  requirePublishableTenantDomain,
  expireOverdueExperiment,
  hasRunningExperiment,
  designerProductImagesAvailable,
} = vi.hoisted(() => ({
  getAnthropic: vi.fn(),
  getSupabase: vi.fn(),
  getCatalog: vi.fn(),
  getStoreSettings: vi.fn(),
    loadDesignerAssets: vi.fn(),
    generateDesignerAsset: vi.fn(),
  requirePublishableTenantDomain: vi.fn(),
  expireOverdueExperiment: vi.fn(),
  hasRunningExperiment: vi.fn(),
  designerProductImagesAvailable: vi.fn(),
}));

vi.mock("~/lib/assistant/anthropic.server", () => ({ getAnthropic }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));
vi.mock("../storefront/catalog.server", () => ({ getCatalog }));
vi.mock("../storefront/settings.server", () => ({ getStoreSettings }));
vi.mock("./imagery.server", () => ({
  loadDesignerAssets,
  generateDesignerAsset,
  adoptDesignerAsset: vi.fn(),
  designerFirstBuildImageLimits: () => ({ perShopDaily: 13, globalDaily: 30 }),
}));
vi.mock("~/lib/storegen/imagery/asset.server", () => ({
  applyAssetOverrides: vi.fn(async (_shopId: string, products: unknown[]) => products),
  generateMissingListingImages: vi.fn(),
}));
vi.mock("~/lib/storebuilder/studio.server", () => ({ requirePublishableTenantDomain }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  expireOverdueExperiment,
  hasRunningExperiment,
}));
vi.mock("./product-imagery.server", () => ({ designerProductImagesAvailable }));

const SHOP = "00000000-0000-0000-0000-000000000010";
const invented = (route: "home" | "search") =>
  `<main><img src="/storefront-recipes/candle-${route}.jpg"></main>`;
const repaired = (route: "home" | "search") => `<main>${route} repaired</main>`;

function completion(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}

function replacement(route: "home" | "search") {
  return [
    `FILE: ${route}.html`,
    "<<<<<<< SEARCH",
    "*",
    "=======",
    repaired(route),
    ">>>>>>> REPLACE",
  ].join("\n");
}

function installMemoryDatabase(preloaded = true) {
  const documents = new Map<string, Row>(preloaded ? [
    ["home", { shop_id: SHOP, route: "home", html: invented("home"), css: "", template_id: "ritual-almanac", built: true }],
    ["search", { shop_id: SHOP, route: "search", html: invented("search"), css: "", template_id: "ritual-almanac", built: true }],
  ] : []);
  const chat: Row[] = [];
  const publications: Row[] = [];

  class Query implements PromiseLike<QueryResult> {
    private filters: Array<[string, unknown]> = [];
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }

    select(): this { return this; }
    eq(column: string, value: unknown): this {
      this.filters.push([column, value]);
      return this;
    }
    order(): this { return this; }
    limit(): Promise<QueryResult> { return Promise.resolve(this.result()); }
    in(): Promise<QueryResult> { return Promise.resolve(this.result()); }
    maybeSingle(): Promise<{ data: Row | null; error: null }> {
      const result = this.result();
      return Promise.resolve({ data: result.data[0] ?? null, error: null });
    }
    insert(row: Row): Promise<{ error: null }> {
      if (this.table === "designer_chat") chat.push(row);
      return Promise.resolve({ error: null });
    }
    upsert(value: Row | Row[]): Promise<{ error: null }> {
      const rows = Array.isArray(value) ? value : [value];
      if (this.table === "designer_documents") {
        for (const row of rows) documents.set(String(row.route), { ...row });
      } else if (this.table === "designer_publications") {
        publications.push(...rows);
      }
      return Promise.resolve({ error: null });
    }
    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(this.result()).then(onfulfilled, onrejected);
    }
    private result(): QueryResult {
      const rows = this.table === "designer_documents"
        ? [...documents.values()]
        : this.table === "designer_chat"
          ? chat
          : this.table === "designer_publications"
            ? publications
            : [];
      return {
        data: rows.filter((row) =>
          this.filters.every(([column, value]) => row[column] === value),
        ),
        error: null,
      };
    }
  }

  getSupabase.mockReturnValue({ from: (table: string) => new Query(table) });
  return { documents, publications };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCatalog.mockReturnValue({ listProducts: vi.fn().mockResolvedValue([]) });
  getStoreSettings.mockResolvedValue({
    storeName: "Maple & Wick Candle Co.",
    voiceTagline: null,
    logoUrl: null,
  });
  loadDesignerAssets.mockResolvedValue({});
  generateDesignerAsset.mockResolvedValue({ url: null, quotaBlocked: false });
  requirePublishableTenantDomain.mockResolvedValue("https://maple.example/storefront");
  expireOverdueExperiment.mockResolvedValue(undefined);
  hasRunningExperiment.mockResolvedValue(false);
  designerProductImagesAvailable.mockResolvedValue(false);
});

describe("existing designer store imagery recovery", () => {
  it("repairs a saved synthetic product-media stand-in through an ordinary turn, then publishes", async () => {
    const { documents, publications } = installMemoryDatabase();
    documents.set("home", {
      shop_id: SHOP,
      route: "home",
      html: '{{#products}}<article><div class="cardMedia"><span>{{product.availability}}</span></div><h2>{{product.title}}</h2></article>{{/products}}',
      css: ".cardMedia{aspect-ratio:4/5;background:var(--paper)}",
      template_id: "scratch",
      built: true,
    });
    documents.delete("search");
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion("I checked the product cards."))
      .mockResolvedValueOnce(completion(replacement("home")));
    getAnthropic.mockReturnValue({ messages: { create } });

    await expect(designerTurn({
      shopId: SHOP,
      route: "home",
      message: "Repair the empty product cards",
    })).resolves.toMatchObject({ changed: true });
    expect(create.mock.calls[1][0].messages.at(-1)?.content).toContain("IMAGE AUDIT");
    expect(String(documents.get("home")?.html)).toBe(repaired("home"));

    await expect(publishDesignerSite(SHOP)).resolves.toBe("https://maple.example/storefront");
    expect(publications).toHaveLength(1);
  });

  it("repairs each affected page through ordinary turns, then publishes without a rebuild", async () => {
    const { documents, publications } = installMemoryDatabase();
    const create = vi
      .fn()
      .mockResolvedValueOnce(completion("I checked the home page."))
      .mockResolvedValueOnce(completion(replacement("home")))
      .mockResolvedValueOnce(completion("I checked the search page."))
      .mockResolvedValueOnce(completion(replacement("search")));
    getAnthropic.mockReturnValue({ messages: { create } });

    await expect(designerTurn({
      shopId: SHOP,
      route: "home",
      message: "Repair the broken imagery on this page",
    })).resolves.toMatchObject({ changed: true });
    expect(String(documents.get("home")?.html)).toBe(repaired("home"));
    expect(create.mock.calls[1][0].messages.at(-1)?.content).toContain("IMAGE AUDIT");

    await expect(publishDesignerSite(SHOP)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Search (/storefront/search)"),
    });

    await expect(designerTurn({
      shopId: SHOP,
      route: "search",
      message: "Repair the broken imagery on this page",
    })).resolves.toMatchObject({ changed: true });
    expect(String(documents.get("search")?.html)).toBe(repaired("search"));
    expect(create.mock.calls[3][0].messages.at(-1)?.content).toContain("IMAGE AUDIT");

    await expect(publishDesignerSite(SHOP)).resolves.toBe("https://maple.example/storefront");
    expect(publications).toHaveLength(2);
  });

  it("persists a stubborn first-build neutral-image route as unbuilt and publish refuses it", async () => {
    const { documents, publications } = installMemoryDatabase(false);
    const stubbornHome = [
      "FILE: home.html",
      "<<<<<<< SEARCH",
      "*",
      "=======",
      '<main><img src="{{product.image}}"></main>',
      ">>>>>>> REPLACE",
    ].join("\n");
    const create = vi.fn().mockResolvedValue(completion(stubbornHome));
    getAnthropic.mockReturnValue({ messages: { create } });

    const result = await designerFirstBuild({
      shopId: SHOP,
      message: "Build a candle store",
      mode: "scratch",
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[1][0].messages.at(-1)?.content).toContain("IMAGE AUDIT");
    expect(documents.get("home")?.built).toBe(false);
    expect(result.reply).toContain("home page still needs an imagery repair");
    expect(result.reply).toContain("resume there");

    await expect(publishDesignerSite(SHOP)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Home (/storefront)"),
    });
    expect(publications).toHaveLength(0);
  });
});
