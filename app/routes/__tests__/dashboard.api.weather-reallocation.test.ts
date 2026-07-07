import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";

const { requireSameOrigin, requireDashboardSession, executeReallocation, resolveWeatherAlert } =
  vi.hoisted(() => ({
    requireSameOrigin: vi.fn(),
    requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1" })),
    executeReallocation: vi.fn(async () => ({ outcome: "succeeded" })),
    resolveWeatherAlert: vi.fn(async () => undefined),
  }));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/actions/weather-suggest.server", () => ({ resolveWeatherAlert }));
vi.mock("~/lib/dashboard/http.server", async () => {
  const actual = await vi.importActual<typeof HttpServer>("~/lib/dashboard/http.server");
  return { ...actual, requireSameOrigin };
});
vi.mock("~/lib/actions/reallocate.server", () => ({ executeReallocation }));

// Shared mutable "row" backing the fake table. The mock honors an
// `.eq("status", ...)` precondition so it faithfully models the atomic
// conditional-UPDATE claim the route relies on (a non-pending row yields no row).
let suggestion: Record<string, unknown> | null;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => {
      const eqs: Record<string, unknown> = {};
      let mode: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      const ins: Record<string, unknown[]> = {};
      chain.select = () => chain;
      chain.update = (p: Record<string, unknown>) => { mode = "update"; patch = p; return chain; };
      chain.eq = (col: string, val: unknown) => { eqs[col] = val; return chain; };
      chain.in = (col: string, vals: unknown[]) => { ins[col] = vals; return chain; };
      // Apply eq preconditions; on a matching UPDATE, mutate the shared row.
      // Returns the row (or null when a precondition — e.g. status='pending' —
      // fails), faithfully modelling a conditional UPDATE ... RETURNING.
      const resolveRow = (): Record<string, unknown> | null => {
        const row = suggestion;
        if (!row) return null;
        if (eqs.id !== undefined && row.id !== eqs.id) return null;
        if (eqs.shop_id !== undefined && row.shop_id !== eqs.shop_id) return null;
        if (eqs.status !== undefined && row.status !== eqs.status) return null;
        if (ins.status !== undefined && !ins.status.includes(row.status)) return null;
        if (mode === "update") Object.assign(row, patch);
        return row;
      };
      chain.maybeSingle = async () => {
        const row = resolveRow();
        return { data: row ? { ...row } : null, error: null };
      };
      // Bare `await sb.from().update().eq()...` (no .maybeSingle()) executes the
      // write in real supabase-js — model that by making the builder thenable.
      chain.then = (
        resolve: (v: { data: null; error: null }) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve().then(() => { resolveRow(); return { data: null, error: null } as const; }).then(resolve, reject);
      return chain;
    },
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { action } from "../dashboard.api.weather-reallocation";

const post = (body: unknown) =>
  action({
    request: new Request("https://app.test/dashboard/api/weather-reallocation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);

beforeEach(() => {
  executeReallocation.mockReset();
  executeReallocation.mockResolvedValue({ outcome: "succeeded" });
  suggestion = {
    id: "sg1", shop_id: "shop-1", status: "pending",
    source_campaign_id: "src", dest_campaign_id: "dst", amount_cents: 3000,
  };
});

describe("weather-reallocation action", () => {
  it("applies a pending suggestion via executeReallocation and marks it applied", async () => {
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        sourceCampaignId: "src", destCampaignId: "dst", amountCents: 3000, idempotencyKey: "weather:sg1",
      }),
      expect.anything(),
    );
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("applied");
  });

  it("dismisses a pending suggestion without reallocating", async () => {
    const res = await post({ suggestionId: "sg1", intent: "dismiss" });
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("dismissed");
  });

  it("disarms an armed suggestion via dismiss (armed must always be cancellable)", async () => {
    suggestion!.status = "armed";
    const res = await post({ suggestionId: "sg1", intent: "dismiss" });
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("dismissed");
    expect(resolveWeatherAlert).toHaveBeenCalled();
  });

  it("applies an armed suggestion immediately (fire early)", async () => {
    suggestion!.status = "armed";
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("applied");
  });

  it("arms a pending suggestion for weather-triggered execution (no budget moves now)", async () => {
    const res = await post({ suggestionId: "sg1", intent: "arm" });
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("armed");
  });

  it("409s arming a non-pending suggestion", async () => {
    suggestion!.status = "applied";
    const res = await post({ suggestionId: "sg1", intent: "arm" });
    expect(res.status).toBe(409);
  });

  it("409s a non-pending suggestion (already applied) and does not execute", async () => {
    suggestion!.status = "applied";
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(409);
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("404s an unknown / wrong-shop suggestion", async () => {
    suggestion = null;
    const res = await post({ suggestionId: "nope", intent: "apply" });
    expect(res.status).toBe(404);
  });

  it("422s a bad intent", async () => {
    const res = await post({ suggestionId: "sg1", intent: "frobnicate" });
    expect(res.status).toBe(422);
  });

  it("marks the row 'failed' (terminal) on a permanent reallocation failure", async () => {
    executeReallocation.mockResolvedValueOnce({ outcome: "failed" });
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(502);
    expect(suggestion!.status).toBe("failed");
  });

  it("releases the row back to 'pending' when execution throws (retryable)", async () => {
    executeReallocation.mockRejectedValueOnce(new Error("network"));
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(502);
    expect(suggestion!.status).toBe("pending");
  });

  it("marks 'applied' on a 'retrying' outcome (in-flight, drained by retry sweep)", async () => {
    executeReallocation.mockResolvedValueOnce({ outcome: "retrying" });
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(200);
    expect(suggestion!.status).toBe("applied");
  });
});
