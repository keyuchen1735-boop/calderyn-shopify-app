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
  it("submits to the model endpoint with Key auth, polls status, and returns image urls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" })) // POST submit
      .mockResolvedValueOnce(ok({ status: "in_progress" })) // poll 1
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }, { url: "u2" }] })); // poll 2

    const client = higgsfieldImageClient({ fetchImpl, model: "vendor/model/v1", pollDelayMs: 0 });
    const urls = await client({ prompt: "make it pop", referenceImageUrl: "https://ref.png", count: 2 });

    expect(urls).toEqual(["u1", "u2"]);

    const [submitUrl, submitInit] = fetchImpl.mock.calls[0];
    expect(String(submitUrl)).toBe("https://platform.higgsfield.ai/vendor/model/v1");
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers.Authorization).toBe("Key k:s");
    const body = JSON.parse(submitInit.body);
    expect(body.prompt).toBe("make it pop");
    expect(body.image_url).toBe("https://ref.png");

    const [statusUrl] = fetchImpl.mock.calls[1];
    expect(String(statusUrl)).toBe("https://platform.higgsfield.ai/requests/r1/status");
  });

  it("throws when the generation fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "failed", error: "bad prompt" }));
    const client = higgsfieldImageClient({ fetchImpl, model: "vendor/model/v1", pollDelayMs: 0 });
    await expect(client({ prompt: "x", referenceImageUrl: null, count: 1 })).rejects.toThrow(/higgsfield/i);
  });

  it("throws when credentials are missing", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    const fetchImpl = vi.fn();
    const client = higgsfieldImageClient({ fetchImpl, model: "vendor/model/v1", pollDelayMs: 0 });
    await expect(client({ prompt: "x", referenceImageUrl: null, count: 1 })).rejects.toThrow(/credential/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
