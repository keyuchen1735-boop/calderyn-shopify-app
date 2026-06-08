// app/lib/simulator/__tests__/orchestrate.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeSimulation } from "../orchestrate.server";
import { DEMO_MODEL } from "../demo";
import type { BehaviorModel, SimulationRun, StoreSnapshot } from "../types";

const snapshot: StoreSnapshot = {
  shop: "acme.myshopify.com", homeText: "h", product: null,
  shipping: { amount: 9.95, currency: "USD", estimated: false },
};
const model: BehaviorModel = {
  storeSummary: "s", shipping: snapshot.shipping,
  archetypes: [{ id: "a", name: "A", weight: 1, advance: { landed: 1, viewed_product: 1, added_to_cart: 1, started_checkout: 1, shipping_reveal: 1, bought: 1 }, dropReason: {} }],
  findings: [],
};
const run: SimulationRun = { id: "run-1", status: "running", target: "whole_store", requestedN: 1000, model: null, error: null, createdAt: "t", completedAt: null };

function deps(over: Partial<Parameters<typeof executeSimulation>[1]> = {}) {
  return {
    startRun: vi.fn(async () => run),
    completeRun: vi.fn(async (_shop: string, _id: string, m: BehaviorModel) => ({ ...run, status: "done" as const, model: m })),
    failRun: vi.fn(async (_shop: string, _id: string, msg: string) => ({ ...run, status: "error" as const, error: msg })),
    fetchSnapshot: vi.fn(async () => snapshot),
    buildBehaviorModel: vi.fn(async () => model),
    ...over,
  };
}

describe("executeSimulation", () => {
  it("persists the model on success and returns a done run", async () => {
    const d = deps();
    const result = await executeSimulation({ shop: "acme.myshopify.com", requestedN: 1000 }, d);
    expect(d.fetchSnapshot).toHaveBeenCalledWith("acme.myshopify.com");
    expect(d.completeRun).toHaveBeenCalledWith("acme.myshopify.com", "run-1", model);
    expect(result.status).toBe("done");
    expect(result.model).toEqual(model);
  });

  it("records an error run when a step throws", async () => {
    const d = deps({ buildBehaviorModel: vi.fn(async () => { throw new Error("api down"); }) });
    const result = await executeSimulation({ shop: "acme.myshopify.com", requestedN: 500 }, d);
    expect(d.failRun).toHaveBeenCalledWith("acme.myshopify.com", "run-1", "api down");
    expect(result.status).toBe("error");
  });

  it("demo mode uses the built-in sample model without fetching pages or calling Claude", async () => {
    const d = deps();
    const result = await executeSimulation({ shop: "acme.myshopify.com", requestedN: 1000, demo: true }, d);
    expect(d.startRun).toHaveBeenCalledWith("acme.myshopify.com", 1000, "demo");
    expect(d.fetchSnapshot).not.toHaveBeenCalled();
    expect(d.buildBehaviorModel).not.toHaveBeenCalled();
    expect(d.completeRun).toHaveBeenCalledWith("acme.myshopify.com", "run-1", DEMO_MODEL);
    expect(result.model).toEqual(DEMO_MODEL);
  });
});
