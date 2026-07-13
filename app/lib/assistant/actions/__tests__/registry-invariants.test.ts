import { describe, expect, it, vi } from "vitest";

// Mock the import/run.server boundary to avoid triggering shopify.server init
// (ops-actions imports import/run which reaches shopify.server and throws when
// SHOPIFY_API_SECRET isn't set). The invariant tests only inspect the registry
// structure, so the mock is safe.
vi.mock("../../../import/run.server", () => ({
  startImport: vi.fn(async () => ({ importId: "imp-test" })),
  kickDrainSoon: vi.fn(async () => undefined),
  latestImport: vi.fn(async () => null),
}));

// eslint-disable-next-line import/first
import { ASSISTANT_ACTIONS, generatedWriteTools } from "../registry.server";

const FORBIDDEN = [/delete.*account/i, /demo.*reset/i, /cutover/i, /go.?live/i, /org.?mode/i, /logout/i, /password/i, /session/i];

describe("registry invariants", () => {
  it("no Tier-3 operation is registered", () => {
    for (const a of ASSISTANT_ACTIONS) {
      for (const f of FORBIDDEN) expect(a.name).not.toMatch(f);
    }
  });
  it("every confirm-tier action has a confirmSummary", () => {
    for (const a of ASSISTANT_ACTIONS.filter((x) => x.tier === "confirm")) {
      expect(a.confirmSummary, `${a.name} missing confirmSummary`).toBeTypeOf("function");
    }
  });
  it("names are unique and tools generate 1:1", () => {
    const names = ASSISTANT_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(generatedWriteTools()).toHaveLength(names.length);
  });
  it("confirm-tier tool descriptions warn the model about confirmation", () => {
    const tools = generatedWriteTools();
    for (const a of ASSISTANT_ACTIONS.filter((x) => x.tier === "confirm")) {
      expect(tools.find((t) => t.name === a.name)!.description).toContain("REQUIRES MERCHANT CONFIRMATION");
    }
  });
});
