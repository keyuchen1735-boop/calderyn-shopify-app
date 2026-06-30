import { describe, it, expect, vi } from "vitest";

function mockClient(row: Record<string, unknown> | null) {
  vi.doMock("~/lib/supabase.server", () => ({
    getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
  }));
}

describe("assertWithinCommerceCap", () => {
  it("throws SPEND_CAP_EXCEEDED when amount exceeds the client's cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 6000)).rejects.toMatchObject({ code: "SPEND_CAP_EXCEEDED" });
  });

  it("throws COMMERCE_NOT_AUTHORIZED when the client lacks commerce_scope", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: false, spend_cap_cents: 100000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 100)).rejects.toMatchObject({ code: "COMMERCE_NOT_AUTHORIZED" });
  });

  it("passes when authorized and within cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 4999)).resolves.toBeUndefined();
  });
});
