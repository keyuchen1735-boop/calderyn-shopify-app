// A runtime-1 PDP miss may resolve through the handle redirect table.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../storefront.products.$handle";

const { resolveRedirectMock, resolveRuntime1RouteMock } = vi.hoisted(() => ({
  resolveRedirectMock: vi.fn(),
  resolveRuntime1RouteMock: vi.fn(),
}));
vi.mock("~/lib/storefront/handle-redirect.server", () => ({
  resolveHandleRedirect: (...a: unknown[]) => resolveRedirectMock(...a),
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: (...a: unknown[]) => resolveRuntime1RouteMock(...a),
  hasRuntime1Storefront: vi.fn(async () => false),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedirectMock.mockResolvedValue(null);
  resolveRuntime1RouteMock.mockResolvedValue({
    runtime: 1,
    data: { notFound: { kind: "product", handle: "missing" } },
  });
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
  it("fails explicitly before consulting legacy product data when no runtime-1 surface resolves", async () => {
    resolveRuntime1RouteMock.mockResolvedValue(null);
    const res = await thrownResponse("missing-runtime");
    expect(res.status).toBe(503);
    expect(resolveRedirectMock).not.toHaveBeenCalled();
  });

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

  it("404s a runtime-1 product miss instead of rendering a recipe PDP", async () => {
    resolveRuntime1RouteMock.mockResolvedValue({
      runtime: 1,
      data: { notFound: { kind: "product", handle: "missing" } },
    });

    const res = await thrownResponse("missing");

    expect(res.status).toBe(404);
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

  it("does not consult the redirect table when the runtime-1 product resolves", async () => {
    resolveRuntime1RouteMock.mockResolvedValue({ runtime: 1, data: {} });
    const res = (await loader(args("live-handle"))) as Response;
    expect(res.status).toBe(200);
    expect(resolveRedirectMock).not.toHaveBeenCalled();
  });
});
