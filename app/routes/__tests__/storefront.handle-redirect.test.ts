// PDP miss path: a handle with a redirect row 301s to the product's current
// URL; a handle with no row stays a 404. The lookup runs ONLY when getProduct
// misses — a live PDP never pays for it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../storefront.products.$handle";

const { getCatalogMock, getProductMock, resolveRedirectMock, resolveRuntime1RouteMock } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  getProductMock: vi.fn(),
  resolveRedirectMock: vi.fn(),
  resolveRuntime1RouteMock: vi.fn(),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storefront/handle-redirect.server", () => ({
  resolveHandleRedirect: (...a: unknown[]) => resolveRedirectMock(...a),
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: (...a: unknown[]) => resolveRuntime1RouteMock(...a),
  hasRuntime1Storefront: vi.fn(async () => false),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getProductMock.mockResolvedValue(null);
  getCatalogMock.mockReturnValue({ getProduct: getProductMock });
  resolveRedirectMock.mockResolvedValue(null);
  resolveRuntime1RouteMock.mockResolvedValue(null);
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

  it("bounds how long clients may cache the 301 (a rename-undo must stay fixable)", async () => {
    resolveRedirectMock.mockResolvedValue("new-handle");
    const res = await thrownResponse("old-handle");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("preserves the original query string on the 301", async () => {
    resolveRedirectMock.mockResolvedValue("new-handle");
    let caught: Response | null = null;
    try {
      await loader({
        request: new Request("https://demo.calderyncompany.com/storefront/products/old-handle?utm_source=mail&v=2"),
        params: { handle: "old-handle" },
        context: {},
      } as never);
    } catch (err) {
      if (err instanceof Response) caught = err;
      else throw err;
    }
    expect(caught?.status).toBe(301);
    expect(caught?.headers.get("Location")).toBe("/storefront/products/new-handle?utm_source=mail&v=2");
  });

  it("runs the same renamed-handle 301 before a runtime-1 product miss becomes a 404", async () => {
    resolveRuntime1RouteMock.mockResolvedValue({ runtime: 1, data: { notFound: { kind: "product", handle: "old-handle" } } });
    resolveRedirectMock.mockResolvedValue("new-handle");
    let caught: Response | null = null;
    try {
      await loader({
        request: new Request("https://demo.calderyncompany.com/storefront/products/old-handle?utm_source=mail"),
        params: { handle: "old-handle" },
        context: {},
      } as never);
    } catch (error) {
      if (error instanceof Response) caught = error;
      else throw error;
    }
    expect(caught?.status).toBe(301);
    expect(caught?.headers.get("Location")).toBe("/storefront/products/new-handle?utm_source=mail");
    expect(caught?.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("404s when no redirect row exists", async () => {
    const res = await thrownResponse("never-existed");
    expect(res.status).toBe(404);
    expect(resolveRedirectMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to a 404 (never a 500) when the redirect lookup itself fails", async () => {
    resolveRedirectMock.mockRejectedValue(new Error("redirect table down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await thrownResponse("old-handle");
    expect(res.status).toBe(404);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
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
