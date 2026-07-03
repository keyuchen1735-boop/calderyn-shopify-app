/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake mirrors supabase-js's loosely-typed builder */
//
// Behaviour tests for the EasyPost API-key connect/disconnect control plane
// (contract C7/C8, success criteria #1). They assert WHAT happens to the DB, not
// how:
//   • a valid key is live-probed, then stored ENCRYPTED in integration_credentials
//     (kind 'easypost_ship') and shop_integrations is set to sync_status='ready';
//   • a bad-key probe (401) throws and writes NOTHING;
//   • an empty key is rejected before any probe;
//   • disconnect clears BOTH the shop_integrations row and the stored credential;
//   • integrations.list surfaces the connected EasyPost row (default + connected).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { decrypt } from "../crypto.server";

// A 32-byte hex key so crypto.server.encrypt/decrypt work in-test.
process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);

// --- in-memory supabase fake (records upserts + deletes, serves reads) --------

interface Captured {
  upserts: Array<{ table: string; payload: any; onConflict?: string }>;
  deletes: Array<{ table: string; filters: Record<string, unknown> }>;
}

function makeFakeSupabase(seed: Record<string, any[]>): {
  sb: any;
  captured: Captured;
} {
  const tables: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = [...v];
  const captured: Captured = { upserts: [], deletes: [] };

  function chainFor(table: string) {
    let rows = [...(tables[table] ?? [])];
    const chain: any = {
      select() {
        return chain;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return chain;
      },
      upsert(payload: any, opts?: { onConflict?: string }) {
        captured.upserts.push({ table, payload, onConflict: opts?.onConflict });
        // Reflect the write so a later integrations.list read sees it.
        const arr = tables[table] ?? (tables[table] = []);
        const idx = arr.findIndex(
          (r) => r.shop_id === payload.shop_id && r.kind === payload.kind,
        );
        if (idx >= 0) arr[idx] = { ...arr[idx], ...payload };
        else arr.push({ ...payload });
        return Promise.resolve({ data: null, error: null });
      },
      delete() {
        const filters: Record<string, unknown> = {};
        const delChain: any = {
          eq(col: string, val: unknown) {
            filters[col] = val;
            return delChain;
          },
          then(cb: (r: { data: null; error: null }) => unknown) {
            captured.deletes.push({ table, filters });
            const arr = tables[table] ?? [];
            tables[table] = arr.filter(
              (r) => !Object.entries(filters).every(([k, v]) => r[k] === v),
            );
            return Promise.resolve(cb({ data: null, error: null }));
          },
        };
        return delChain;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(cb: (r: { data: any[]; error: null }) => unknown) {
        return Promise.resolve(cb({ data: rows, error: null }));
      },
    };
    return chain;
  }

  const sb = { from: (t: string) => chainFor(t) };
  return { sb, captured };
}

// resolveShopId is stubbed to a fixed id; getSupabase returns the per-test fake.
let currentSb: any = null;
vi.mock("../supabase.server", () => ({
  getSupabase: () => currentSb,
  resolveShopId: async () => "shop-1",
}));

// eslint-disable-next-line import/first -- must follow vi.mock so the fake registers first
import { calderynClient } from "../calderyn.server";

// 200 OK probe (valid key) and 401 probe (bad key).
const okFetch = (() =>
  Promise.resolve(
    new Response(JSON.stringify({ shipments: [], has_more: false }), { status: 200 }),
  )) as unknown as typeof fetch;
const unauthorizedFetch = (() =>
  Promise.resolve(new Response("unauthorized", { status: 401 }))) as unknown as typeof fetch;

describe("integrations.connectApiKey (EasyPost)", () => {
  beforeEach(() => {
    currentSb = null;
  });

  it("stores an ENCRYPTED credential + sets shop_integrations to 'ready' on a valid key", async () => {
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    const res = await client.integrations.connectApiKey("easypost", "EZAK_live_secret", okFetch);
    expect(res).toEqual({ kind: "easypost_ship" });

    // Credential row: under integration_credentials, kind easypost_ship, encrypted
    // (NOT the plaintext key), decryptable back to the original.
    const credUpsert = captured.upserts.find((u) => u.table === "integration_credentials");
    expect(credUpsert).toBeTruthy();
    expect(credUpsert!.onConflict).toBe("shop_id,kind");
    expect(credUpsert!.payload.kind).toBe("easypost_ship");
    expect(credUpsert!.payload.shop_id).toBe("shop-1");
    const stored = credUpsert!.payload.access_token_encrypted as string;
    expect(stored).not.toBe("EZAK_live_secret"); // encrypted at rest
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // ivHex:tagHex:dataHex
    expect(decrypt(stored)).toBe("EZAK_live_secret");

    // Merchant-facing status row: ready, error cleared, connected_at stamped.
    const integUpsert = captured.upserts.find((u) => u.table === "shop_integrations");
    expect(integUpsert).toBeTruthy();
    expect(integUpsert!.payload.kind).toBe("easypost_ship");
    expect(integUpsert!.payload.sync_status).toBe("ready");
    expect(integUpsert!.payload.sync_error).toBeNull();
    expect(integUpsert!.payload.connected_at).toBeTruthy();
  });

  it("rejects a bad key on the live probe (401) and writes NOTHING (rule 12)", async () => {
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await expect(
      client.integrations.connectApiKey("easypost", "bad-key", unauthorizedFetch),
    ).rejects.toMatchObject({ code: "EASYPOST_KEY_INVALID" });

    expect(captured.upserts).toHaveLength(0); // no credential, no status row
  });

  it("rejects an empty key before any probe or write", async () => {
    const probe = vi.fn();
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await expect(
      client.integrations.connectApiKey("easypost", "   ", probe as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "EMPTY_API_KEY" });
    expect(probe).not.toHaveBeenCalled();
    expect(captured.upserts).toHaveLength(0);
  });
});

// ShipHero connects by a credential/refresh-token PASTE (reclassified from OAuth): the
// merchant pastes their long-lived REFRESH token; connectApiKey live-probes it (a real
// /auth/refresh that mints an access token), then stores the REFRESH token encrypted under
// kind 'shiphero_ship' (the QuickBooks refresh-token storage model). A 200 with an
// access_token = valid; a 401 = bad/expired refresh token → reject before persisting.
const shipHeroOkRefresh = (() =>
  Promise.resolve(
    new Response(JSON.stringify({ access_token: "acc_minted", expires_in: 2419200 }), {
      status: 200,
    }),
  )) as unknown as typeof fetch;

describe("integrations.connectApiKey (ShipHero — credential/refresh-token paste)", () => {
  beforeEach(() => {
    currentSb = null;
  });

  it("stores the ENCRYPTED refresh token under kind 'shiphero_ship' + sets 'ready' on a valid token", async () => {
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    const res = await client.integrations.connectApiKey("shiphero", "shiphero_refresh_tok", shipHeroOkRefresh);
    expect(res).toEqual({ kind: "shiphero_ship" });

    const credUpsert = captured.upserts.find((u) => u.table === "integration_credentials");
    expect(credUpsert).toBeTruthy();
    expect(credUpsert!.onConflict).toBe("shop_id,kind");
    expect(credUpsert!.payload.kind).toBe("shiphero_ship");
    const stored = credUpsert!.payload.access_token_encrypted as string;
    expect(stored).not.toBe("shiphero_refresh_tok"); // encrypted at rest
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decrypt(stored)).toBe("shiphero_refresh_tok"); // we persist the REFRESH token

    const integUpsert = captured.upserts.find((u) => u.table === "shop_integrations");
    expect(integUpsert!.payload.kind).toBe("shiphero_ship");
    expect(integUpsert!.payload.sync_status).toBe("ready");
    expect(integUpsert!.payload.sync_error).toBeNull();
  });

  it("rejects a bad/expired refresh token on the live probe (401) and writes NOTHING (rule 12)", async () => {
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await expect(
      client.integrations.connectApiKey("shiphero", "bad-refresh", unauthorizedFetch),
    ).rejects.toMatchObject({ code: "SHIPHERO_TOKEN_INVALID" });

    expect(captured.upserts).toHaveLength(0); // no credential, no status row
  });

  it("rejects an empty refresh token before any probe or write", async () => {
    const probe = vi.fn();
    const { sb, captured } = makeFakeSupabase({ shop_integrations: [], integration_credentials: [] });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await expect(
      client.integrations.connectApiKey("shiphero", "   ", probe as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "EMPTY_API_KEY" });
    expect(probe).not.toHaveBeenCalled();
    expect(captured.upserts).toHaveLength(0);
  });
});

describe("integrations.disconnect (EasyPost)", () => {
  it("clears BOTH the shop_integrations row and the stored credential", async () => {
    const { sb, captured } = makeFakeSupabase({
      shop_integrations: [{ shop_id: "shop-1", kind: "easypost_ship", sync_status: "ready" }],
      integration_credentials: [
        { shop_id: "shop-1", kind: "easypost_ship", access_token_encrypted: "x:y:z" },
      ],
    });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await client.integrations.disconnect("easypost");

    const tables = captured.deletes.map((d) => d.table).sort();
    expect(tables).toEqual(["integration_credentials", "shop_integrations"]);
    for (const d of captured.deletes) {
      expect(d.filters).toMatchObject({ shop_id: "shop-1", kind: "easypost_ship" });
    }
  });

  it("clears BOTH the status row and the stored OAuth credential for an ad provider", async () => {
    const { sb, captured } = makeFakeSupabase({
      shop_integrations: [{ shop_id: "shop-1", kind: "google_ads", sync_status: "live" }],
      integration_credentials: [
        { shop_id: "shop-1", kind: "google_ads", access_token_encrypted: "x:y:z" },
      ],
    });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await client.integrations.disconnect("google");

    const tables = captured.deletes.map((d) => d.table).sort();
    expect(tables).toEqual(["integration_credentials", "shop_integrations"]);
    for (const d of captured.deletes) {
      expect(d.filters).toMatchObject({ shop_id: "shop-1", kind: "google_ads" });
    }
  });
});

describe("integrations.disconnect (Shippo — Phase 2)", () => {
  it("clears BOTH the shop_integrations row and the NON-EXPIRING OAuth token (Plan 02 §11 #6)", async () => {
    // Shippo's OAuth token never expires, so disconnect MUST delete the credential;
    // like every credential-bearing connector, leaving it would orphan a valid token.
    const { sb, captured } = makeFakeSupabase({
      shop_integrations: [{ shop_id: "shop-1", kind: "shippo_ship", sync_status: "ready" }],
      integration_credentials: [
        { shop_id: "shop-1", kind: "shippo_ship", access_token_encrypted: "x:y:z" },
      ],
    });
    currentSb = sb;
    const client = calderynClient("x.myshopify.com");

    await client.integrations.disconnect("shippo");

    const tables = captured.deletes.map((d) => d.table).sort();
    expect(tables).toEqual(["integration_credentials", "shop_integrations"]);
    // Both deletes target the shippo_ship kind (not the bare "shippo" provider string).
    for (const d of captured.deletes) {
      expect(d.filters).toMatchObject({ shop_id: "shop-1", kind: "shippo_ship" });
    }
  });
});

describe("integrations.list includes Shippo (Phase 2 — dashboard parity)", () => {
  it("defaults to a disconnected Shippo entry even with no rows", async () => {
    const { sb } = makeFakeSupabase({ shop_integrations: [] });
    currentSb = sb;
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.shippo_ship).toMatchObject({ name: "Shippo", status: "disconnected" });
  });

  it("surfaces a 'ready' Shippo row as connected", async () => {
    const { sb } = makeFakeSupabase({
      shop_integrations: [
        {
          shop_id: "shop-1",
          kind: "shippo_ship",
          sync_status: "ready",
          connected_at: "2026-06-16T00:00:00Z",
          external_account_id: "acct-9",
          sync_error: null,
        },
      ],
    });
    currentSb = sb;
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.shippo_ship.status).toBe("connected");
    expect(out.shippo_ship.name).toBe("Shippo");
  });
});

describe("integrations.list includes EasyPost", () => {
  it("defaults to a disconnected EasyPost entry even with no rows", async () => {
    const { sb } = makeFakeSupabase({ shop_integrations: [] });
    currentSb = sb;
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.easypost_ship).toMatchObject({ name: "EasyPost", status: "disconnected" });
  });

  it("surfaces a 'ready' EasyPost row as connected", async () => {
    const { sb } = makeFakeSupabase({
      shop_integrations: [
        {
          shop_id: "shop-1",
          kind: "easypost_ship",
          sync_status: "ready",
          connected_at: "2026-06-16T00:00:00Z",
          external_account_id: null,
          sync_error: null,
        },
      ],
    });
    currentSb = sb;
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.easypost_ship.status).toBe("connected");
    expect(out.easypost_ship.name).toBe("EasyPost");
  });
});
