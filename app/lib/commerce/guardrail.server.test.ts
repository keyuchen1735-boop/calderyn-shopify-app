import { describe, it, expect, vi } from "vitest";

function mockClient(row: Record<string, unknown> | null) {
  vi.doMock("~/lib/supabase.server", () => ({
    getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
  }));
}

describe("assertWithinCommerceCap", () => {
  it("throws COMMERCE_DISABLED when merchant has explicitly disabled the client", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: false, spend_cap_cents: 100000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 100)).rejects.toMatchObject({ code: "COMMERCE_DISABLED" });
  });

  it("passes when commerce_scope is true and spend_cap_cents is 0 (unlimited)", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 0 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 999999)).resolves.toBeUndefined();
  });

  it("throws SPEND_CAP_EXCEEDED when amount exceeds a positive cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 6000)).rejects.toMatchObject({ code: "SPEND_CAP_EXCEEDED" });
  });

  it("passes when amount is under a positive cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 4999)).resolves.toBeUndefined();
  });

  it("throws COMMERCE_DISABLED for an UNREGISTERED client (no row) — frictionless ≠ anonymous", async () => {
    vi.resetModules();
    mockClient(null);
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 5000)).rejects.toMatchObject({ code: "COMMERCE_DISABLED" });
  });

  it("throws COMMERCE_DISABLED when no clientId is supplied (missing principal)", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 0 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("", 5000)).rejects.toMatchObject({ code: "COMMERCE_DISABLED" });
  });
});
