import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWeatherExecuteForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";

const SHOP = "11111111-1111-1111-1111-111111111111";

// Shared mutable weather_suggestion "table". The fake honors .eq / .in / .lt
// preconditions on UPDATE (id / shop_id / status / expires_on), faithfully
// modelling the conditional claim (armed → applying) the sweep relies on to
// never double-execute, and the batch stale-pending expiry.
let rows: Array<Record<string, unknown>>;
let sensitivity = 100;

function fakeSb() {
  return {
    from: (table: string) => {
      const eqs: Record<string, unknown> = {};
      const ins: Record<string, unknown[]> = {};
      const lts: Record<string, string> = {};
      let mode: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = (p: Record<string, unknown>) => {
        mode = "update";
        patch = p;
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        eqs[col] = val;
        return chain;
      };
      chain.in = (col: string, vals: unknown[]) => {
        ins[col] = vals;
        return chain;
      };
      chain.lt = (col: string, val: string) => {
        lts[col] = val;
        return chain;
      };
      const matches = (r: Record<string, unknown>) =>
        Object.entries(eqs).every(([k, v]) => r[k] === v) &&
        Object.entries(ins).every(([k, vals]) => vals.includes(r[k])) &&
        Object.entries(lts).every(([k, v]) => String(r[k]) < v);
      const resolve = () => {
        if (table === "guardrail_config")
          return [{ weather_sensitivity: sensitivity, merchant_lat: null, merchant_lon: null }];
        if (table !== "weather_suggestion") return [];
        const hit = rows.filter(matches);
        if (mode === "update") hit.forEach((r) => Object.assign(r, patch));
        return hit.map((r) => ({ ...r }));
      };
      chain.maybeSingle = async () => ({ data: resolve()[0] ?? null, error: null });
      chain.then = (res: (v: { data: unknown; error: null }) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => ({ data: resolve(), error: null }) as const)
          .then(res, rej);
      return chain;
    },
  } as unknown as SupabaseClient;
}

const armedRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "ws1",
  shop_id: SHOP,
  status: "armed",
  source_region: "us-west",
  dest_region: "us-east",
  source_campaign_id: "src",
  dest_campaign_id: "dst",
  amount_cents: 2500,
  expires_on: "2026-07-09",
  ...over,
});

// Fresh forecasts: east clearly worse weather than west → gap holds.
const gapHolds = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
  ["us-east", { avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 }],
]);
// Identical forecasts → zero gap.
const gapClosed = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 20, precipMm: 5, snowCm: 0, avgDaylightH: 12 }],
  ["us-east", { avgTempC: 20, precipMm: 5, snowCm: 0, avgDaylightH: 12 }],
]);

const execute = vi.fn(async () => ({ outcome: "succeeded" }));

beforeEach(() => {
  execute.mockClear();
  execute.mockResolvedValue({ outcome: "succeeded" });
  sensitivity = 100;
});

describe("runWeatherExecuteForShop", () => {
  it("executes an armed prediction when the fresh forecast confirms the gap", async () => {
    rows = [armedRow()];
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 1, expired: 0, held: 0 });
    expect(execute).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        sourceCampaignId: "src",
        destCampaignId: "dst",
        amountCents: 2500,
        idempotencyKey: "weather:ws1",
        actor: "autopilot",
        triggerReason: "weather_armed",
      }),
      expect.anything(),
    );
    expect(rows[0].status).toBe("applied");
  });

  it("expires an armed prediction past its window without moving budget", async () => {
    rows = [armedRow({ expires_on: "2026-07-06" })];
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 0, expired: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("expired");
  });

  it("holds (stays armed) while the window is open but the gap has closed", async () => {
    rows = [armedRow()];
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapClosed,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 0, expired: 0, held: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("armed");
  });

  it("marks the row failed (terminal) when execution throws — post-mutation throws are not retryable", async () => {
    rows = [armedRow()];
    execute.mockRejectedValueOnce(new Error("network"));
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    // executeReallocation moves budget on-platform before writing its
    // idempotency record; releasing back to armed would let tomorrow's sweep
    // double-move it. A post-mutation throw is not safely retryable.
    expect(rows[0].status).toBe("failed");
  });

  it("disarms (expires) armed rows without executing when the dial is turned to 0", async () => {
    rows = [armedRow()];
    sensitivity = 0;
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 0, expired: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("expired");
  });

  it("retires stale pending rows past their window", async () => {
    rows = [armedRow({ id: "p1", status: "pending", expires_on: "2026-07-06" })];
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(rows[0].status).toBe("expired");
    expect(r.executed).toBe(0);
  });

  it("marks the row failed when execution reports a permanent failure", async () => {
    rows = [armedRow()];
    execute.mockResolvedValueOnce({ outcome: "failed" });
    const r = await runWeatherExecuteForShop(SHOP, fakeSb(), {
      fetchForecasts: async () => gapHolds,
      today: "2026-07-07",
      execute,
    });
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    expect(rows[0].status).toBe("failed");
  });
});
