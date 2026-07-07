// Chat-box attachments become catalog products (one image in, one draft product
// titled from the filename) OR travel with the prompt to the multipart generate
// endpoint — the two client paths this suite covers.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { addProductFromImage, generateStudioStoreStream, generateStudioStoreWithImages, productTitleFromFilename, StudioStreamError } from "./store-client";
import { DashboardApiError } from "./client";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// client mock still applies even though it is written below them.
const { saveProduct, uploadProductImage, apiSendForm } = vi.hoisted(() => ({
  saveProduct: vi.fn(),
  uploadProductImage: vi.fn(),
  apiSendForm: vi.fn(),
}));

vi.mock("./client", () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  apiSendForm,
  saveProduct,
  uploadProductImage,
  DashboardApiError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  saveProduct.mockResolvedValue({ id: "prod-1" });
  uploadProductImage.mockResolvedValue({ id: "media-1", url: "https://x/img.jpg" });
  apiSendForm.mockResolvedValue({ runId: "run-1", status: "draft" });
});

describe("addProductFromImage", () => {
  it("creates a draft product titled from the filename and attaches the image", async () => {
    const file = new File(["x"], "red-ceramic-mug.jpg", { type: "image/jpeg" });
    const out = await addProductFromImage(file);
    expect(saveProduct).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Red ceramic mug", status: "draft" }),
    );
    expect(uploadProductImage).toHaveBeenCalledWith("prod-1", file);
    expect(out).toEqual({ id: "prod-1", title: "Red ceramic mug" });
  });

  it("surfaces a partial add (product created, image failed) instead of reporting total failure", async () => {
    uploadProductImage.mockRejectedValue(new Error("unsupported_media_type"));
    const file = new File(["x"], "photo.heic", { type: "image/heic" });
    const out = await addProductFromImage(file);
    expect(saveProduct).toHaveBeenCalledTimes(1);
    expect(out.id).toBe("prod-1");
    expect(out.imageError).toBeTruthy();
  });
});

describe("generateStudioStoreWithImages", () => {
  function pngFile(name: string): File {
    return new File([new Uint8Array(4)], name, { type: "image/png" });
  }
  function formOf(): FormData {
    return apiSendForm.mock.calls[0][1] as FormData;
  }

  it("builds multipart FormData with the generate fields and every image, omitting intent", async () => {
    const files = [pngFile("a.png"), pngFile("b.png")];
    const receipt = await generateStudioStoreWithImages("match this vibe", files, "opus");
    expect(apiSendForm).toHaveBeenCalledTimes(1);
    expect(apiSendForm.mock.calls[0][0]).toBe("/dashboard/api/store");
    const form = formOf();
    expect(form.get("action")).toBe("generate");
    expect(form.get("brief")).toBe("match this vibe");
    expect(form.get("model")).toBe("opus");
    expect(form.get("intent")).toBeNull();
    expect(form.getAll("image")).toHaveLength(2);
    expect(receipt).toEqual({ runId: "run-1", status: "draft" });
  });

  it("includes the intent field when given, and omits an empty brief", async () => {
    await generateStudioStoreWithImages("", [pngFile("board.png")], "sonnet", "reference");
    const form = formOf();
    expect(form.get("brief")).toBeNull();
    expect(form.get("model")).toBe("sonnet");
    expect(form.get("intent")).toBe("reference");
    expect(form.getAll("image")).toHaveLength(1);
  });

  it("propagates a DashboardApiError from the send (server error code/message)", async () => {
    apiSendForm.mockRejectedValueOnce(new Error("image_too_large"));
    await expect(generateStudioStoreWithImages("hi", [pngFile("big.png")], "sonnet")).rejects.toThrow(
      "image_too_large",
    );
  });
});

describe("productTitleFromFilename", () => {
  it("turns a filename into a humane product title", () => {
    expect(productTitleFromFilename("red-ceramic_mug.v2.jpg")).toBe("Red ceramic mug v2");
  });

  it("falls back to a generic title for unusable names", () => {
    expect(productTitleFromFilename("...jpg")).toBe("New product");
    expect(productTitleFromFilename("")).toBe("New product");
  });
});

// ---- streaming generate ------------------------------------------------------

const ndjsonResponse = (lines: string[], status = 200) => {
  const text = lines.map((l) => `${l}\n`).join("");
  const mid = Math.floor(text.length / 2);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      // two chunks split mid-line so the reader's buffering is exercised
      c.enqueue(enc.encode(text.slice(0, mid)));
      c.enqueue(enc.encode(text.slice(mid)));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/x-ndjson" } });
};

describe("generateStudioStoreStream", () => {
  it("forwards each stage in order and resolves the final receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"brand"}',
      '{"stage":"designing"}',
      '{"stage":"checking"}',
      '{"stage":"done","receipt":{"runId":"r1","status":"draft","verification":{"checkedLinks":4,"fixedLinks":0,"externalLinks":0,"strippedMotion":0,"warnings":[]}}}',
    ])));
    const stages: string[] = [];
    const receipt = await generateStudioStoreStream("a brief", "sonnet", (s) => stages.push(s));
    expect(stages).toEqual(["brand", "designing", "checking"]);
    expect(receipt.runId).toBe("r1");
    expect(receipt.verification?.checkedLinks).toBe(4);
    vi.unstubAllGlobals();
  });

  it("rejects with the server's in-band error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"brand"}', '{"stage":"error","message":"Store generation failed."}'])));
    await expect(generateStudioStoreStream("b", "sonnet", () => {})).rejects.toBeInstanceOf(DashboardApiError);
    vi.unstubAllGlobals();
  });

  it("rejects with DashboardApiError on an HTTP guard refusal (never falls through as transport)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"rate_limited","message":"slow down"}', { status: 429, headers: { "content-type": "application/json" } })));
    await expect(generateStudioStoreStream("b", "sonnet", () => {})).rejects.toBeInstanceOf(DashboardApiError);
    vi.unstubAllGlobals();
  });

  it("rejects with StudioStreamError when the stream dies without a terminal line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse(['{"stage":"brand"}'])));
    await expect(generateStudioStoreStream("b", "sonnet", () => {})).rejects.toBeInstanceOf(StudioStreamError);
    vi.unstubAllGlobals();
  });

  it("rejects with StudioStreamError when fetch itself fails (network)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(generateStudioStoreStream("b", "sonnet", () => {})).rejects.toBeInstanceOf(StudioStreamError);
    vi.unstubAllGlobals();
  });
});
