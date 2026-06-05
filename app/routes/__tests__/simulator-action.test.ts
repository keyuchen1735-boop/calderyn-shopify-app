// app/routes/__tests__/simulator-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

const { execSpy } = vi.hoisted(() => ({ execSpy: vi.fn() }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));
vi.mock("~/lib/simulator/orchestrate.server", () => ({
  executeSimulation: (...a: unknown[]) => execSpy(...a),
}));

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { action } from "../app.simulator";

function run(n: string, mode?: string): Promise<Response> {
  const fd = new FormData();
  fd.set("requestedN", n);
  if (mode) fd.set("mode", mode);
  const request = new Request("http://localhost/app/simulator", { method: "POST", body: fd });
  return action({ request } as unknown as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  execSpy.mockReset();
  execSpy.mockResolvedValue({ id: "run-1", status: "done", target: "whole_store", requestedN: 1000, model: null, error: null, createdAt: "t", completedAt: "t" });
});

describe("simulator action", () => {
  it("clamps requestedN into [10,1000] and runs a live simulation", async () => {
    await run("999999");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 1000, demo: false });
  });

  it("clamps a too-small value up to the minimum", async () => {
    await run("1");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 10, demo: false });
  });

  it("defaults non-numeric input to 1000", async () => {
    await run("abc");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 1000, demo: false });
  });

  it("passes demo=true when mode=demo (no API key path)", async () => {
    await run("500", "demo");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 500, demo: true });
  });
});
