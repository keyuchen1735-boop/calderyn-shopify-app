import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const createCollection = vi.fn().mockResolvedValue({ id: "c1" });
vi.mock("~/lib/catalog/catalog.server", () => ({ listCollections: vi.fn().mockResolvedValue([]), createCollection }));
const uploadProductMedia = vi.fn().mockResolvedValue({ id: "m1", storagePath: "shop1/p1/x.png" });
vi.mock("~/lib/catalog/media.server", () => ({
  uploadProductMedia,
  deleteProductMedia: vi.fn(),
  ALLOWED_MEDIA_TYPES: new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  MAX_MEDIA_BYTES: 8 * 1024 * 1024,
}));
const signMediaPath = vi.fn().mockResolvedValue("https://signed/x");
vi.mock("~/lib/catalog/sign-media.server", () => ({ signMediaPath, signMediaPaths: vi.fn() }));

beforeEach(() => { createCollection.mockClear(); uploadProductMedia.mockClear(); signMediaPath.mockClear(); });

describe("catalog collections + media routes", () => {
  it("POST creates a collection", async () => {
    const { action } = await import("../dashboard.api.catalog.collections");
    const req = new Request("https://app.x/dashboard/api/catalog/collections", { method: "POST", body: JSON.stringify({ title: "Summer" }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createCollection).toHaveBeenCalledWith("shop1", "Summer");
  });

  it("POST uploads media from multipart", async () => {
    const { action } = await import("../dashboard.api.catalog.media");
    const fd = new FormData();
    fd.set("productId", "p1");
    fd.set("file", new File([new Uint8Array([1, 2])], "tee.png", { type: "image/png" }));
    const req = new Request("https://app.x/dashboard/api/catalog/media", { method: "POST", body: fd });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(uploadProductMedia).toHaveBeenCalledWith("shop1", "p1", expect.objectContaining({ filename: "tee.png", contentType: "image/png" }));
    // The route signs the stored path and returns a render-ready URL.
    expect(signMediaPath).toHaveBeenCalledWith("shop1/p1/x.png");
    expect(await res.json()).toEqual({ id: "m1", url: "https://signed/x" });
  });

  it("POST rejects an unsupported file type before buffering (415)", async () => {
    const { action } = await import("../dashboard.api.catalog.media");
    const fd = new FormData();
    fd.set("productId", "p1");
    fd.set("file", new File([new Uint8Array([1, 2])], "doc.pdf", { type: "application/pdf" }));
    const req = new Request("https://app.x/dashboard/api/catalog/media", { method: "POST", body: fd });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(415);
    expect(uploadProductMedia).not.toHaveBeenCalled();
  });
});
