import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "../cron.assets";

const { sweepPendingMedia, generateMissingProductImages } = vi.hoisted(() => ({
  sweepPendingMedia: vi.fn(),
  generateMissingProductImages: vi.fn(),
}));

vi.mock("~/lib/assets/rehost.server", () => ({ sweepPendingMedia }));
vi.mock("~/lib/assets/generate-missing.server", () => ({ generateMissingProductImages }));

function request(auth?: string): Request {
  return new Request("https://app.example/cron/assets", {
    headers: auth ? { authorization: auth } : undefined,
  });
}

describe("cron.assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects unauthorized requests before starting asset work", async () => {
    const response = await loader({ request: request() } as never);
    expect(response.status).toBe(401);
    expect(sweepPendingMedia).not.toHaveBeenCalled();
    expect(generateMissingProductImages).not.toHaveBeenCalled();
  });

  it("runs rehosting and missing-image generation together", async () => {
    sweepPendingMedia.mockResolvedValue({ scanned: 1, rehosted: 1, failed: 0, orphaned: 0, deduped: 0 });
    generateMissingProductImages.mockResolvedValue({ claimed: 2, ready: 1, failed: 1, skipped: 0 });

    const response = await loader({ request: request("Bearer s3cret") } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rehost: { scanned: 1, rehosted: 1, failed: 0, orphaned: 0, deduped: 0 },
      generation: { claimed: 2, ready: 1, failed: 1, skipped: 0 },
    });
    expect(sweepPendingMedia).toHaveBeenCalledOnce();
    expect(generateMissingProductImages).toHaveBeenCalledOnce();
  });
});
