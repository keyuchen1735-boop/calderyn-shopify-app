// Tests for the dormant StoreActionAdapter (Task 2 — platform pivot Step 4).
// Mocks the owned write primitives; verifies delegation, error wrapping, and
// the ReserveResult union passthrough.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StoreActionError,
  isRetriableFailure,
  storeActionAdapterForShop,
} from "../store-actions";
import * as catalogMod from "~/lib/catalog/catalog.server";
import * as engineMod from "~/lib/inventory/engine.server";

// --- mock owned primitives --------------------------------------------------

vi.mock("~/lib/catalog/catalog.server", () => ({
  setVariantPrice: vi.fn(),
  setProductStatus: vi.fn(),
}));

vi.mock("~/lib/inventory/engine.server", () => ({
  reserveStock: vi.fn(),
  releaseReservation: vi.fn(),
}));

const mockSetVariantPrice = vi.mocked(catalogMod.setVariantPrice);
const mockSetProductStatus = vi.mocked(catalogMod.setProductStatus);
const mockReserveStock = vi.mocked(engineMod.reserveStock);
const mockReleaseReservation = vi.mocked(engineMod.releaseReservation);

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// --- StoreActionError -------------------------------------------------------

describe("StoreActionError", () => {
  it("defaults retriable to true", () => {
    const err = new StoreActionError("set_price", "boom");
    expect(err.retriable).toBe(true);
  });

  it("honours explicit retriable:false", () => {
    const err = new StoreActionError("reserve_inventory", "perm", { retriable: false });
    expect(err.retriable).toBe(false);
  });

  it("sets kind correctly", () => {
    const err = new StoreActionError("publish_product", "msg");
    expect(err.kind).toBe("publish_product");
  });

  it("sets name to StoreActionError", () => {
    const err = new StoreActionError("release_inventory", "msg");
    expect(err.name).toBe("StoreActionError");
  });
});

// --- isRetriableFailure -----------------------------------------------------

describe("isRetriableFailure", () => {
  it("returns the flag for a retriable StoreActionError", () => {
    const err = new StoreActionError("set_price", "x", { retriable: true });
    expect(isRetriableFailure(err)).toBe(true);
  });

  it("returns false for a non-retriable StoreActionError", () => {
    const err = new StoreActionError("set_price", "x", { retriable: false });
    expect(isRetriableFailure(err)).toBe(false);
  });

  it("returns true for a plain Error (default-transient)", () => {
    expect(isRetriableFailure(new Error("net"))).toBe(true);
  });

  it("returns true for a non-Error thrown value", () => {
    expect(isRetriableFailure("string-throw")).toBe(true);
  });
});

// --- storeActionAdapterForShop ----------------------------------------------

describe("storeActionAdapterForShop", () => {
  const SHOP = "shop1";

  describe("setPrice", () => {
    it("delegates to setVariantPrice with shopId bound", async () => {
      mockSetVariantPrice.mockResolvedValue({ priorPriceCents: 999 });
      const adapter = storeActionAdapterForShop(SHOP);
      const result = await adapter.setPrice("var-1", 1299);
      expect(mockSetVariantPrice).toHaveBeenCalledWith(SHOP, "var-1", 1299);
      expect(result).toEqual({ priorPriceCents: 999 });
    });

    it("wraps a throw as StoreActionError with kind set_price", async () => {
      mockSetVariantPrice.mockRejectedValue(new Error("db error"));
      const adapter = storeActionAdapterForShop(SHOP);
      await expect(adapter.setPrice("var-1", 100)).rejects.toMatchObject({
        name: "StoreActionError",
        kind: "set_price",
      });
    });
  });

  describe("reserveInventory", () => {
    it("returns ok:true allocation union directly", async () => {
      const allocation = [{ locationId: "loc-1", qty: 2 }];
      mockReserveStock.mockResolvedValue({ ok: true, allocation });
      const adapter = storeActionAdapterForShop(SHOP);
      const result = await adapter.reserveInventory("var-2", 2, "chk-abc");
      expect(mockReserveStock).toHaveBeenCalledWith(SHOP, "var-2", 2, "chk-abc");
      expect(result).toEqual({ ok: true, allocation });
    });

    it("returns ok:false insufficient_stock directly (not an error)", async () => {
      mockReserveStock.mockResolvedValue({ ok: false, reason: "insufficient_stock" });
      const adapter = storeActionAdapterForShop(SHOP);
      const result = await adapter.reserveInventory("var-2", 999, "chk-xyz");
      expect(result).toEqual({ ok: false, reason: "insufficient_stock" });
    });

    it("wraps a throw as StoreActionError with kind reserve_inventory", async () => {
      mockReserveStock.mockRejectedValue(new Error("network timeout"));
      const adapter = storeActionAdapterForShop(SHOP);
      await expect(adapter.reserveInventory("var-2", 1, "chk-err")).rejects.toMatchObject({
        name: "StoreActionError",
        kind: "reserve_inventory",
      });
    });
  });

  describe("releaseInventory", () => {
    it("delegates to releaseReservation with shopId bound", async () => {
      mockReleaseReservation.mockResolvedValue(undefined);
      const adapter = storeActionAdapterForShop(SHOP);
      await adapter.releaseInventory("chk-abc");
      expect(mockReleaseReservation).toHaveBeenCalledWith(SHOP, "chk-abc");
    });

    it("wraps a throw as StoreActionError with kind release_inventory", async () => {
      mockReleaseReservation.mockRejectedValue(new Error("rpc fail"));
      const adapter = storeActionAdapterForShop(SHOP);
      await expect(adapter.releaseInventory("chk-fail")).rejects.toMatchObject({
        name: "StoreActionError",
        kind: "release_inventory",
      });
    });
  });

  describe("publishProduct", () => {
    it("delegates to setProductStatus with status active", async () => {
      mockSetProductStatus.mockResolvedValue(undefined);
      const adapter = storeActionAdapterForShop(SHOP);
      await adapter.publishProduct("prod-1");
      expect(mockSetProductStatus).toHaveBeenCalledWith(SHOP, "prod-1", "active");
    });

    it("wraps a throw as StoreActionError with kind publish_product", async () => {
      mockSetProductStatus.mockRejectedValue(new Error("write fail"));
      const adapter = storeActionAdapterForShop(SHOP);
      await expect(adapter.publishProduct("prod-1")).rejects.toMatchObject({
        name: "StoreActionError",
        kind: "publish_product",
      });
    });
  });
});
