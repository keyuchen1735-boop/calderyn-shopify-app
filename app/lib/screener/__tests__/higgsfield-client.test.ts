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
  it("submits the documented platform body with Key auth, polls status, and returns image urls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" })) // POST submit
      .mockResolvedValueOnce(ok({ status: "in_progress" })) // poll 1
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }] })); // poll 2

    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "make it pop", referenceImageUrl: "https://ref.png", count: 1 });

    expect(urls).toEqual(["u1"]);

    const [submitUrl, submitInit] = fetchImpl.mock.calls[0];
    // Endpoint + body per the official platform docs
    // (docs.higgsfield.ai/docs/how-to/introduction + docs/guides/images).
    expect(String(submitUrl)).toBe("https://platform.higgsfield.ai/higgsfield-ai/soul/standard");
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers.Authorization).toBe("Key k:s");
    const body = JSON.parse(submitInit.body);
    expect(body.prompt).toBe("make it pop");
    expect(body.aspect_ratio).toBe("1:1");
    expect(body.resolution).toBe("720p");
    // Media inputs are flat url strings on the platform API.
    expect(body.image_url).toBe("https://ref.png");
    // Fields from the retired /v1/text2image/soul contract must not leak through.
    expect(body).not.toHaveProperty("image_reference");
    expect(body).not.toHaveProperty("width_and_height");
    expect(body).not.toHaveProperty("quality");
    expect(body).not.toHaveProperty("batch_size");

    const [statusUrl] = fetchImpl.mock.calls[1];
    expect(String(statusUrl)).toBe("https://platform.higgsfield.ai/requests/r1/status");
  });

  it("omits image_url for a no-reference generation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "only" }] }));
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "x", referenceImageUrl: null, count: 1 });
    expect(urls).toEqual(["only"]);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("image_url");
  });

  it("submits one request per image for count > 1 and collects a url from each", async () => {
    let submits = 0;
    const fetchImpl = vi.fn(async (url: string, init: { method: string }) => {
      if (init.method === "POST") {
        submits += 1;
        return ok({ request_id: `r${submits}` });
      }
      const id = String(url).match(/requests\/(r\d+)\/status/)?.[1];
      return ok({ status: "completed", images: [{ url: `img-${id}` }] });
    });
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "x", referenceImageUrl: null, count: 4 });
    expect(submits).toBe(4);
    expect([...urls].sort()).toEqual(["img-r1", "img-r2", "img-r3", "img-r4"]);
  });

  it("renders at the requested aspect via the aspectRatio option", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ request_id: "r1" }))
      .mockResolvedValueOnce(ok({ status: "completed", images: [{ url: "u1" }] }));
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0, aspectRatio: "9:16" });
    await client({ prompt: "x", referenceImageUrl: null, count: 1 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.aspect_ratio).toBe("9:16");
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

  it("names the offending field when the platform returns a 422 validation error", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [{ type: "missing", loc: ["body", "prompt"], msg: "Field required" }],
      }),
    });
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    await expect(client({ prompt: "x", referenceImageUrl: null, count: 1 })).rejects.toThrow(
      /body\.prompt: Field required/,
    );
  });

  it("keeps sibling images when one parallel request fails, throws only when all fail", async () => {
    let submits = 0;
    const fetchImpl = vi.fn(async (url: string, init: { method: string }) => {
      if (init.method === "POST") {
        submits += 1;
        return ok({ request_id: `r${submits}` });
      }
      const id = String(url).match(/requests\/(r\d+)\/status/)?.[1];
      if (id === "r2") return ok({ status: "nsfw", error: "flagged" });
      return ok({ status: "completed", images: [{ url: `img-${id}` }] });
    });
    const client = higgsfieldImageClient({ fetchImpl, pollDelayMs: 0 });
    const urls = await client({ prompt: "x", referenceImageUrl: null, count: 4 });
    expect([...urls].sort()).toEqual(["img-r1", "img-r3", "img-r4"]);
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
