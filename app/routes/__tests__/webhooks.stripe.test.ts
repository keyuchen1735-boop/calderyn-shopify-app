import { describe, it, expect, beforeEach, vi } from "vitest";

const { processStripeEvent } = vi.hoisted(() => ({ processStripeEvent: vi.fn() }));
vi.mock("~/lib/payments/stripe.server", () => ({ processStripeEvent }));

import { action } from "../webhooks.stripe";

function post(body: string, sig?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (sig) headers.set("stripe-signature", sig);
  return new Request("https://app.example.com/webhooks/stripe", { method: "POST", headers, body });
}

describe("webhooks.stripe action", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the raw body + signature to processStripeEvent and returns its status (success)", async () => {
    processStripeEvent.mockResolvedValue({ status: 200, processed: true, duplicate: false });
    const res = await action({ request: post('{"id":"evt_1"}', "t=1,v1=abc") } as never);
    expect(res.status).toBe(200);
    expect(processStripeEvent).toHaveBeenCalledWith('{"id":"evt_1"}', "t=1,v1=abc");
  });

  it("returns 200 on a duplicate delivery", async () => {
    processStripeEvent.mockResolvedValue({ status: 200, processed: false, duplicate: true });
    const res = await action({ request: post('{"id":"evt_1"}', "t=1,v1=abc") } as never);
    expect(res.status).toBe(200);
  });

  it("returns 400 when the signature is invalid", async () => {
    processStripeEvent.mockResolvedValue({ status: 400, processed: false, duplicate: false });
    const res = await action({ request: post('{"id":"evt_1"}', "bad") } as never);
    expect(res.status).toBe(400);
  });

  it("rejects non-POST with 405", async () => {
    const req = new Request("https://app.example.com/webhooks/stripe", { method: "GET" });
    const res = await action({ request: req } as never);
    expect(res.status).toBe(405);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });
});
