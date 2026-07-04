import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { renderBlocks } from "~/lib/storebuilder/render";
import type { BlockDocument } from "~/lib/storebuilder/types";
import { loader } from "../dashboard.store.preview";

// The route imports the storefront stylesheet as a URL and several server-only
// data sources. Stub the URL import and the DB/session reads so the loader's
// real doc-selection + render wiring runs in isolation.
const { sessionMock, getCatalogMock, getSettingsMock, loadDraftMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  getCatalogMock: vi.fn(),
  getSettingsMock: vi.fn(),
  loadDraftMock: vi.fn(),
}));
vi.mock("~/styles/storefront.css?url", () => ({ default: "/assets/storefront.css" }));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: getSettingsMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadDraftDoc: loadDraftMock }));

const SHOP = "11111111-1111-1111-1111-111111111111";
const settings = {
  storeName: "Acme",
  palette: { primary: "#000", background: "#fff", text: "#111" },
  logoUrl: null,
  voiceTagline: "Tagline",
};
const catalog = {
  listProducts: async () => [],
  listCollections: async () => [],
  getProduct: async () => null,
};

beforeEach(() => {
  for (const m of [sessionMock, getCatalogMock, getSettingsMock, loadDraftMock]) m.mockReset();
  sessionMock.mockResolvedValue({ shopId: SHOP });
  getCatalogMock.mockReturnValue(catalog);
  getSettingsMock.mockResolvedValue(settings);
});

async function loaderData(url: string) {
  const res = await loader({ request: new Request(url) } as LoaderFunctionArgs);
  return (res as Response).json();
}

describe("dashboard.store.preview loader", () => {
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
});
