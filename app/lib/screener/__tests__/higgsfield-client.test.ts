import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { higgsfieldImageClient } from "../higgsfield.server";

const KEYS = ["HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.HIGGSFIELD_API_KEY = "k";
  process.env.HIGGSFIELD_API_SECRET = "s";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("higgsfieldImageClient", () => {
  it("submits the documented soul input shape with Key auth, polls status, and returns image urls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" })) // POST submit
      .mockResolvedValueOnce(ok({ status: "in_progress" })) // poll 1
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }, { url: "u2" }] })); // poll 2

    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "make it pop", referenceImageUrl: "https://ref.png", count: 2 });

    expect(urls).toEqual(["u1", "u2"]);

    const [submitUrl, submitInit] = fetchImpl.mock.calls[0];
    // Endpoint + body per the official @higgsfield/client v2 source
    // (github.com/higgsfield-ai/higgsfield-js: src/v2/client.ts, src/v2/types.ts).
    expect(String(submitUrl)).toBe("https://platform.higgsfield.ai/v1/text2image/soul");
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers.Authorization).toBe("Key k:s");
    const body = JSON.parse(submitInit.body);
    expect(body.prompt).toBe("make it pop");
    expect(body.image_reference).toEqual({ type: "image_url", image_url: "https://ref.png" });
    expect(body.width_and_height).toBe("1536x1536");
    expect(body.quality).toBe("1080p");
    expect(body.batch_size).toBe(4); // 1|4 are the only valid values; count 2 needs the quad batch
    expect(body).not.toHaveProperty("count");
    expect(body).not.toHaveProperty("image_url");

    const [statusUrl] = fetchImpl.mock.calls[1];
    expect(String(statusUrl)).toBe("https://platform.higgsfield.ai/requests/r1/status");
  });

  it("uses batch_size 1 and omits image_reference for a single no-reference generation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "only" }] }));
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "x", referenceImageUrl: null, count: 1 });
    expect(urls).toEqual(["only"]);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.batch_size).toBe(1);
    expect(body).not.toHaveProperty("image_reference");
  });

  it("renders at the requested aspect via the widthAndHeight option", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }] }));
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0, widthAndHeight: "1152x2048" });
    await client({ prompt: "x", referenceImageUrl: null, count: 1 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.width_and_height).toBe("1152x2048");
  });

  it("honors an explicit model path override", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }] }));
    const client = higgsfieldImageClient({ fetchImpl, model: "vendor/model/v1", pollDelayMs: 0 });
    await client({ prompt: "x", referenceImageUrl: null, count: 1 });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://platform.higgsfield.ai/vendor/model/v1");
  });

  it("throws when the generation fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "failed", error: "bad prompt" }));
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    await expect(client({ prompt: "x", referenceImageUrl: null, count: 1 })).rejects.toThrow(/higgsfield/i);
  });

  it("throws when credentials are missing", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    const fetchImpl = vi.fn();
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    await expect(client({ prompt: "x", referenceImageUrl: null, count: 1 })).rejects.toThrow(/credential/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
