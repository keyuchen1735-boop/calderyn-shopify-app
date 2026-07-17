import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("owned design-reference upload", () => {
  it("keeps the server-issued assetRef for the Store command", async () => {
    vi.stubGlobal("location", { origin: "https://dashboard.example" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "asset-id",
      url: "https://assets.example/reference.webp",
      assetRef: "owned/reference.webp",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const { uploadCampaignCreativeImage } = await import("../client");

    await expect(uploadCampaignCreativeImage(
      new File(["image"], "reference.webp", { type: "image/webp" }),
    )).resolves.toEqual({
      id: "asset-id",
      url: "https://assets.example/reference.webp",
      assetRef: "owned/reference.webp",
    });
  });
});
