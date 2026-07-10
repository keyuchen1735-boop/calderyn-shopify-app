import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test (same convention as
// ops-actions.test.ts). notes.server.ts is left unmocked — isValidNoteBody/MAX_NOTE_LENGTH are
// pure, so exercising the real validator is cheap and more faithful than reimplementing it here.

vi.mock("../../../order/fulfill.server", () => ({
  executeFulfillAction: vi.fn(async () => ({
    auditId: "faudit-1",
    fulfillmentId: "f-1",
    orderState: "fulfilled",
    fulfilledUnits: 3,
    notified: false,
    replayed: false,
  })),
}));

const nativeOrderExists = vi.fn(async (..._args: unknown[]) => true);
vi.mock("../../../order/detail.server", () => ({
  isImportedOrderId: (id: string) => id.startsWith("shopify:"),
  stripNativeOrderPrefix: (id: string) => (id.startsWith("calderyn:") ? id.slice("calderyn:".length) : id),
  nativeOrderExists: (...a: unknown[]) => nativeOrderExists(...a),
}));

const addOrderTags = vi.fn(async (...args: unknown[]) => [...(args[2] as string[])].sort());
vi.mock("../../../order/tags.server", () => ({
  addOrderTags: (...a: unknown[]) => addOrderTags(...a),
}));

const insertedNotes: Array<Record<string, unknown>> = [];
let noteInsertError: unknown = null;
const sbBuilder = {
  from: (table: string) => {
    if (table !== "order_note") throw new Error(`unexpected table ${table}`);
    return {
      insert: (row: Record<string, unknown>) => {
        insertedNotes.push(row);
        return {
          select: () => ({
            single: async () =>
              noteInsertError ? { data: null, error: noteInsertError } : { data: { id: "note-1" }, error: null },
          }),
        };
      },
    };
  },
};
vi.mock("../../../supabase.server", () => ({ getSupabase: () => sbBuilder }));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { ORDER_ACTIONS } from "../order-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { executeFulfillAction } from "../../../order/fulfill.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { MAX_NOTE_LENGTH } from "../../../order/notes.server";

const byName = (n: string) => ORDER_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

type OkV = { ok: true; value: Record<string, unknown> };

describe("order actions", () => {
  beforeEach(() => {
    vi.mocked(executeFulfillAction).mockClear();
    nativeOrderExists.mockClear();
    nativeOrderExists.mockResolvedValue(true);
    addOrderTags.mockClear();
    insertedNotes.length = 0;
    noteInsertError = null;
  });

  it("registers exactly fulfill_order, add_order_note, add_order_tags (no refund/cancel duplication)", () => {
    const names = ORDER_ACTIONS.map((a) => a.name);
    expect(names).toEqual(["fulfill_order", "add_order_note", "add_order_tags"]);
  });

  describe("fulfill_order", () => {
    it("is confirm-tier and not undoable, with a confirmSummary declared", () => {
      const a = byName("fulfill_order");
      expect(a.tier).toBe("confirm");
      expect(a.undoable).toBe(false);
      expect(a.confirmSummary).toBeTypeOf("function");
    });

    it("validates order_id is required; notify (if present) must be boolean", () => {
      const a = byName("fulfill_order");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ order_id: "" }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", notify: "yes" }).ok).toBe(false);
      expect(a.validate({ order_id: "o1" }).ok).toBe(true);
      const v = a.validate({ order_id: "o1", notify: true }) as OkV;
      expect(v.ok).toBe(true);
      expect(v.value).toEqual({ order_id: "o1", notify: true });
    });

    it("validate defaults notify to false when omitted", () => {
      const v = byName("fulfill_order").validate({ order_id: "o1" }) as OkV;
      expect(v.value.notify).toBe(false);
    });

    it("confirmSummary states the status change, and mentions the email only when notify is true", async () => {
      const a = byName("fulfill_order");
      const quiet = await a.confirmSummary!(ctx, { order_id: "o1", notify: false });
      expect(quiet).toMatch(/status/i);
      expect(quiet.toLowerCase()).not.toContain("email");

      const loud = await a.confirmSummary!(ctx, { order_id: "o1", notify: true });
      expect(loud.toLowerCase()).toContain("email");
    });

    it("run refuses an imported (shopify:-prefixed) order_id without calling executeFulfillAction", async () => {
      const a = byName("fulfill_order");
      await expect(a.run(ctx, { order_id: "shopify:abc", notify: false })).rejects.toMatchObject({
        code: "imported_read_only",
      });
      expect(vi.mocked(executeFulfillAction)).not.toHaveBeenCalled();
    });

    it("run strips a calderyn: prefix and calls executeFulfillAction with idempotencyKey + actor", async () => {
      const a = byName("fulfill_order");
      await a.run(ctx, { order_id: "calderyn:o1", notify: true });
      expect(vi.mocked(executeFulfillAction)).toHaveBeenCalledWith(
        "shop-1",
        { orderId: "o1", notify: true, idempotencyKey: "ik-1", actor: "merchant:assistant" },
        expect.anything(),
      );
    });

    it("run summary reports fulfilled units and the resulting order state", async () => {
      const a = byName("fulfill_order");
      const r = await a.run(ctx, { order_id: "o1", notify: false });
      expect(r.summary).toMatch(/3 units/);
      expect(r.summary).toMatch(/fulfilled/);
      expect(r.auditId).toBe("faudit-1");
      expect(r.undoable).toBe(false);
      expect(r.detail).toMatchObject({ order_id: "o1", order_state: "fulfilled", fulfilled_units: 3 });
    });
  });

  describe("add_order_note", () => {
    it("is execute-tier, not undoable", () => {
      const a = byName("add_order_note");
      expect(a.tier).toBe("execute");
      expect(a.undoable).toBe(false);
    });

    it(`validates order_id required and body 1-${MAX_NOTE_LENGTH} chars`, () => {
      const a = byName("add_order_note");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ order_id: "o1", body: "" }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", body: "x".repeat(MAX_NOTE_LENGTH + 1) }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", body: "Called the buyer back" }).ok).toBe(true);
    });

    it("run refuses an imported order_id without checking existence or inserting", async () => {
      const a = byName("add_order_note");
      await expect(a.run(ctx, { order_id: "shopify:abc", body: "note" })).rejects.toMatchObject({
        code: "imported_read_only",
      });
      expect(nativeOrderExists).not.toHaveBeenCalled();
      expect(insertedNotes).toHaveLength(0);
    });

    it("run 404s when the native order doesn't exist, without inserting", async () => {
      nativeOrderExists.mockResolvedValueOnce(false);
      const a = byName("add_order_note");
      await expect(a.run(ctx, { order_id: "o1", body: "note" })).rejects.toMatchObject({ code: "order_not_found" });
      expect(insertedNotes).toHaveLength(0);
    });

    it("run inserts an order_note authored by merchant:assistant and returns its id", async () => {
      const a = byName("add_order_note");
      const r = await a.run(ctx, { order_id: "o1", body: "Called the buyer back" });
      expect(insertedNotes).toEqual([
        { shop_id: "shop-1", order_id: "o1", author_email: "merchant:assistant", body: "Called the buyer back" },
      ]);
      expect(r.detail).toEqual({ order_id: "o1", note_id: "note-1" });
      expect(r.auditId).toBeNull();
    });

    it("surfaces an insert failure rather than swallowing it", async () => {
      noteInsertError = { message: "constraint violated" };
      const a = byName("add_order_note");
      await expect(a.run(ctx, { order_id: "o1", body: "note" })).rejects.toBeTruthy();
    });
  });

  describe("add_order_tags", () => {
    it("is execute-tier, not undoable", () => {
      const a = byName("add_order_tags");
      expect(a.tier).toBe("execute");
      expect(a.undoable).toBe(false);
    });

    it("validates order_id required and tags as 1-10 strings", () => {
      const a = byName("add_order_tags");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ order_id: "o1", tags: [] }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", tags: ["vip", 42] }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", tags: ["vip", "wholesale"] }).ok).toBe(true);
    });

    it("run refuses an imported order_id without calling addOrderTags", async () => {
      const a = byName("add_order_tags");
      await expect(a.run(ctx, { order_id: "shopify:abc", tags: ["vip"] })).rejects.toMatchObject({
        code: "imported_read_only",
      });
      expect(addOrderTags).not.toHaveBeenCalled();
    });

    it("run calls addOrderTags additively and returns the union it reports", async () => {
      const a = byName("add_order_tags");
      const r = await a.run(ctx, { order_id: "o1", tags: ["vip", "wholesale"] });
      expect(addOrderTags).toHaveBeenCalledWith("shop-1", "o1", ["vip", "wholesale"], expect.anything());
      expect(r.detail).toMatchObject({ order_id: "o1", tags: ["vip", "wholesale"] });
      expect(r.summary).toMatch(/2 tags/);
    });
  });
});
