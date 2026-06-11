/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake models supabase-js's loosely-typed query builder */
//
// Onboarding step persistence round-trip through the real calderynClient.
//
// The onboarding UI (app/routes/app.onboarding.tsx) and the persistence layer
// (ONBOARDING_STEPS in calderyn.server.ts) each hold an 8-entry step list and
// talk to each other ONLY via numeric indices: the route submits the index it
// wants, advance() persists the name at that index, getState() maps the stored
// name back to its index. These tests pin that index round-trip — if either
// list changes length or getState/advance stop being inverses, a merchant
// reloading mid-onboarding lands on the wrong step.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  let pendingUpdate: Row | null = null;
  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const applyUpdate = () => {
    if (pendingUpdate) for (const row of matches()) Object.assign(row, pendingUpdate);
  };
  const api: any = {
    select: () => api,
    update: (u: Row) => {
      pendingUpdate = u;
      return api;
    },
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    single: async () => {
      applyUpdate();
      return { data: matches()[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      applyUpdate();
      return { data: matches()[0] ?? null, error: null };
    },
    then: (resolve: (v: { data: any; error: null }) => void) => {
      applyUpdate();
      return resolve({ data: matches(), error: null });
    },
  };
  return api;
}

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async () => "shop-A",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered before the module under test loads
import { calderynClient } from "../calderyn.server";

const TOTAL_STEPS = 8; // mirrors STEPS in app.onboarding.tsx and ONBOARDING_STEPS in calderyn.server.ts

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store["shops"] = [
    { id: "shop-A", onboarding_step: "shopify", onboarding_completed_at: null },
  ];
});

describe("onboarding state persistence", () => {
  it("round-trips every step index through advance() and getState()", async () => {
    const client = calderynClient("a.myshopify.com");
    for (let i = 0; i < TOTAL_STEPS; i++) {
      await client.onboarding.advance(i);
      const state = await client.onboarding.getState();
      expect(state.step).toBe(i);
    }
  });

  it("marks onboarding done when the route's finish intent advances past the last step", async () => {
    const client = calderynClient("a.myshopify.com");
    // The route's "finish" intent submits STEPS.length (8); advance clamps to "complete".
    await client.onboarding.advance(TOTAL_STEPS);

    expect(store["shops"][0].onboarding_step).toBe("complete");
    expect(store["shops"][0].onboarding_completed_at).toBeTruthy();
    const state = await client.onboarding.getState();
    expect(state.done).toBe(true);
  });

  it("falls back to step 0 when the persisted step name is unrecognized", async () => {
    store["shops"][0].onboarding_step = "legacy_step_name";
    const client = calderynClient("a.myshopify.com");

    const state = await client.onboarding.getState();
    expect(state.step).toBe(0);
    expect(state.done).toBe(false);
  });

  it("persists step NAMES in the wizard's order (semantic contract with app.onboarding.tsx)", async () => {
    // The index round-trip above passes for ANY 8-entry list — it never failed
    // while the server enum was in a different order than the wizard, which
    // persisted wrong step names for cross-surface readers of
    // shops.onboarding_step. Pin the names at each index to the wizard's flow:
    // Shop → Guardrails → Google → Meta → QuickBooks → Creative → Consent → Complete.
    const expected = [
      "shopify",
      "guardrails",
      "google",
      "meta",
      "quickbooks",
      "creative_mapping",
      "consent",
      "complete",
    ];
    const client = calderynClient("a.myshopify.com");
    for (let i = 0; i < expected.length; i++) {
      await client.onboarding.advance(i);
      expect(store["shops"][0].onboarding_step).toBe(expected[i]);
    }
  });
});
