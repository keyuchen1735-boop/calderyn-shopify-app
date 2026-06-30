import { describe, it, expect, vi } from "vitest";

describe("getRateSource", () => {
  it("returns the connected EasyPost RateQuoteSource", async () => {
    vi.resetModules();
    const src = { getRates: async () => ({ options: [], currency: "usd" }) };
    vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({ easyPostRateAdapter: { connect: async () => src } }));
    const { getRateSource } = await import("./rate-source.server");
    expect(await getRateSource("shop_test")).toBe(src);
  });
  it("throws RATE_SOURCE_NOT_CONFIGURED when the shop has no connected carrier", async () => {
    vi.resetModules();
    vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({ easyPostRateAdapter: { connect: async () => null } }));
    const { getRateSource } = await import("./rate-source.server");
    await expect(getRateSource("shop_test")).rejects.toMatchObject({ code: "RATE_SOURCE_NOT_CONFIGURED" });
  });
});
