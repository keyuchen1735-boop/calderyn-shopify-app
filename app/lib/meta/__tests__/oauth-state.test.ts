/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOAuthState, consumeOAuthState, OAUTH_STATE_TTL_MS } from "../oauth-state.server";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let inserting: Row[] | null = null;
  let deleting = false;

  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));

  const api: any = {
    select: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    insert: (vals: Row | Row[]) => {
      inserting = Array.isArray(vals) ? vals : [vals];
      return api;
    },
    delete: () => {
      deleting = true;
      return api;
    },
    maybeSingle: async () => {
      if (deleting) {
        const hit = matches()[0] ?? null;
        if (hit) store[table] = (store[table] ?? []).filter((r) => r !== hit);
        return { data: hit, error: null };
      }
      return { data: matches()[0] ?? null, error: null };
    },
    then: (resolve: (v: { data: any; error: null }) => void) => {
      if (inserting) {
        const rows = inserting.map((v) => ({ created_at: new Date().toISOString(), ...v }));
        store[table] = [...(store[table] ?? []), ...rows];
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

const sb = { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("createOAuthState", () => {
  it("stores a nonce bound to the shop and returns it", async () => {
    const nonce = await createOAuthState(sb, "shop-A");
    expect(nonce).toBeTruthy();
    expect(store["oauth_state"]).toHaveLength(1);
    expect(store["oauth_state"][0]).toMatchObject({ nonce, shop_id: "shop-A" });
  });

  it("generates a distinct, unguessable nonce each call", async () => {
    const a = await createOAuthState(sb, "shop-A");
    const b = await createOAuthState(sb, "shop-A");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("consumeOAuthState", () => {
  it("returns the bound shop_id and consumes the nonce (single-use)", async () => {
    const nonce = await createOAuthState(sb, "shop-A");
    expect(await consumeOAuthState(sb, nonce)).toBe("shop-A");
    // Replay must fail: the row is gone.
    expect(await consumeOAuthState(sb, nonce)).toBeNull();
  });

  it("returns null for an unknown nonce", async () => {
    expect(await consumeOAuthState(sb, "never-issued")).toBeNull();
  });

  it("returns null for an empty nonce without touching the store", async () => {
    expect(await consumeOAuthState(sb, "")).toBeNull();
  });

  it("rejects an expired nonce (older than the TTL)", async () => {
    const old = new Date(Date.now() - OAUTH_STATE_TTL_MS - 1000).toISOString();
    store["oauth_state"] = [{ nonce: "stale", shop_id: "shop-A", created_at: old }];
    expect(await consumeOAuthState(sb, "stale")).toBeNull();
  });
});
