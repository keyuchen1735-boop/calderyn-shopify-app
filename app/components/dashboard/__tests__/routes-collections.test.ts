import { describe, it, expect } from "vitest";
import { parsePath, pathFor } from "../routes";

describe("collections route param plumbing", () => {
  it("collections detail round-trips through pathFor and parsePath", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const path = pathFor({ screen: "collections", param: id, sub: null });
    expect(path).toBe(`/dashboard/products/collections/${encodeURIComponent(id)}`);

    const parsed = parsePath(path);
    expect(parsed).toEqual({ screen: "collections", param: id, sub: null });
  });

  it("encodes reserved characters in the collection id", () => {
    const id = "col:a/b";
    const path = pathFor({ screen: "collections", param: id, sub: null });
    expect(path).toBe(`/dashboard/products/collections/${encodeURIComponent(id)}`);
    expect(path).toContain("%2F"); // Encoded slash — must not become a segment.
    expect(parsePath(path)).toEqual({ screen: "collections", param: id, sub: null });
  });

  it("collections list still maps to /dashboard/products/collections both ways", () => {
    expect(pathFor({ screen: "collections", param: null, sub: null })).toBe(
      "/dashboard/products/collections",
    );
    expect(parsePath("/dashboard/products/collections")).toEqual({
      screen: "collections",
      param: null,
      sub: null,
    });
  });

  it("rejects a collections path with more than one extra segment", () => {
    expect(parsePath("/dashboard/products/collections/a/b")).toBeNull();
  });

  it("still rejects every other 3+-segment path", () => {
    expect(parsePath("/dashboard/orders/a/b")).toBeNull();
    expect(parsePath("/dashboard/products/inventory/x")).toBeNull();
    expect(parsePath("/dashboard/products/some-id/extra")).toBeNull();
    expect(parsePath("/dashboard/settings/import/x")).toBeNull();
  });
});
