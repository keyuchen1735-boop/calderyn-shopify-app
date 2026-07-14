import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { renderBlocks } from "~/lib/storebuilder/render";
import { PdpBlockColumns } from "~/lib/storebuilder/pdp-layout";
import type { Block, BlockDocument, RenderData } from "~/lib/storebuilder/types";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
// vi.mock calls are hoisted above every import, so the mocks below still apply
// before the route module is evaluated.
import { action, loader, previewCompilerId, rewriteStorefrontHrefs, rewriteDocStorefrontHrefs } from "../dashboard.store.preview";

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

/** Chainable shops.org_slug read: getSupabase().from().select().eq().maybeSingle(). */
function stubOrgSlug(orgSlug: string | null) {
  getSupabaseMock.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_slug: orgSlug }, error: null }) }) }) }),
  });
}

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
  it("selects repeated preview DOM by canonical compiler metadata, never by parsing its suffixed DOM id", () => {
    const repeatOwner = { dataset: { cdCompilerId: "cd-home-grid" } };
    const selected = {
      dataset: { cdCompilerId: "cd-home-title" },
      closest: (selector: string) => selector === "[data-cd-repeat-owner][data-cd-compiler-id]" ? repeatOwner : null,
    };
    const target = { closest: () => selected } as unknown as Element;

    expect(previewCompilerId(target)).toBe("cd-home-grid");
  });

  it("renders a selected recipe against the authenticated merchant catalog without installing it", async () => {
    const previous = process.env.STOREFRONT_BUNDLE_READ;
    process.env.STOREFRONT_BUNDLE_READ = "1";
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    getRecipeMock.mockReturnValue({ bundle: { ...bundle, source: { kind: "recipe", templateId: "commons-index", templateVersion: 1 } } });
    try {
      const result = await loaderData("https://app.example.com/dashboard/store/preview?template=commons-index&route=home");
      expect(result).toMatchObject({ runtime: 1, bundleId: "preview:commons-index", routeId: "home" });
      expect(getRecipeMock).toHaveBeenCalledWith("commons-index");
      expect(getPreviewCatalogMock).toHaveBeenCalled();
      expect(readPreviewBundleVersionMock).not.toHaveBeenCalled();
      expect(loadDraftMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
      else process.env.STOREFRONT_BUNDLE_READ = previous;
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

  it("renders the merchant's generated draft home doc as real storefront HTML", async () => {
    const draft: BlockDocument = {
      kind: "singleton",
      pageKey: "home",
      blocks: [
        {
          id: "h",
          type: "hero",
          layout: { x: 0, y: 0, w: 12, h: 2 },
          props: { headline: "Handmade soy candles", subhead: "Small batch" },
        },
      ],
    };
    loadDraftMock.mockResolvedValue(draft);
    const { doc, data } = await loaderData("https://app.example.com/dashboard/store/preview?page=home");
    // The draft (what the prompt produced) is what the studio shows — not a mock.
    expect(doc.blocks[0].props.headline).toBe("Handmade soy candles");
    const html = renderToStaticMarkup(<>{renderBlocks(doc, { data })}</>);
    expect(html).toContain("Handmade soy candles");
    expect(html).toContain("Small batch");
  });

  it("carries typeStyle/density in the preview settings DTO so the canvas matches the published store", async () => {
    loadDraftMock.mockResolvedValue(null);
    const { settings: dto } = await loaderData("https://app.example.com/dashboard/store/preview");
    expect(dto.typeStyle).toBe("editorial");
    expect(dto.density).toBe("roomy");
  });

  it("falls back to the never-blank default home doc when there is no draft", async () => {
    loadDraftMock.mockResolvedValue(null);
    const { doc } = await loaderData("https://app.example.com/dashboard/store/preview");
    expect(doc.blocks.some((b: { type: string }) => b.type === "hero")).toBe(true);
    expect(doc.blocks.some((b: { type: string }) => b.type === "productGrid")).toBe(true);
  });

  it("uses the deterministic starter for a template page with no draft (never blank)", async () => {
    loadDraftMock.mockResolvedValue(null);
    const { doc } = await loaderData("https://app.example.com/dashboard/store/preview?page=collection");
    expect(doc.blocks.some((b: { type: string }) => b.type === "collectionGrid")).toBe(true);
  });

  it("ignores an unknown page param and previews home", async () => {
    loadDraftMock.mockResolvedValue(null);
    await loaderData("https://app.example.com/dashboard/store/preview?page=bogus");
    // loadDraftDoc is called with the resolved page — must be "home", not "bogus".
    expect(loadDraftMock).toHaveBeenCalledWith(SHOP, "home");
  });

  it("binds the pdp preview to the clicked product via ?handle (not just the first product)", async () => {
    const special = { id: "p9", handle: "special-tee", title: "Special Tee", description: "", images: [], variants: [], collections: [] };
    getCatalogMock.mockReturnValue({
      listProducts: async () => [{ ...special, id: "p1", handle: "first-product" }],
      listCollections: async () => [],
      getProduct: async (_s: string, h: string) => (h === "special-tee" ? special : null),
    });
    loadDraftMock.mockResolvedValue(null);
    const { record } = await loaderData("https://app.example.com/dashboard/store/preview?page=pdp&handle=special-tee");
    expect(record.product.handle).toBe("special-tee"); // the clicked product, not products[0]
  });

  it("binds the collection preview to the clicked collection via ?handle", async () => {
    getCatalogMock.mockReturnValue({
      listProducts: async () => [],
      listCollections: async () => [{ handle: "winter", title: "Winter" }, { handle: "summer", title: "Summer" }],
      getProduct: async () => null,
    });
    loadDraftMock.mockResolvedValue(null);
    const { record } = await loaderData("https://app.example.com/dashboard/store/preview?page=collection&handle=summer");
    expect(record.collection.handle).toBe("summer"); // the clicked collection, not collections[0]
  });

  it("rewrites rawHtml /storefront hrefs to the tenant origin (display-only, stored draft untouched)", async () => {
    const html = '<a href="/storefront/products/tee">Shop</a><a href="/about">About</a>';
    const draft: BlockDocument = {
      kind: "singleton",
      pageKey: "home",
      blocks: [{ id: "r", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 12 }, props: { html } }],
    };
    loadDraftMock.mockResolvedValue(draft);
    stubOrgSlug("acme");
    const { doc } = await loaderData("https://app.example.com/dashboard/store/preview?page=home");
    expect(doc.blocks[0].props.html).toContain('href="https://acme.calderyncompany.com/storefront/products/tee" target="_blank" rel="noopener"');
    expect(doc.blocks[0].props.html).toContain('href="/about"'); // non-storefront hrefs untouched
    expect(draft.blocks[0].props.html).toBe(html); // the loaded draft object is never mutated
  });

  it("makes rawHtml /storefront hrefs inert when the shop has no org_slug", async () => {
    const draft: BlockDocument = {
      kind: "singleton",
      pageKey: "home",
      blocks: [{ id: "r", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 12 }, props: { html: '<a href="/storefront">Shop</a>' } }],
    };
    loadDraftMock.mockResolvedValue(draft);
    stubOrgSlug(null);
    const { doc } = await loaderData("https://app.example.com/dashboard/store/preview?page=home");
    expect(doc.blocks[0].props.html).toContain('href="#"');
    expect(doc.blocks[0].props.html).not.toContain("target=");
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

describe("rewriteStorefrontHrefs", () => {
  const origin = "https://acme.calderyncompany.com";
  it("rewrites /storefront hrefs to the absolute tenant origin with target/rel", () => {
    expect(rewriteStorefrontHrefs('<a href="/storefront/collections/all">All</a>', origin)).toBe(
      `<a href="${origin}/storefront/collections/all" target="_blank" rel="noopener">All</a>`,
    );
    // Bare /storefront and single-quoted attributes rewrite too.
    expect(rewriteStorefrontHrefs("<a href='/storefront'>Home</a>", origin)).toBe(
      `<a href='${origin}/storefront' target='_blank' rel='noopener'>Home</a>`,
    );
  });
  it("falls back to inert links (href=\"#\", no target) without a tenant origin", () => {
    expect(rewriteStorefrontHrefs('<a href="/storefront/products/tee">Shop</a>', null)).toBe('<a href="#">Shop</a>');
  });
  it("leaves non-storefront hrefs untouched", () => {
    for (const html of ['<a href="/about">About</a>', '<a href="https://example.com/storefront">Ext</a>', '<a href="/storefronts">Near miss</a>']) {
      expect(rewriteStorefrontHrefs(html, origin)).toBe(html);
    }
  });
  it("leaves anchors without an href untouched", () => {
    const html = '<a data-section="hero">No link</a>';
    expect(rewriteStorefrontHrefs(html, origin)).toBe(html);
  });
});

describe("rewriteDocStorefrontHrefs", () => {
  it("touches only rawHtml blocks and returns the doc unchanged (same reference) when there are none", () => {
    const doc: BlockDocument = {
      kind: "singleton",
      pageKey: "home",
      blocks: [
        { id: "r", type: "rawHtml", layout: { x: 0, y: 0, w: 12, h: 12 }, props: { html: '<a href="/storefront">Shop</a>' } },
        { id: "t", type: "richText", layout: { x: 0, y: 12, w: 12, h: 2 }, props: { html: '<a href="/storefront">Story</a>' } },
      ],
    };
    const out = rewriteDocStorefrontHrefs(doc, "https://acme.calderyncompany.com");
    expect(out.blocks[0].props.html).toContain("https://acme.calderyncompany.com/storefront");
    expect(out.blocks[1].props.html).toBe('<a href="/storefront">Story</a>'); // non-rawHtml untouched

    const noRaw: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [doc.blocks[1]] };
    expect(rewriteDocStorefrontHrefs(noRaw, "https://acme.calderyncompany.com")).toBe(noRaw);
  });
});
