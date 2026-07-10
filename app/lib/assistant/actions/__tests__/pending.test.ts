/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
let idc = 0;

function makeBuilder(table: string) {
  const filters: Array<[string, any, string]> = []; // [key, value, operator]
  let inserting: Row[] | null = null;
  let updating: Row | null = null;
  let selecting: string[] | null = null;

  const matches = () => {
    return (store[table] ?? []).filter((r) => {
      return filters.every(([k, v, op]) => {
        if (op === "eq") return r[k] === v;
        if (op === "gt") return r[k] > v;
        if (op === "ne") return r[k] !== v;
        return false;
      });
    });
  };

  const commitInsert = () => {
    const rows = (inserting ?? []).map((v) => ({
      id: `id-${++idc}`,
      status: "pending",
      created_at: new Date(1700000000000 + idc).toISOString(),
      ...v,
    }));
    store[table] = [...(store[table] ?? []), ...rows];
    return rows;
  };

  const commitUpdate = () => {
    const rows = store[table] ?? [];
    const matched = [];
    for (const r of rows) {
      if (filters.every(([k, v, op]) => {
        if (op === "eq") return r[k] === v;
        if (op === "gt") return r[k] > v;
        if (op === "ne") return r[k] !== v;
        return false;
      })) {
        Object.assign(r, updating);
        matched.push(r);
      }
    }
    return matched;
  };

  const api: any = {
    select: (cols?: string) => {
      if (cols) selecting = cols.split(",").map((s) => s.trim());
      return api;
    },
    eq: (k: string, v: any) => {
      filters.push([k, v, "eq"]);
      return api;
    },
    gt: (k: string, v: any) => {
      filters.push([k, v, "gt"]);
      return api;
    },
    ne: (k: string, v: any) => {
      filters.push([k, v, "ne"]);
      return api;
    },
    insert: (vals: Row | Row[]) => {
      inserting = Array.isArray(vals) ? vals : [vals];
      return api;
    },
    update: (vals: Row) => {
      updating = vals;
      return api;
    },
    maybeSingle: async () => {
      let rows = matches();
      if (updating) {
        rows = commitUpdate();
      }
      if (rows.length === 0) return { data: null, error: null };
      let row = rows[0];
      if (selecting) {
        const selected: Record<string, any> = {};
        for (const col of selecting) {
          selected[col] = row[col];
        }
        row = selected;
      }
      return { data: row, error: null };
    },
    single: async () => {
      if (inserting) return { data: commitInsert()[0], error: null };
      const m = matches();
      return { data: m[0] ?? null, error: null };
    },
    then: (resolve: (v: { data: any; error: null }) => void) => {
      if (inserting) return resolve({ data: commitInsert(), error: null });
      if (updating) {
        const updated = commitUpdate();
        return resolve({ data: updated.length > 0 ? updated[0] : null, error: null });
      }
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

vi.mock("../../../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered before the module under test loads
import { createPendingAction, claimPendingAction, dismissPendingAction, markPendingExecuted } from "../pending.server";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  idc = 0;
});

describe("pending actions", () => {
  it("createPendingAction returns a card with a ~10 minute expiry", async () => {
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund $10.00 to order o1"
    );
    expect(card.action).toBe("issue_refund");
    expect(card.summary).toBe("Refund $10.00 to order o1");
    const msLeft = new Date(card.expiresAt).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(9 * 60_000);
    expect(msLeft).toBeLessThanOrEqual(10 * 60_000);
  });

  it("claimPendingAction is single-use: the claiming UPDATE filters status=pending", async () => {
    // Create a pending action
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund"
    );

    // First claim should succeed
    const first = await claimPendingAction("shop-1", card.id);
    expect("action" in first).toBe(true);
    if ("action" in first) {
      expect(first.action).toBe("issue_refund");
    }

    // Second claim should fail
    const second = await claimPendingAction("shop-1", card.id);
    expect(second).toEqual({ error: "already_used" });
  });

  it("claimPendingAction refuses an expired row", async () => {
    // Manually insert an expired action in the store
    const now = new Date().toISOString();
    const expired = new Date(Date.now() - 1000).toISOString(); // 1 second in the past
    store["assistant_pending_actions"] = [
      {
        id: "p-expired",
        shop_id: "shop-1",
        conversation_id: "conv-1",
        action: "issue_refund",
        input: { order_id: "o1" },
        summary: "Refund",
        status: "pending",
        expires_at: expired,
        created_at: now,
      },
    ];

    const r = await claimPendingAction("shop-1", "p-expired");
    expect(r).toEqual({ error: "expired" });
  });

  it("claimPendingAction scopes by shop_id (foreign shop gets not_found)", async () => {
    // Create action for shop-1
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund"
    );

    // Try to claim as shop-OTHER
    const r = await claimPendingAction("shop-OTHER", card.id);
    expect(r).toEqual({ error: "not_found" });
  });

  it("dismissPendingAction sets status to dismissed", async () => {
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund"
    );

    const dismissed = await dismissPendingAction("shop-1", card.id);
    expect(dismissed).toBe(true);

    // Verify status changed
    const rows = store["assistant_pending_actions"] ?? [];
    const row = rows.find((r) => r.id === card.id);
    expect(row?.status).toBe("dismissed");
  });

  it("dismissPendingAction returns false if action not found or already used", async () => {
    const result = await dismissPendingAction("shop-1", "nonexistent");
    expect(result).toBe(false);
  });

  it("markPendingExecuted updates executed_audit_id", async () => {
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund"
    );

    await markPendingExecuted("shop-1", card.id, "audit-123");

    const rows = store["assistant_pending_actions"] ?? [];
    const row = rows.find((r) => r.id === card.id);
    expect(row?.executed_audit_id).toBe("audit-123");
  });

  it("markPendingExecuted accepts null auditId", async () => {
    const card = await createPendingAction(
      "shop-1",
      "conv-1",
      "issue_refund",
      { order_id: "o1" },
      "Refund"
    );

    await markPendingExecuted("shop-1", card.id, null);

    const rows = store["assistant_pending_actions"] ?? [];
    const row = rows.find((r) => r.id === card.id);
    expect(row?.executed_audit_id).toBeNull();
  });
});
