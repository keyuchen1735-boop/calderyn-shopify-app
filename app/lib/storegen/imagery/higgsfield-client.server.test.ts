import { afterEach, describe, expect, it, vi } from "vitest";
import { runHiggsfieldProductPhotoshoot } from "./higgsfield-client.server";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.HIGGSFIELD_API_KEY;
  delete process.env.HIGGSFIELD_API_SECRET;
});

describe("runHiggsfieldProductPhotoshoot", () => {
  it("stops missing-image generation in time for a first preview under one minute", async () => {
    vi.useFakeTimers();
    process.env.HIGGSFIELD_API_KEY = "key";
    process.env.HIGGSFIELD_API_SECRET = "secret";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "request-1" }), { status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({ status: "processing" }), { status: 200 })));

    let failure: Error | undefined;
    void runHiggsfieldProductPhotoshoot({
      mode: "product_shot",
      title: "Cedar candle",
      description: "Hand poured",
      referenceImageUrl: null,
    }).catch((error: Error) => { failure = error; });

    await vi.advanceTimersByTimeAsync(46_000);
    expect(failure?.message).toMatch(/timed out after 45 s/i);
  });
});
