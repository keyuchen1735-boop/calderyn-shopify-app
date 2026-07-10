// Tests for the shared bulk order-action validation + batch runner (Phase 2 Task 3),
// used by all three bulk routes (fulfill/archive/tags).
import { describe, it, expect } from "vitest";
import { CalderynError } from "../calderyn.server";
import { MAX_BULK_ORDERS, validateBulkOrderIds, validateIdempotencyKey, runBulkOrderAction } from "./bulk.server";

describe("validateBulkOrderIds", () => {
  it("accepts 1-25 strings, deduping and stripping a calderyn: prefix", () => {
    const result = validateBulkOrderIds(["order-1", "calderyn:order-2", "order-1"]);
    expect(result).toEqual({ ok: true, orderIds: ["order-1", "order-2"] });
  });

  it("rejects a non-array or empty array", () => {
    expect(validateBulkOrderIds(undefined)).toMatchObject({ ok: false, code: "invalid_order_ids" });
    expect(validateBulkOrderIds([])).toMatchObject({ ok: false, code: "invalid_order_ids" });
    expect(validateBulkOrderIds("order-1")).toMatchObject({ ok: false, code: "invalid_order_ids" });
  });

  it("rejects a non-string / empty-string entry", () => {
    expect(validateBulkOrderIds(["order-1", 42])).toMatchObject({ ok: false, code: "invalid_order_ids" });
    expect(validateBulkOrderIds([""])).toMatchObject({ ok: false, code: "invalid_order_ids" });
  });

  it("rejects any shopify:-prefixed (imported, read-only) id", () => {
    const result = validateBulkOrderIds(["order-1", "shopify:99"]);
    expect(result).toMatchObject({ ok: false, code: "imported_read_only" });
  });

  it(`rejects more than ${MAX_BULK_ORDERS} distinct ids`, () => {
    const many = Array.from({ length: MAX_BULK_ORDERS + 1 }, (_, i) => `order-${i}`);
    expect(validateBulkOrderIds(many)).toMatchObject({ ok: false, code: "too_many_orders" });
  });

  it(`accepts exactly ${MAX_BULK_ORDERS} distinct ids`, () => {
    const max = Array.from({ length: MAX_BULK_ORDERS }, (_, i) => `order-${i}`);
    const result = validateBulkOrderIds(max);
    expect(result.ok).toBe(true);
  });

  it("dedupe brings a request over the raw count back under the cap", () => {
    const dup = Array.from({ length: MAX_BULK_ORDERS }, () => "order-1");
    const result = validateBulkOrderIds(dup);
    expect(result).toEqual({ ok: true, orderIds: ["order-1"] });
  });

  it("short-circuits when raw.length > 100 before validating entries", () => {
    const many = Array.from({ length: 101 }, (_, i) => `order-${i}`);
    const result = validateBulkOrderIds(many);
    expect(result).toMatchObject({ ok: false, code: "too_many_orders" });
  });
});

describe("validateIdempotencyKey", () => {
  it("accepts a non-empty string", () => {
    expect(validateIdempotencyKey("k1")).toBe("k1");
  });

  it("rejects a missing/empty/non-string key", () => {
    expect(validateIdempotencyKey(undefined)).toBeNull();
    expect(validateIdempotencyKey("")).toBeNull();
    expect(validateIdempotencyKey(42)).toBeNull();
  });
});

describe("runBulkOrderAction", () => {
  it("resolves every order to ok:true with the per-order result spread in", async () => {
    const results = await runBulkOrderAction(["a", "b"], async (id) => ({ audit_id: `audit-${id}` }));
    expect(results).toEqual([
      { order_id: "a", ok: true, audit_id: "audit-a" },
      { order_id: "b", ok: true, audit_id: "audit-b" },
    ]);
  });

  it("one rejection never aborts the batch — other orders still resolve ok:true", async () => {
    const results = await runBulkOrderAction(["a", "b", "c"], async (id) => {
      if (id === "b") throw new CalderynError({ code: "order_not_fulfillable", status: 409, message: "nope" });
      return { audit_id: `audit-${id}` };
    });
    expect(results).toEqual([
      { order_id: "a", ok: true, audit_id: "audit-a" },
      { order_id: "b", ok: false, error: "nope" },
      { order_id: "c", ok: true, audit_id: "audit-c" },
    ]);
  });

  it("a non-CalderynError rejection surfaces a generic message, never the raw error", async () => {
    const results = await runBulkOrderAction(["a"], async () => {
      throw new Error("some internal secret detail");
    });
    expect(results).toEqual([{ order_id: "a", ok: false, error: "Something went wrong." }]);
  });

  it("batches in groups (default 5): all ids are still processed and returned in order", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `order-${i}`);
    const results = await runBulkOrderAction(ids, async (id) => ({ id }));
    expect(results.map((r) => r.order_id)).toEqual(ids);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
