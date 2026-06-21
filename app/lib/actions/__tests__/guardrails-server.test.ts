import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "../guardrails.server";

const SHOP = "00000000-0000-0000-0000-000000000010";
const CAMP = "11111111-1111-1111-1111-111111111111";

const config = {
  autopilot_enabled: true, autopilot_daily_action_cap: 3, autopilot_min_spend_cents: 20000,
  autopilot_max_budget_cut_pct: 50, autopilot_max_budget_increase_pct: 20, autopilot_max_daily_budget_cents: null,
  dollar_impact_cap_without_2fa: 10000, cooldown_minutes_per_campaign: 30,
  business_hours_only: false, business_hours_start_utc: 14, business_hours_end_utc: 0,
};

function fakeSb(opts: { config?: Record<string, unknown> | null; todayCount?: number; lastActionAtIso?: string | null; lastActionAtIsoQueue?: Array<string | null> }) {
  const cooldownQueue = [...(opts.lastActionAtIsoQueue ?? [opts.lastActionAtIso ?? null])];
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.or = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === "guardrail_config") return { data: opts.config !== undefined ? opts.config : config, error: null };
      if (table === "action_audit") {
        const iso = cooldownQueue.length ? cooldownQueue.shift() : null;
        return { data: iso ? { created_at: iso } : null, error: null };
      }
      return { data: null, error: null };
    });
    // count query: head:true select returns { count }
    chain.then = (resolve: (r: { count: number; data: unknown; error: null }) => unknown) =>
      resolve({ count: opts.todayCount ?? 0, data: [], error: null });
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
}

describe("checkGuardrails", () => {
  beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-06-06T16:00:00Z")));
  afterAll(() => vi.useRealTimers());

  it("allows when config + counts are within bounds", async () => {
    const sb = fakeSb({ todayCount: 0, lastActionAtIso: null });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000,
      campaignSpendCents: 50000, currentBudgetCents: 10000, newBudgetCents: undefined,
    }, sb);
    expect(r.allowed).toBe(true);
  });

  it("blocks when the shop has no guardrail config", async () => {
    const sb = fakeSb({ config: null });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(r.allowed).toBe(false);
  });

  it("passes the today autopilot count into the evaluator (cap)", async () => {
    const sb = fakeSb({ todayCount: 3 });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(r).toMatchObject({ allowed: false });
  });

  it("treats a null daily-cap row as unlimited — a huge today-count still allows", async () => {
    // The DB column is nullable; null = no cap. checkGuardrails must map null
    // through to the evaluator and skip the daily-cap check entirely.
    const sb = fakeSb({ config: { ...config, autopilot_daily_action_cap: null }, todayCount: 999 });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(r.allowed).toBe(true);
  });

  it("counts only SUCCEEDED autopilot actions toward the daily cap", async () => {
    // A day of retrying/failed attempts must not exhaust the cap with zero
    // landed actions — the count query has to filter outcome=succeeded.
    const eqCallsByChain: Array<Array<[string, string]>> = [];
    function builder(table: string) {
      const chain: Record<string, unknown> = {};
      const eqCalls: Array<[string, string]> = [];
      if (table === "action_audit") eqCallsByChain.push(eqCalls);
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn((col: string, val: string) => {
        eqCalls.push([col, val]);
        return chain;
      });
      chain.gte = vi.fn(() => chain);
      chain.or = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () =>
        table === "guardrail_config" ? { data: config, error: null } : { data: null, error: null },
      );
      chain.then = (resolve: (r: { count: number; data: unknown; error: null }) => unknown) =>
        resolve({ count: 0, data: [], error: null });
      return chain;
    }
    const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
    await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP, dollarImpactCents: 5000, campaignSpendCents: 50000,
    }, sb);
    expect(eqCallsByChain.some((calls) =>
      calls.some(([col, val]) => col === "outcome" && val === "succeeded"),
    )).toBe(true);
  });

  it("blocks a reallocation whose DEST campaign is in cooldown", async () => {
    // Source lookup (first action_audit call) → null; dest lookup → recent.
    const sb = fakeSb({ todayCount: 0, lastActionAtIsoQueue: [null, "2026-06-06T15:50:00Z"] });
    const r = await checkGuardrails(SHOP, {
      kind: "reallocate_budget", campaignId: CAMP,
      destCampaignId: "22222222-2222-2222-2222-222222222222",
      dollarImpactCents: 500, campaignSpendCents: 50000,
      currentBudgetCents: 2000, newBudgetCents: 1500,
    }, sb);
    expect(r).toEqual({ allowed: false, reason: "destination campaign in cooldown" });
  });

  it("allows a reallocation when neither campaign is in cooldown", async () => {
    const sb = fakeSb({ todayCount: 0, lastActionAtIsoQueue: [null, null] });
    const r = await checkGuardrails(SHOP, {
      kind: "reallocate_budget", campaignId: CAMP,
      destCampaignId: "22222222-2222-2222-2222-222222222222",
      dollarImpactCents: 500, campaignSpendCents: 50000,
      currentBudgetCents: 2000, newBudgetCents: 1500,
    }, sb);
    expect(r).toEqual({ allowed: true });
  });

  it("cooldown-blocks a pause on a campaign recently touched as a reallocation DESTINATION", async () => {
    // The single cooldown lookup matches params->>campaign_id OR
    // params->>dest_campaign_id (see minutesSinceLastAutopilotActionOn) — a
    // recent reallocation INTO this campaign counts as a recent touch.
    const sb = fakeSb({ todayCount: 0, lastActionAtIsoQueue: ["2026-06-06T15:50:00Z"] });
    const r = await checkGuardrails(SHOP, {
      kind: "pause_campaign", campaignId: CAMP,
      dollarImpactCents: 500, campaignSpendCents: 50000,
    }, sb);
    expect(r).toEqual({ allowed: false, reason: "campaign in cooldown" });
  });

  it("maps autopilot_bypass_guardrails through and waives every gate", async () => {
    // Bypass column true + a today-count well over the cap: the row must map to
    // bypassGuardrails and the evaluator must allow despite the breached cap.
    const sb = fakeSb({ config: { ...config, autopilot_bypass_guardrails: true }, todayCount: 999 });
    const r = await checkGuardrails(SHOP, {
      kind: "increase_campaign_budget", campaignId: CAMP,
      dollarImpactCents: 99999999, campaignSpendCents: 0,
      currentBudgetCents: 10000, newBudgetCents: 99999,
    }, sb);
    expect(r.allowed).toBe(true);
  });

  it("loads the increase cap and blocks an over-cap increase", async () => {
    const sb = fakeSb({ todayCount: 0, lastActionAtIso: null });
    const r = await checkGuardrails(SHOP, {
      kind: "increase_campaign_budget", campaignId: CAMP,
      dollarImpactCents: 10000, campaignSpendCents: 50000,
      currentBudgetCents: 10000, newBudgetCents: 13000,
    }, sb);
    expect(r).toEqual({ allowed: false, reason: "budget increase exceeds max" });
  });
});
