import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../inventory/engine.server", () => ({
  adjustStock: vi.fn(async () => undefined),
  setReorderPoint: vi.fn(async () => undefined),
  createTransfer: vi.fn(async () => ({ transferId: "t1" })),
  receiveTransfer: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { INVENTORY_ACTIONS } from "../inventory-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { adjustStock, setReorderPoint, createTransfer, receiveTransfer } from "../../../inventory/engine.server";

type OkV = { ok: true; value: Record<string, unknown> };

const byName = (n: string) => INVENTORY_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

describe("inventory actions", () => {
  beforeEach(() => {
    vi.mocked(adjustStock).mockClear();
    vi.mocked(setReorderPoint).mockClear();
    vi.mocked(createTransfer).mockClear();
    vi.mocked(createTransfer).mockResolvedValue({ transferId: "t1" });
    vi.mocked(receiveTransfer).mockClear();
  });

  describe("set_stock", () => {
    it("validates on_hand is a non-negative integer", () => {
      const a = byName("set_stock");
      expect(a.validate({ variant_id: "v1", location_id: "l1", on_hand: -1 }).ok).toBe(false);
      expect(a.validate({ variant_id: "v1", location_id: "l1", on_hand: 1.5 }).ok).toBe(false);
      expect(a.validate({ variant_id: "v1", location_id: "l1", on_hand: 0 }).ok).toBe(true);
      expect(a.validate({ variant_id: "v1", location_id: "l1", on_hand: 25 }).ok).toBe(true);
    });

    it("requires variant_id and location_id", () => {
      const a = byName("set_stock");
      expect(a.validate({ location_id: "l1", on_hand: 5 }).ok).toBe(false);
      expect(a.validate({ variant_id: "v1", on_hand: 5 }).ok).toBe(false);
    });

    it("calls adjustStock with reason 'assistant'", async () => {
      const a = byName("set_stock");
      const v = a.validate({ variant_id: "v1", location_id: "l1", on_hand: 25 });
      expect(v.ok).toBe(true);
      await a.run(ctx, (v as OkV).value);
      expect(adjustStock).toHaveBeenCalledWith("shop-1", "v1", "l1", 25, "assistant");
    });

    it("is execute-tier and not undoable", () => {
      const a = byName("set_stock");
      expect(a.tier).toBe("execute");
      expect(a.undoable).toBe(false);
    });
  });

  describe("set_reorder_point", () => {
    it("accepts a positive integer reorder_point", () => {
      const a = byName("set_reorder_point");
      expect(a.validate({ variant_id: "v1", location_id: "l1", reorder_point: 10 }).ok).toBe(true);
    });

    it("accepts null reorder_point to clear it", () => {
      const a = byName("set_reorder_point");
      const v = a.validate({ variant_id: "v1", location_id: "l1", reorder_point: null });
      expect(v.ok).toBe(true);
      expect((v as OkV).value.reorder_point).toBeNull();
    });

    it("rejects a negative or non-integer reorder_point", () => {
      const a = byName("set_reorder_point");
      expect(a.validate({ variant_id: "v1", location_id: "l1", reorder_point: -5 }).ok).toBe(false);
      expect(a.validate({ variant_id: "v1", location_id: "l1", reorder_point: 1.5 }).ok).toBe(false);
    });

    it("calls setReorderPoint with the validated value", async () => {
      const a = byName("set_reorder_point");
      const v = a.validate({ variant_id: "v1", location_id: "l1", reorder_point: null });
      expect(v.ok).toBe(true);
      await a.run(ctx, (v as OkV).value);
      expect(setReorderPoint).toHaveBeenCalledWith("shop-1", "v1", "l1", null);
    });
  });

  describe("create_transfer", () => {
    it("validates qty >= 1", () => {
      const a = byName("create_transfer");
      expect(
        a.validate({ variant_id: "v1", from_location_id: "l1", to_location_id: "l2", qty: 0, mode: "instant" }).ok,
      ).toBe(false);
      expect(
        a.validate({ variant_id: "v1", from_location_id: "l1", to_location_id: "l2", qty: 1, mode: "instant" }).ok,
      ).toBe(true);
    });

    it("validates mode is instant or in_transit", () => {
      const a = byName("create_transfer");
      expect(
        a.validate({ variant_id: "v1", from_location_id: "l1", to_location_id: "l2", qty: 1, mode: "teleport" }).ok,
      ).toBe(false);
    });

    it("rejects from_location_id === to_location_id", () => {
      const a = byName("create_transfer");
      expect(
        a.validate({ variant_id: "v1", from_location_id: "l1", to_location_id: "l1", qty: 1, mode: "instant" }).ok,
      ).toBe(false);
    });

    it("surfaces the engine's insufficient_stock error verbatim", async () => {
      vi.mocked(createTransfer).mockRejectedValueOnce(new Error("insufficient_stock"));
      const a = byName("create_transfer");
      await expect(
        a.run(ctx, { variant_id: "v1", from_location_id: "l1", to_location_id: "l2", qty: 5, mode: "instant" }),
      ).rejects.toThrow("insufficient_stock");
    });

    it("calls createTransfer and echoes transfer_id in the receipt detail", async () => {
      const a = byName("create_transfer");
      const v = a.validate({ variant_id: "v1", from_location_id: "l1", to_location_id: "l2", qty: 5, mode: "instant" });
      expect(v.ok).toBe(true);
      const receipt = await a.run(ctx, (v as OkV).value);
      expect(createTransfer).toHaveBeenCalledWith("shop-1", "v1", "l1", "l2", 5, "instant");
      expect(receipt.detail).toMatchObject({ transfer_id: "t1" });
    });
  });

  describe("receive_transfer", () => {
    it("requires transfer_id", () => {
      const a = byName("receive_transfer");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ transfer_id: "t1" }).ok).toBe(true);
    });

    it("calls receiveTransfer", async () => {
      const a = byName("receive_transfer");
      const v = a.validate({ transfer_id: "t1" });
      expect(v.ok).toBe(true);
      await a.run(ctx, (v as OkV).value);
      expect(receiveTransfer).toHaveBeenCalledWith("shop-1", "t1");
    });
  });
});
