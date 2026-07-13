// The catalog client fetchers wrap the /dashboard/api/catalog/* endpoints.
// These lock the verb selection (POST to create, PUT to an existing id), the
// query-string assembly for the list, and the optimistic handle slug that
// createCollection returns before the next list refresh replaces it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("catalog client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { origin: "https://app.calderyncompany.com", assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saveProduct POSTs to the collection path when there is no id", async () => {
    fetchMock.mockResolvedValue(ok({ id: "p1" }));
    const { saveProduct } = await import("../client");
    const res = await saveProduct({ title: "Tee", status: "active", variants: [{ sku: "S" }] });
    expect(res).toEqual({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/api/catalog/products",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("saveProduct PUTs to the id path and echoes the id when given one", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    const { saveProduct } = await import("../client");
    const res = await saveProduct({ title: "Tee", status: "active", variants: [{ sku: "S" }] }, "p1");
    expect(res).toEqual({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/api/catalog/products/p1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("fetchProducts assembles the query string from search + status", async () => {
    fetchMock.mockResolvedValue(ok({ products: [], total: 0 }));
    const { fetchProducts } = await import("../client");
    await fetchProducts({ search: "tee", status: "active" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/api/catalog/products?search=tee&status=active",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetchProduct hits the id path and unwraps the product envelope", async () => {
    fetchMock.mockResolvedValue(ok({ product: { id: "p1", title: "Tee", status: "active", variants: [], media: [], updatedAt: "t" } }));
    const { fetchProduct } = await import("../client");
    const p = await fetchProduct("p1");
    expect(p.id).toBe("p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/api/catalog/products/p1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("createCollection returns the new id with an optimistic slug handle", async () => {
    fetchMock.mockResolvedValue(ok({ id: "c1" }));
    const { createCollection } = await import("../client");
    const c = await createCollection("Summer Drop!");
    // productCount starts at 0 for a just-created collection; the next list
    // refresh replaces the whole VM with server truth.
    expect(c).toEqual({ id: "c1", title: "Summer Drop!", handle: "summer-drop", productCount: 0 });
  });
});
