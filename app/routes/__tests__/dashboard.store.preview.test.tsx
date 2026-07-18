import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { PdpBlockColumns } from "~/lib/storebuilder/pdp-layout";
import type { Block, BlockDocument, RenderData } from "~/lib/storebuilder/types";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
// vi.mock calls are hoisted above every import, so the mocks below still apply
// before the route module is evaluated.
import { action, loader } from "../dashboard.store.preview";

// The route imports the storefront stylesheet as a URL and several server-only
// data sources. Stub the URL import and the DB/session reads so the loader's
// real doc-selection + render wiring runs in isolation.
const { sessionMock, getCatalogMock, getPreviewCatalogMock, getSettingsMock, loadDraftMock, getSupabaseMock, readPreviewBundleVersionMock, readPreviewCommerceSessionMock, getRecipeMock, createPreviewCommerceAdapterMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  getCatalogMock: vi.fn(),
  getPreviewCatalogMock: vi.fn(),
  getSettingsMock: vi.fn(),
  loadDraftMock: vi.fn(),
  getSupabaseMock: vi.fn(),
  readPreviewBundleVersionMock: vi.fn(),
  readPreviewCommerceSessionMock: vi.fn(),
  getRecipeMock: vi.fn(),
  createPreviewCommerceAdapterMock: vi.fn(),
}));
vi.mock("~/styles/storefront.css?url", () => ({ default: "/assets/storefront.css" }));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock, getPreviewCatalog: getPreviewCatalogMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: getSettingsMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadDraftDoc: loadDraftMock }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: getSupabaseMock }));
vi.mock("~/lib/storefront-runtime/preview-commerce.server", () => ({
  readPreviewBundleVersion: readPreviewBundleVersionMock,
  readPreviewCommerceSession: readPreviewCommerceSessionMock,
  createPreviewCommerceAdapter: createPreviewCommerceAdapterMock,
  commitPreviewCommerceSession: vi.fn(),
}));
vi.mock("~/lib/storefront-recipes", () => ({ getStorefrontRecipe: getRecipeMock }));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/dashboard/http.server")>()),
  requireSameOrigin: vi.fn(),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const settings = {
  storeName: "Acme",
  palette: { primary: "#000", background: "#fff", text: "#111" },
  logoUrl: null,
  voiceTagline: "Tagline",
  vibe: "minimal",
  typeStyle: "editorial",
  density: "roomy",
};
const catalog = {
  searchProductPage: async () => ({
    items: [],
    facets: { categories: [], tags: [], collections: [] },
    total: 0,
    hasNextPage: false,
  }),
  listProductPage: async () => ({ items: [], nextCursor: null }),
  listProducts: async () => [],
  listCollections: async () => [],
  getProduct: async () => null,
};

beforeEach(() => {
  for (const m of [sessionMock, getCatalogMock, getPreviewCatalogMock, getSettingsMock, loadDraftMock, getSupabaseMock, readPreviewBundleVersionMock, readPreviewCommerceSessionMock, getRecipeMock, createPreviewCommerceAdapterMock]) m.mockReset();
  sessionMock.mockResolvedValue({ shopId: SHOP });
  getCatalogMock.mockReturnValue(catalog);
  getPreviewCatalogMock.mockReturnValue(catalog);
  getSettingsMock.mockResolvedValue(settings);
  readPreviewBundleVersionMock.mockResolvedValue(null);
  readPreviewCommerceSessionMock.mockResolvedValue({
    shopId: SHOP,
    lines: [],
    cart: {
      id: `preview:${SHOP}`, count: 0, lines: [],
      subtotal: { cents: 0, currency: "USD" }, discounts: { cents: 0, currency: "USD" }, total: { cents: 0, currency: "USD" },
    },
  });
  createPreviewCommerceAdapterMock.mockReturnValue({ checkout: () => ({ kind: "simulated", status: "ready" }) });
});

async function loaderData(url: string) {
  const res = await loader({ request: new Request(url) } as LoaderFunctionArgs);
  return (res as Response).json();
}

describe("dashboard.store.preview loader", () => {
  it("renders a selected recipe against the authenticated merchant catalog without installing it", async () => {
    const previous = process.env.STOREFRONT_BUNDLE_READ;
    const previousAppUrl = process.env.SHOPIFY_APP_URL;
    process.env.STOREFRONT_BUNDLE_READ = "1";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    bundle.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    getRecipeMock.mockReturnValue({ bundle: { ...bundle, source: { kind: "recipe", templateId: "commons-index", templateVersion: 1 } } });
    try {
      const result = await loaderData("https://dashboard.example.com/dashboard/store/preview?template=commons-index&route=home");
      expect(result).toMatchObject({ runtime: 1, bundleId: "preview:commons-index", routeId: "home" });
      expect(result.data.storefrontAssetUrls).toEqual({
        hero: "https://app.example.com/storefront-recipes/commons-index/hero.webp",
      });
      expect(getRecipeMock).toHaveBeenCalledWith("commons-index");
      expect(getPreviewCatalogMock).toHaveBeenCalled();
      expect(readPreviewBundleVersionMock).not.toHaveBeenCalled();
      expect(loadDraftMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
      else process.env.STOREFRONT_BUNDLE_READ = previous;
      if (previousAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
      else process.env.SHOPIFY_APP_URL = previousAppUrl;
    }
  });

  it("keeps checkout simulation interactive for an ephemeral selected recipe", async () => {
    const previous = process.env.STOREFRONT_BUNDLE_READ;
    process.env.STOREFRONT_BUNDLE_READ = "1";
    try {
      const form = new FormData();
      form.set("intent", "checkout");
      const response = await action({
        request: new Request("https://app.example.com/dashboard/store/preview?template=commons-index&route=checkout", {
          method: "POST", body: form,
        }),
      } as ActionFunctionArgs);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ kind: "simulated", status: "ready" });
      expect(readPreviewBundleVersionMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
      else process.env.STOREFRONT_BUNDLE_READ = previous;
    }
  });

  it("loads every runtime-1 preview route from the authenticated shop's immutable draft bundle", async () => {
    const previous = process.env.STOREFRONT_BUNDLE_READ;
    process.env.STOREFRONT_BUNDLE_READ = "1";
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    readPreviewBundleVersionMock.mockResolvedValue({
      id: "draft-1", shopId: SHOP, sourceKind: "custom", status: "validated",
      schemaVersion: 1, runtimeVersion: 1, validationProfileVersion: 1,
      artifactHash: "sha256:draft", artifact: { sourceKind: "custom", bundle }, createdAt: "2026-07-13T00:00:00Z",
    });
    try {
      for (const route of ["home", "search", "cart", "checkout"] as const) {
        const result = await loaderData(`https://app.example.com/dashboard/store/preview?route=${route}`);
        expect(result).toMatchObject({ runtime: 1, bundleId: "draft-1", routeId: route });
      }
      expect(sessionMock).toHaveBeenCalledTimes(4);
      expect(loadDraftMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
      else process.env.STOREFRONT_BUNDLE_READ = previous;
    }
  });

  it("fails closed when no runtime-1 draft exists instead of loading a legacy page document", async () => {
    const previous = process.env.STOREFRONT_BUNDLE_READ;
    process.env.STOREFRONT_BUNDLE_READ = "1";
    loadDraftMock.mockResolvedValue({
      kind: "singleton",
      pageKey: "home",
      blocks: [{
        id: "legacy-html",
        type: "rawHtml",
        layout: { x: 0, y: 0, w: 12, h: 12 },
        props: { html: "<main>legacy generated html</main>" },
      }],
    });
    try {
      await expect(loader({
        request: new Request("https://app.example.com/dashboard/store/preview"),
      } as LoaderFunctionArgs)).rejects.toMatchObject({ status: 404 });
      expect(loadDraftMock).not.toHaveBeenCalled();
      expect(getSettingsMock).not.toHaveBeenCalled();
      expect(getCatalogMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
      else process.env.STOREFRONT_BUNDLE_READ = previous;
    }
  });

});

describe("PdpBlockColumns (shared preview/storefront PDP layout)", () => {
  const data: RenderData = { collections: [], productsByCollection: {}, productsById: {}, allProducts: [] };
  const rt = (id: string, x: number, y: number, w: number, text: string): Block => ({
    id, type: "richText", layout: { x, y, w, h: 1 }, props: { html: text },
  });

  it("buckets half-width blocks into left/right columns and full-width blocks above/below the pair", () => {
    const doc: BlockDocument = {
      kind: "template",
      pageKey: "pdp",
      blocks: [rt("banner", 0, 0, 12, "BANNER"), rt("left", 0, 1, 6, "LEFT"), rt("right", 6, 1, 6, "RIGHT"), rt("footer", 0, 9, 12, "FOOTER")],
    };
    const html = renderToStaticMarkup(<PdpBlockColumns doc={doc} data={data} />);
    // Same composition the live PDP route produces: full-width banner above the column
    // pair, left column, right column, full-width footer below.
    const order = ["BANNER", "LEFT", "RIGHT", "FOOTER"].map((t) => html.indexOf(t));
    expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/class="cd-pdp__col cd-pdp__col--full"/g)).toHaveLength(2); // banner + footer
    expect(html.match(/class="cd-pdp__col"/g)).toHaveLength(2); // left + right
  });

  it("spans the right column across both tracks when there is no left column", () => {
    const doc: BlockDocument = { kind: "template", pageKey: "pdp", blocks: [rt("only", 6, 0, 6, "ONLY")] };
    const html = renderToStaticMarkup(<PdpBlockColumns doc={doc} data={data} />);
    expect(html).toContain("cd-pdp__col cd-pdp__col--full");
  });

  it("renders children at the end of the right column (the delivery-promise slot)", () => {
    const doc: BlockDocument = { kind: "template", pageKey: "pdp", blocks: [rt("left", 0, 0, 6, "LEFT"), rt("right", 6, 0, 6, "RIGHT")] };
    const html = renderToStaticMarkup(
      <PdpBlockColumns doc={doc} data={data}>
        <span>PROMISE</span>
      </PdpBlockColumns>,
    );
    expect(html.indexOf("PROMISE")).toBeGreaterThan(html.indexOf("RIGHT"));
  });
});
