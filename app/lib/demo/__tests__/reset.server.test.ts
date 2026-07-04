// app/lib/demo/__tests__/reset.server.test.ts
//
// The reset orchestrator must be unreachable for real shops (the wipe is
// destructive), wipe children before parents, and only insert the showcase
// layer after the catalog promote has materialized its FK targets.
import { describe, it, expect } from "vitest";
import { resetDemoShowcase, SHOWCASE_WIPE_ORDER } from "../reset.server";

const SHOP_ID = "9c6d1f6e-15aa-4b60-9a30-1c8a26cf62d1";

interface FakeClient {
  ops: string[];
  from(table: string): Record<string, unknown>;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }>;
}

function fakeClient(opts: { demoMode: boolean | null }): FakeClient {
  const ops: string[] = [];
  return {
    ops,
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === "shops" && opts.demoMode !== null ? { demo_mode: opts.demoMode } : null,
              error: null,
            }),
          }),
        }),
        delete: () => ({
          eq: (_c: string, _v: string) => {
            ops.push(`del:${table}`);
            return Promise.resolve({ error: null });
          },
        }),
        insert: (rows: unknown[]) => {
          ops.push(`ins:${table}:${rows.length}`);
          return Promise.resolve({ error: null });
        },
        upsert: (_row: unknown, _o?: unknown) => {
          ops.push(`ups:${table}`);
          return Promise.resolve({ error: null });
        },
        update: (_patch: unknown) => ({
          eq: (_c: string, _v: string) => {
            ops.push(`upd:${table}`);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    rpc: async (name: string) => {
      ops.push(`rpc:${name}`);
      return { data: { products: 12, variants: 28, collections: 3, balances: 112 }, error: null };
    },
  };
}

const TODAY = "2026-07-03";

describe("SHOWCASE_WIPE_ORDER", () => {
  it("deletes every FK child before its parent", () => {
    const order: readonly string[] = SHOWCASE_WIPE_ORDER;
    const idx = (t: string) => {
      const i = order.indexOf(t);
      expect(i, `${t} missing from wipe order`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const before: [string, string][] = [
      ["undo_token", "buyer_dim"], // undo_token → action_audit (wiped later by the seed writer)
      ["assistant_messages", "assistant_conversations"],
      ["transaction_ledger", "payment_intent"],
      ["payment_intent", "orders"],
      ["cart_line", "cart"],
      ["checkout_session", "cart"],
      ["order_state_transition", "orders"],
      ["order_line", "orders"],
      ["order_line", "variant_dim"],
      ["inventory_balance", "variant_dim"],
      ["buyer_address", "buyer_dim"],
      ["buyer_consent", "buyer_dim"],
      ["orders", "buyer_dim"],
      ["imported_order_line", "imported_order"],
      ["imported_refund", "imported_order"],
      ["variant_shipping", "variant_dim"],
      ["variant_dim", "product_dim"],
      ["import_map", "variant_dim"],
      ["store_generation_proposal", "store_generation"],
    ];
    for (const [child, parent] of before) {
      expect(idx(child), `${child} must be wiped before ${parent}`).toBeLessThan(idx(parent));
    }
  });

  it("only lists tables that carry a shop_id column (no-shop_id children cascade)", () => {
    // These cascade from product_dim / variant_dim / collection_dim deletes;
    // a delete().eq("shop_id") against them would 42703 and abort the reset.
    for (const t of [
      "product_media",
      "variant_option_value",
      "product_option_value",
      "product_option",
      "product_collection",
    ]) {
      expect(SHOWCASE_WIPE_ORDER).not.toContain(t);
    }
  });
});

describe("resetDemoShowcase", () => {
  it("refuses a non-demo shop before touching any table", async () => {
    const sb = fakeClient({ demoMode: false });
    await expect(
      resetDemoShowcase(SHOP_ID, sb as never, { today: TODAY }),
    ).rejects.toMatchObject({ code: "not_demo_shop", status: 409 });
    expect(sb.ops.filter((o) => o.startsWith("del:"))).toEqual([]);
    expect(sb.ops.filter((o) => o.startsWith("ins:"))).toEqual([]);
  });

  it("refuses an unknown shop", async () => {
    const sb = fakeClient({ demoMode: null });
    await expect(
      resetDemoShowcase(SHOP_ID, sb as never, { today: TODAY }),
    ).rejects.toMatchObject({ code: "not_demo_shop" });
  });

  it("wipes, reseeds, promotes, then layers owned rows — in that order", async () => {
    const sb = fakeClient({ demoMode: true });
    const summary = await resetDemoShowcase(SHOP_ID, sb as never, { today: TODAY });

    const at = (op: string) => {
      const i = sb.ops.findIndex((o) => o === op || o.startsWith(op));
      expect(i, `${op} never ran`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Extended wipe precedes the fact reseed; promote runs after the facts
    // exist; the owned layer (FKs onto promoted variants) comes last.
    // Trailing colons keep prefixes exact (ins:order_line vs ins:order_line_fact).
    expect(at("del:undo_token")).toBeLessThan(at("ins:sku_dim:"));
    expect(at("ins:sku_dim:")).toBeLessThan(at("rpc:promote_shop_from_mirror"));
    expect(at("rpc:promote_shop_from_mirror")).toBeLessThan(at("ins:buyer_dim:"));
    expect(at("ins:buyer_dim:")).toBeLessThan(at("ins:orders:"));
    expect(at("ins:orders:")).toBeLessThan(at("ins:order_line:"));
    expect(at("ins:alerts:")).toBeLessThan(at("ins:alert_context:"));
    expect(at("ins:alerts:")).toBeLessThan(at("ins:action_audit:"));
    // Config restore happens. guardrail_config is an upsert — owned-signup
    // shops may have no row yet and an update would silently match nothing.
    expect(sb.ops).toContain("ups:store_settings");
    expect(sb.ops).toContain("ups:guardrail_config");
    expect(sb.ops).toContain("upd:shops");

    // Both wipe passes are reported: the extended list, then the writer's own.
    expect(summary.wiped.slice(0, SHOWCASE_WIPE_ORDER.length)).toEqual([...SHOWCASE_WIPE_ORDER]);
    expect(summary.wiped.length).toBeGreaterThan(SHOWCASE_WIPE_ORDER.length);
    expect(summary.wiped).toContain("action_audit");
    expect(summary.inserted.sku_dim).toBeGreaterThan(0);
    expect(summary.inserted.orders).toBeGreaterThan(0);
    expect(summary.inserted.alerts).toBeGreaterThan(0);
    expect(summary.promoted).toMatchObject({ products: 12, variants: 28 });
  });

  it("aborts on the first failing wipe", async () => {
    const sb = fakeClient({ demoMode: true });
    const failing = {
      ...sb,
      from(table: string) {
        if (table === "buyer_dim") {
          return {
            delete: () => ({ eq: () => Promise.resolve({ error: { message: "boom" } }) }),
          };
        }
        return sb.from(table);
      },
    };
    await expect(
      resetDemoShowcase(SHOP_ID, failing as never, { today: TODAY }),
    ).rejects.toThrow(/buyer_dim.*boom/);
    expect(sb.ops.filter((o) => o.startsWith("ins:"))).toEqual([]);
  });
});
