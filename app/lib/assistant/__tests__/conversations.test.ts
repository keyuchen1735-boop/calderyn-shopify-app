/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
let idc = 0;

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let inserting: Row[] | null = null;
  let updating: Row | null = null;

  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const commitInsert = () => {
    const rows = (inserting ?? []).map((v) => ({
      id: `id-${++idc}`,
      created_at: new Date(1700000000000 + idc).toISOString(),
      updated_at: new Date(1700000000000 + idc).toISOString(),
      ...v,
    }));
    store[table] = [...(store[table] ?? []), ...rows];
    return rows;
  };
  const commitUpdate = () => {
    for (const r of store[table] ?? []) {
      if (filters.every(([k, v]) => r[k] === v)) Object.assign(r, updating);
    }
  };

  const api: any = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
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
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    single: async () => {
      if (inserting) return { data: commitInsert()[0], error: null };
      return { data: matches()[0] ?? null, error: null };
    },
    then: (resolve: (v: { data: any; error: null }) => void) => {
      if (inserting) return resolve({ data: commitInsert(), error: null });
      if (updating) {
        commitUpdate();
        return resolve({ data: null, error: null });
      }
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async (domain: string) =>
    domain === "a.myshopify.com" ? "shop-A" : "shop-B",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered before the module under test loads
import {
  createConversation,
  appendMessage,
  getMessages,
  listConversations,
} from "../conversations.server";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  idc = 0;
});

describe("conversations.server shop scoping", () => {
  it("a conversation created by shop A is invisible to shop B", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    expect(await listConversations("a.myshopify.com")).toHaveLength(1);
    expect(await listConversations("b.myshopify.com")).toHaveLength(0);
    expect(id).toMatch(/^id-/);
  });

  it("getMessages returns A's messages for A, and 404s for B", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    await appendMessage("a.myshopify.com", id, { role: "user", content: "hi" });
    const msgs = await getMessages("a.myshopify.com", id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hi");
    await expect(getMessages("b.myshopify.com", id)).rejects.toThrow(/not found/i);
  });

  it("shop B cannot append to shop A's conversation", async () => {
    const id = await createConversation("a.myshopify.com", "First");
    await expect(
      appendMessage("b.myshopify.com", id, { role: "user", content: "intrude" }),
    ).rejects.toThrow(/not found/i);
    expect(store["assistant_messages"] ?? []).toHaveLength(0);
  });
});

describe("conversations.server receipts and pending_action", () => {
  it("persists and returns receipts and pending_action on assistant messages", async () => {
    const convId = await createConversation("a.myshopify.com", "Test");
    const msg = await appendMessage("a.myshopify.com", convId, {
      role: "assistant",
      content: "Done.",
      receipts: [{ action: "pause_campaign", summary: 'Paused "X"', auditId: "a1", undoable: true }],
      pendingAction: null,
    });
    expect(msg.receipts).toHaveLength(1);
    expect(msg.receipts[0].auditId).toBe("a1");
    expect(msg.pendingAction).toBeNull();
  });

  it("defaults receipts to [] and pendingAction to null on legacy rows", async () => {
    const convId = await createConversation("a.myshopify.com", "Test");
    await appendMessage("a.myshopify.com", convId, { role: "user", content: "hi" });
    const msgs = await getMessages("a.myshopify.com", convId);
    expect(msgs[0].receipts).toEqual([]);
    expect(msgs[0].pendingAction).toBeNull();
  });
});
