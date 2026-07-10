// PDP miss path: a handle with a redirect row 301s to the product's current
// URL; a handle with no row stays a 404. The lookup runs ONLY when getProduct
// misses — a live PDP never pays for it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../storefront.products.$handle";

const { getCatalogMock, getProductMock, resolveRedirectMock } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  getProductMock: vi.fn(),
  resolveRedirectMock: vi.fn(),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storefront/handle-redirect.server", () => ({
  resolveHandleRedirect: (...a: unknown[]) => resolveRedirectMock(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getProductMock.mockResolvedValue(null);
  getCatalogMock.mockReturnValue({ getProduct: getProductMock });
  resolveRedirectMock.mockResolvedValue(null);
});

const args = (handle: string) =>
  ({
    request: new Request(`https://demo.calderyncompany.com/storefront/products/${handle}`),
    params: { handle },
    context: {},
  }) as never;

async function thrownResponse(handle: string): Promise<Response> {
  try {
    await loader(args(handle));
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
  throw new Error("loader did not throw");
}

describe("PDP handle redirect", () => {
  it("301s a renamed handle to the product's current URL", async () => {
    resolveRedirectMock.mockResolvedValue("new-handle");
    const res = await thrownResponse("old-handle");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/storefront/products/new-handle");
  });

  it("404s when no redirect row exists", async () => {
    const res = await thrownResponse("never-existed");
    expect(res.status).toBe(404);
    expect(resolveRedirectMock).toHaveBeenCalledTimes(1);
  });

  it("does not consult the redirect table when the product resolves", async () => {
    // Minimal product; the loader's downstream reads all run against the demo
    // shop (non-uuid), which every helper no-ops for.
    getProductMock.mockResolvedValue({
      id: "p1", handle: "live-handle", title: "Live", description: "d",
      images: [], variants: [], collections: [],
    });
    const res = (await loader(args("live-handle"))) as Response;
    expect(res.status).toBe(200);
    expect(resolveRedirectMock).not.toHaveBeenCalled();
  });
});
