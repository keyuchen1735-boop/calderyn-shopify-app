import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sniffImageMime,
  imageDimensions,
  isFetchableUrl,
  storeImageBytes,
  persistExternalImage,
  fetchExternalImageBytes,
  mirrorShopifyImage,
  type AssetFetch,
} from "../persist.server";

const { uploadMock, removeMock, getPublicUrlMock, insertSingle, insertMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  removeMock: vi.fn(),
  getPublicUrlMock: vi.fn(),
  insertSingle: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    storage: { from: () => ({ upload: uploadMock, getPublicUrl: getPublicUrlMock, remove: removeMock }) },
    from: () => ({ insert: insertMock }),
  }),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";

// A minimal valid PNG: 8-byte signature + IHDR declaring 4x3.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x05, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

function okResponse(bytes: Uint8Array, contentLength?: number | null) {
  const cl = contentLength === undefined ? bytes.byteLength : contentLength;
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-length" && cl != null ? String(cl) : null) },
    body: streamOf(bytes),
  };
}

beforeEach(() => {
  uploadMock.mockReset().mockResolvedValue({ error: null });
  removeMock.mockReset().mockResolvedValue({ error: null });
  getPublicUrlMock.mockReset().mockReturnValue({ data: { publicUrl: "https://sb.co/storage/v1/object/public/shop-assets/key.png" } });
  insertSingle.mockReset().mockResolvedValue({ data: { id: "asset-1" }, error: null });
  insertMock.mockReset().mockImplementation(() => ({ select: () => ({ single: insertSingle }) }));
});

describe("sniffImageMime", () => {
  it("recognizes png/jpeg/gif/webp and rejects others", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // "<svg"
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // "%PDF"
  });
});

describe("imageDimensions", () => {
  it("reads png (big-endian) and gif (little-endian) sizes; null for webp", () => {
    expect(imageDimensions(PNG, "image/png")).toEqual({ width: 4, height: 3 });
    expect(imageDimensions(GIF, "image/gif")).toEqual({ width: 10, height: 5 });
    expect(imageDimensions(WEBP, "image/webp")).toBeNull();
  });
});

describe("isFetchableUrl", () => {
  it("allows public http(s) and rejects private hosts, localhost, and non-http schemes", () => {
    expect(isFetchableUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isFetchableUrl("http://cdn.example.com/a.png")).toBe(true);
    expect(isFetchableUrl("https://127.0.0.1/a.png")).toBe(false);
    expect(isFetchableUrl("https://10.0.0.5/a.png")).toBe(false);
    expect(isFetchableUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isFetchableUrl("https://localhost/a.png")).toBe(false);
    expect(isFetchableUrl("http://[::1]/a.png")).toBe(false);
    expect(isFetchableUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isFetchableUrl("ftp://example.com/a.png")).toBe(false);
    expect(isFetchableUrl("not a url")).toBe(false);
  });
});

describe("storeImageBytes", () => {
  it("uploads under a shop-scoped uuid key and records asset_dim with dimensions", async () => {
    const out = await storeImageBytes(SHOP, PNG, { kind: "generated", source: "generated", mime: "image/png" });
    expect(out.assetId).toBe("asset-1");
    expect(out.publicUrl).toContain("/public/shop-assets/");
    expect(out.storageKey).toMatch(new RegExp(`^${SHOP}/[0-9a-f-]{36}\\.png$`));
    const inserted = insertMock.mock.calls[0][0];
    expect(inserted).toMatchObject({ shop_id: SHOP, source: "generated", mime: "image/png", bytes: PNG.byteLength, width: 4, height: 3 });
  });
  it("rejects a non-uuid shop id before touching storage", async () => {
    await expect(storeImageBytes("demo-shop", PNG, { kind: "generated", source: "generated", mime: "image/png" })).rejects.toThrow();
    expect(uploadMock).not.toHaveBeenCalled();
  });
  it("removes the orphan blob when the row insert fails", async () => {
    insertSingle.mockResolvedValue({ data: null, error: { message: "insert boom" } });
    await expect(storeImageBytes(SHOP, PNG, { kind: "generated", source: "generated", mime: "image/png" })).rejects.toThrow();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

describe("persistExternalImage", () => {
  it("can fetch bounded verified bytes without creating an intermediate asset row", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue(okResponse(PNG));
    await expect(fetchExternalImageBytes("https://provider.cdn/x.png", { fetchImpl })).resolves.toEqual({
      bytes: PNG,
      mediaType: "image/png",
    });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation into the remote image fetch", async () => {
    const controller = new AbortController();
    const fetchImpl: AssetFetch = (_url, init) => new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    const pending = fetchExternalImageBytes("https://provider.cdn/x.png", { fetchImpl, signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fetches, sniffs, stores, and returns the owned url", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue(okResponse(PNG));
    const out = await persistExternalImage(SHOP, "https://provider.cdn/x.png", "generated", "generated", { fetchImpl });
    expect(out.persisted).toBe(true);
    if (out.persisted) expect(out.url).toContain("/public/shop-assets/");
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("stores bounded Gemini inline image bytes without a network fetch", async () => {
    const fetchImpl: AssetFetch = vi.fn();
    const out = await persistExternalImage(SHOP, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, "generated", "generated", { fetchImpl });
    expect(out.persisted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploadMock).toHaveBeenCalledWith(expect.any(String), PNG, expect.objectContaining({ contentType: "image/png" }));
  });
  it("rejects oversized inline image data before storage", async () => {
    const out = await persistExternalImage(SHOP, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, "generated", "generated", { maxBytes: 1 });
    expect(out.persisted).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("refuses a private-host url without fetching (SSRF) and keeps the original url", async () => {
    const fetchImpl: AssetFetch = vi.fn();
    const out = await persistExternalImage(SHOP, "https://169.254.169.254/x.png", "generated", "generated", { fetchImpl });
    expect(out).toEqual({ persisted: false, url: "https://169.254.169.254/x.png", error: "blocked_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a redirect that points at a private IP (SSRF) and keeps the original url", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: { get: (n: string) => (n.toLowerCase() === "location" ? "http://169.254.169.254/" : null) },
      body: null,
    });
    const out = await persistExternalImage(SHOP, "https://provider.cdn/x.png", "generated", "generated", { fetchImpl });
    expect(out.persisted).toBe(false);
    if (!out.persisted) expect(out.url).toBe("https://provider.cdn/x.png");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("rejects a body over the byte cap declared by content-length (keeps original url)", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue(okResponse(PNG, 999_999_999));
    const out = await persistExternalImage(SHOP, "https://provider.cdn/x.png", "generated", "generated", { fetchImpl, maxBytes: 100 });
    expect(out.persisted).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("rejects a streamed body that exceeds the cap even without content-length (no OOM)", async () => {
    const big = new Uint8Array(50);
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: chunkedStream([big, big, big]),
    });
    const out = await persistExternalImage(SHOP, "https://provider.cdn/x.png", "generated", "generated", { fetchImpl, maxBytes: 100 });
    expect(out.persisted).toBe(false);
    if (!out.persisted) expect(out.error).toContain("bytes");
  });

  it("keeps the original url when the bytes are not a recognized image", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue(okResponse(new Uint8Array([1, 2, 3, 4])));
    const out = await persistExternalImage(SHOP, "https://provider.cdn/x.bin", "generated", "generated", { fetchImpl });
    expect(out).toMatchObject({ persisted: false, url: "https://provider.cdn/x.bin", error: "unrecognized_image" });
  });
});

describe("mirrorShopifyImage", () => {
  it("persists with source 'mirrored'", async () => {
    const fetchImpl: AssetFetch = vi.fn().mockResolvedValue(okResponse(PNG));
    const out = await mirrorShopifyImage(SHOP, "https://cdn.shopify.com/p.png", "product", { fetchImpl });
    expect(out.persisted).toBe(true);
    expect(insertMock.mock.calls[0][0]).toMatchObject({ source: "mirrored", kind: "product" });
  });
});
