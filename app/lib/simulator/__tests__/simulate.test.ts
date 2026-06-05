// app/lib/simulator/__tests__/simulate.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildBehaviorModel, parseBehaviorModel } from "../simulate.server";
import type { StoreSnapshot } from "../types";

const snapshot: StoreSnapshot = {
  shop: "acme.myshopify.com",
  homeText: "Premium wool socks",
  product: { title: "Wool Beanie", descriptionText: "Warm", priceText: "29.00", url: "https://acme.myshopify.com/products/wool-beanie" },
  shipping: { amount: 9.95, currency: "USD", estimated: false },
};

const validInput = {
  storeSummary: "Wool accessories store",
  archetypes: [
    {
      id: "deal-hunter", name: "Deal-hunter", weight: 0.6,
      advance: { landed: 0.9, viewed_product: 0.7, added_to_cart: 0.8, started_checkout: 0.9, shipping_reveal: 0.2, bought: 1 },
      dropReason: { shipping_reveal: "shipping too high" },
    },
  ],
  findings: [
    { id: "f1", severity: "critical", title: "Shipping shock", stage: "shipping_reveal", personaIds: ["deal-hunter"], fix: "free-ship bar" },
  ],
};

function fakeMessage(toolInput: unknown) {
  return {
    content: [{ type: "tool_use", id: "t1", name: "report_simulation", input: toolInput }],
    stop_reason: "tool_use",
  };
}

describe("parseBehaviorModel", () => {
  it("accepts and passes through a valid model, attaching shipping from the snapshot", () => {
    const model = parseBehaviorModel(validInput, snapshot.shipping);
    expect(model.archetypes).toHaveLength(1);
    expect(model.archetypes[0].advance.shipping_reveal).toBe(0.2);
    expect(model.shipping).toEqual(snapshot.shipping);
    expect(model.findings[0].stage).toBe("shipping_reveal");
  });

  it("clamps out-of-range probabilities and drops malformed archetypes", () => {
    const model = parseBehaviorModel(
      { storeSummary: "x", archetypes: [{ id: "a", name: "A", weight: 2, advance: { landed: 5 }, dropReason: {} }, { name: "noid" }], findings: [] },
      snapshot.shipping,
    );
    expect(model.archetypes).toHaveLength(1);
    expect(model.archetypes[0].weight).toBeLessThanOrEqual(1);
    expect(model.archetypes[0].advance.landed).toBe(1);
  });

  it("throws when there are zero usable archetypes", () => {
    expect(() => parseBehaviorModel({ storeSummary: "x", archetypes: [], findings: [] }, snapshot.shipping)).toThrow();
  });
});

describe("buildBehaviorModel", () => {
  it("calls Claude with a forced tool and parses the tool input", async () => {
    const createMessage = vi.fn(async () => fakeMessage(validInput));
    const model = await buildBehaviorModel(snapshot, { createMessage: createMessage as never, model: "test-model" });
    expect(createMessage).toHaveBeenCalledTimes(1);
    const calls = createMessage.mock.calls as unknown as Array<[{ tool_choice?: { type: string; name: string } }]>;
    const arg = calls[0][0];
    expect(arg.tool_choice).toEqual({ type: "tool", name: "report_simulation" });
    expect(model.storeSummary).toBe("Wool accessories store");
    expect(model.archetypes[0].id).toBe("deal-hunter");
  });

  it("throws a clear error when Claude returns no tool_use block", async () => {
    const createMessage = vi.fn(async () => ({ content: [{ type: "text", text: "nope" }], stop_reason: "end_turn" }));
    await expect(
      buildBehaviorModel(snapshot, { createMessage: createMessage as never, model: "test-model" }),
    ).rejects.toThrow(/did not return/i);
  });
});
