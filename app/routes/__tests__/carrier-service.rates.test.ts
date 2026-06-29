import { describe, it, expect, beforeEach, vi } from "vitest";

const { handleCarrierRateCallback, resolveCarrierShopByToken } = vi.hoisted(() => ({
  handleCarrierRateCallback: vi.fn(),
  resolveCarrierShopByToken: vi.fn(),
}));
vi.mock("~/lib/shipping/carrier-service.server", () => ({
  handleCarrierRateCallback,
  resolveCarrierShopByToken,
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the lib fake is registered before the route module loads
import { action, loader } from "../carrier-service.rates.$token";

function post(token: string, body: string): { request: Request; params: { token: string } } {
  return {
    request: new Request(`https://app.example.com/carrier-service/rates/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    params: { token },
  };
}

describe("carrier-service.rates action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates the token, then delegates the raw body to handleCarrierRateCallback", async () => {
    resolveCarrierShopByToken.mockResolvedValue({ shopId: "shop-1" });
    handleCarrierRateCallback.mockResolvedValue({ status: 200, body: '{"rates":[{"service_code":"Priority"}]}' });
    const res = await action(post("tok", '{"rate":{}}') as never);
    expect(res.status).toBe(200);
    expect(resolveCarrierShopByToken).toHaveBeenCalledWith("tok");
    expect(handleCarrierRateCallback).toHaveBeenCalledWith(
      "tok",
      '{"rate":{}}',
      expect.objectContaining({ resolveShop: expect.any(Function) }),
    );
    expect(await res.text()).toContain("Priority");
  });

  it("rejects a forged token fail-closed (401) BEFORE reading the body or quoting (M2)", async () => {
    resolveCarrierShopByToken.mockResolvedValue(null);
    const res = await action(post("forged", '{"rate":{}}') as never);
    expect(res.status).toBe(401);
    expect(JSON.parse(await res.text())).toEqual({ rates: [] });
    expect(handleCarrierRateCallback).not.toHaveBeenCalled(); // body never buffered, no quote
  });

  it("rejects non-POST with 405 without quoting", async () => {
    const req = new Request("https://app.example.com/carrier-service/rates/tok", { method: "PUT" });
    const res = await action({ request: req, params: { token: "tok" } } as never);
    expect(res.status).toBe(405);
    expect(resolveCarrierShopByToken).not.toHaveBeenCalled();
    expect(handleCarrierRateCallback).not.toHaveBeenCalled();
  });
});

describe("carrier-service.rates loader (GET reachability probe)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s an unknown token (no shop enumeration)", async () => {
    resolveCarrierShopByToken.mockResolvedValue(null);
    const res = await loader({ params: { token: "nope" } } as never);
    expect(res.status).toBe(401);
  });

  it("returns an empty rate set for a known token", async () => {
    resolveCarrierShopByToken.mockResolvedValue({ shopId: "shop-1" });
    const res = await loader({ params: { token: "tok" } } as never);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ rates: [] });
  });
});
