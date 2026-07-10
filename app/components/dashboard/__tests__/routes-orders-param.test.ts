import { describe, it, expect } from "vitest";
import { parsePath, pathFor } from "../routes";

describe("orders route param plumbing", () => {
  it("orders/<uuid> round-trips through buildPath and parsePath", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const path = pathFor({ screen: "orders", param: id, sub: null });
    expect(path).toBe(`/dashboard/orders/${encodeURIComponent(id)}`);

    const parsed = parsePath(path);
    expect(parsed).toEqual({
      screen: "orders",
      param: id,
      sub: null,
    });
  });

  it("orders/shopify:<uuid> round-trips with encoded colon", () => {
    const id = "shopify:550e8400-e29b-41d4-a716-446655440000";
    const path = pathFor({ screen: "orders", param: id, sub: null });
    expect(path).toBe(`/dashboard/orders/${encodeURIComponent(id)}`);
    expect(path).toContain("%3A"); // Encoded colon

    const parsed = parsePath(path);
    expect(parsed).toEqual({
      screen: "orders",
      param: id,
      sub: null,
    });
  });

  it("orders/labels subtab parses as subtab, not param", () => {
    const parsed = parsePath("/dashboard/orders/labels");
    expect(parsed).toEqual({
      screen: "orders",
      param: null,
      sub: "labels",
    });
  });

  it("orders bare path parses as subtab 'orders'", () => {
    const parsed = parsePath("/dashboard/orders");
    expect(parsed).toEqual({
      screen: "orders",
      param: null,
      sub: "orders",
    });
  });

  it("orders subtab maps back to /dashboard/orders", () => {
    const path = pathFor({ screen: "orders", param: null, sub: "orders" });
    expect(path).toBe("/dashboard/orders");
  });

  it("orders with labels subtab maps to /dashboard/orders/labels", () => {
    const path = pathFor({ screen: "orders", param: null, sub: "labels" });
    expect(path).toBe("/dashboard/orders/labels");
  });
});
