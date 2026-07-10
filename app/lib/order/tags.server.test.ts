// Tests for addOrderTags (Phase 2 Task 3): additive tag helper backing the bulk-tags route.
// Same in-memory Supabase Builder shape as dashboard.api.orders.detail.test.ts's `store`,
// trimmed to the one table this helper touches.
import { describe, it, expect } from "vitest";
import { CalderynError } from "../calderyn.server";
import { addOrderTags } from "./tags.server";

type Row = Record<string, any>;

function makeStore() {
  const rows: Row[] = [];

  class Builder {
    private op: "select" | "insert" = "select";
    private payload: Row | Row[] = {};
    private filters: Array<[string, unknown]> = [];
    select(_cols?: string) {
      return this;
    }
    insert(payload: Row | Row[]) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    private matches(r: Row): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private run(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const toInsert = Array.isArray(this.payload) ? this.payload : [this.payload];
        rows.push(...toInsert);
        return { data: toInsert, error: null };
      }
      return { data: rows.filter((r) => this.matches(r)), error: null };
    }
  }

  const client = { from: (_table: string) => new Builder() };
  return { rows, client };
}

describe("addOrderTags", () => {
  it("unions with existing tags, normalizing the new ones (trim/lowercase/dedupe)", async () => {
    const { rows, client } = makeStore();
    rows.push({ shop_id: "shop-1", order_id: "order-1", tag: "vip" });

    const result = await addOrderTags("shop-1", "order-1", [" Wholesale ", "vip", "Local"], client as never);

    expect(result).toEqual(["local", "vip", "wholesale"]);
    // never deletes: the pre-existing "vip" row is still there, untouched, plus the two new inserts.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.tag === "vip")).toHaveLength(1);
  });

  it("never issues a delete — only inserts the missing rows", async () => {
    const { rows, client } = makeStore();
    rows.push({ shop_id: "shop-1", order_id: "order-1", tag: "vip" });
    const deleteSpy = (client as { from: (t: string) => { delete?: () => void } }).from("order_tag");
    expect(deleteSpy.delete).toBeUndefined(); // the Builder above has no delete() at all

    await addOrderTags("shop-1", "order-1", ["wholesale"], client as never);
    expect(rows).toHaveLength(2);
  });

  it("adding a tag already present is a no-op (no duplicate insert)", async () => {
    const { rows, client } = makeStore();
    rows.push({ shop_id: "shop-1", order_id: "order-1", tag: "vip" });

    const result = await addOrderTags("shop-1", "order-1", ["VIP"], client as never);

    expect(result).toEqual(["vip"]);
    expect(rows).toHaveLength(1);
  });

  it("throws CalderynError 422 too_many_tags when the union would exceed 20, writing nothing", async () => {
    const { rows, client } = makeStore();
    for (let i = 0; i < 19; i++) rows.push({ shop_id: "shop-1", order_id: "order-1", tag: `tag${i}` });

    await expect(addOrderTags("shop-1", "order-1", ["new-a", "new-b"], client as never)).rejects.toMatchObject({
      status: 422,
      code: "too_many_tags",
    });
    expect(rows).toHaveLength(19); // nothing inserted
  });

  it("rejects an invalid entry (non-string / over-length) as a 422, writing nothing", async () => {
    const { rows, client } = makeStore();
    await expect(addOrderTags("shop-1", "order-1", ["ok", 42 as unknown as string], client as never)).rejects.toBeInstanceOf(
      CalderynError,
    );
    expect(rows).toHaveLength(0);
  });

  it("an empty add list returns the existing tags unchanged", async () => {
    const { rows, client } = makeStore();
    rows.push({ shop_id: "shop-1", order_id: "order-1", tag: "vip" });
    const result = await addOrderTags("shop-1", "order-1", [], client as never);
    expect(result).toEqual(["vip"]);
    expect(rows).toHaveLength(1);
  });
});
