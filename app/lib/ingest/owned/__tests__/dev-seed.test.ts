import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as DevSeedServer from "../dev-seed.server";

const emitOwnedEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../emit.server", () => ({ emitOwnedEvent: (...a: unknown[]) => emitOwnedEvent(...a) }));

let seedOwnedCheckout: typeof DevSeedServer.seedOwnedCheckout;
beforeEach(async () => {
  emitOwnedEvent.mockClear();
  ({ seedOwnedCheckout } = await import("../dev-seed.server"));
});

describe("seedOwnedCheckout", () => {
  it("emits one valid paid checkout event", async () => {
    await seedOwnedCheckout({ shopId: "s1", variantId: "v1", eventId: "e1" });
    expect(emitOwnedEvent).toHaveBeenCalledTimes(1);
    const ev = emitOwnedEvent.mock.calls[0][0] as Record<string, any>;
    expect(ev.type).toBe("CHECKOUT_COMPLETED");
    expect(ev.order.financial_status).toBe("paid");
    expect(ev.lines[0].variant_id).toBe("v1");
  });
});
