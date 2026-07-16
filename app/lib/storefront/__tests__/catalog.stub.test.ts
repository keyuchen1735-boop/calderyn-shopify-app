// app/lib/storefront/__tests__/catalog.stub.test.ts
import { describe, it, expect } from "vitest";
import { fixtureCatalog } from "../catalog.stub.server";

const SHOP = "demo-shop";

describe("fixtureCatalog", () => {
  it("pages the complete fixture catalog with a stable cursor", async () => {
    const first = await fixtureCatalog.listProductPage(SHOP, { limit: 2 });
    const second = await fixtureCatalog.listProductPage(SHOP, { cursor: first.nextCursor, limit: 2 });
    expect([...first.items, ...second.items].map((product) => product.id)).toEqual([
      "p-cap", "p-tote", "p-tee", "p-hoodie",
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeNull();
  });

  it("lists all fixture products", async () => {
    expect((await fixtureCatalog.listProducts(SHOP)).length).toBe(4);
  });

  it("filters products by collection handle", async () => {
    const apparel = await fixtureCatalog.listProducts(SHOP, { collection: "apparel" });
    expect(apparel.map((p) => p.handle).sort()).toEqual(["cotton-tee", "zip-hoodie"]);
    const accessories = await fixtureCatalog.listProducts(SHOP, { collection: "accessories" });
    expect(accessories.length).toBe(2);
  });

  it("returns an empty array for an unknown collection", async () => {
    expect(await fixtureCatalog.listProducts(SHOP, { collection: "nope" })).toEqual([]);
  });

  it("gets a product by handle with its variants", async () => {
    const hoodie = await fixtureCatalog.getProduct(SHOP, "zip-hoodie");
    expect(hoodie?.title).toBe("Zip Hoodie");
    expect(hoodie?.variants.length).toBe(2);
  });

  it("returns null for an unknown product handle", async () => {
    expect(await fixtureCatalog.getProduct(SHOP, "nope")).toBeNull();
  });

  it("lists the two collections", async () => {
    expect((await fixtureCatalog.listCollections(SHOP)).map((c) => c.handle).sort()).toEqual([
      "accessories",
      "apparel",
    ]);
  });
});
