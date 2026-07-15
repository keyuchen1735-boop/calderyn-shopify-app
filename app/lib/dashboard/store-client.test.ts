// Chat-box attachments become catalog products (one image in, one draft product
// titled from the filename) OR travel with the prompt to the multipart generate
// endpoint — the two client paths this suite covers.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addProductFromImage,
  buildStudioStoreStream,
  editStudioStorefrontStream,
  generateStudioStoreStream,
  generateStudioStoreWithImages,
  productTitleFromFilename,
  resolveStudioDesign,
  editStudioStorefront,
  undoStudioStorefrontEdit,
  StudioStreamError,
} from "./store-client";
import { DashboardApiError } from "./client";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// client mock still applies even though it is written below them.
const { saveProduct, uploadProductImage, apiSend, apiSendForm } = vi.hoisted(() => ({
  saveProduct: vi.fn(),
  uploadProductImage: vi.fn(),
  apiSend: vi.fn(),
  apiSendForm: vi.fn(),
}));

vi.mock("./client", () => ({
  apiGet: vi.fn(),
  apiSend,
  apiSendForm,
  saveProduct,
  uploadProductImage,
  DashboardApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  saveProduct.mockResolvedValue({ id: "prod-1" });
  uploadProductImage.mockResolvedValue({ id: "media-1", url: "https://x/img.jpg" });
  apiSendForm.mockResolvedValue({ runId: "run-1", status: "draft" });
  apiSend.mockResolvedValue({
    kind: "recipe",
    templateId: "commons-index",
    templateVersion: 1,
    selectionKind: "niche_match",
    routingVersion: 1,
    registryVersion: 1,
    catalogFingerprint: "sha256:catalog",
    score: 12,
    runnerUpScore: 0,
    margin: 12,
    confidenceBand: "high",
    breakdown: [],
    reasons: ["refill match"],
  });
});

describe("runtime-1 design routing client", () => {
  it("requests a server-authoritative recommendation with the versioned design contract", async () => {
    const request = { prompt: "Build a sustainable refill shop", mode: "auto" as const };
    const result = await resolveStudioDesign(request);
    expect(apiSend).toHaveBeenCalledWith("POST", "/dashboard/api/store/resolve", request);
    expect(result).toMatchObject({ kind: "recipe", templateId: "commons-index" });
  });
});

describe("runtime-1 prompt editing client", () => {
  it("sends the expected draft pointer and optional compiler-issued preview context", async () => {
    apiSend.mockResolvedValueOnce({ status: "installed", versionId: "v2" });
    await editStudioStorefront({
      prompt: "Make this title shorter",
      expectedDraftVersionId: "v1",
      context: { routeId: "home", regionId: "cd-home-n2" },
    });
    expect(apiSend).toHaveBeenCalledWith("POST", "/dashboard/api/store", {
      action: "edit",
      prompt: "Make this title shorter",
      expectedDraftVersionId: "v1",
      context: { routeId: "home", regionId: "cd-home-n2" },
    });
  });

  it("sends an undo as a CAS operation", async () => {
    apiSend.mockResolvedValueOnce({ status: "installed", versionId: "v1", undoneVersionId: "v2" });
    await undoStudioStorefrontEdit({ targetVersionId: "v1", expectedDraftVersionId: "v2" });
    expect(apiSend).toHaveBeenCalledWith("POST", "/dashboard/api/store", {
      action: "undo-edit", targetVersionId: "v1", expectedDraftVersionId: "v2",
    });
  });
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
    const controller = new AbortController();
    await generateStudioStoreWithImages("", [pngFile("board.png")], "sonnet", "reference", controller.signal);
    const form = formOf();
    expect(form.get("brief")).toBeNull();
    expect(form.get("model")).toBe("sonnet");
    expect(form.get("intent")).toBe("reference");
    expect(form.getAll("image")).toHaveLength(1);
    expect(apiSendForm.mock.calls[0][2]).toBe(controller.signal);
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
  it("sends a runtime-1 design request, forwards its frozen stages, and resolves on installed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"routing","resolution":{"kind":"recipe","templateId":"commons-index","templateVersion":1,"selectionKind":"niche_match","routingVersion":1,"registryVersion":1,"catalogFingerprint":"sha256:fresh","score":12,"runnerUpScore":0,"margin":12,"confidenceBand":"high","breakdown":[],"reasons":[]},"recommendationChanged":true,"recommendationChangeReason":"Your catalog changed"}',
      '{"stage":"applying_recipe","templateId":"commons-index","templateVersion":1}',
      '{"stage":"compiling"}',
      '{"stage":"validating"}',
      '{"stage":"proofing"}',
      '{"stage":"installed","receipt":{"runtime":1,"versionId":"version-1","status":"draft","resolution":{"kind":"recipe","templateId":"commons-index","templateVersion":1,"selectionKind":"niche_match","routingVersion":1,"registryVersion":1,"catalogFingerprint":"sha256:fresh","score":12,"runnerUpScore":0,"margin":12,"confidenceBand":"high","breakdown":[],"reasons":[]}}}',
    ])));
    const stages: string[] = [];
    const request = { prompt: "refill shop", mode: "auto" as const };
    const recommendation = await resolveStudioDesign(request);
    const receipt = await buildStudioStoreStream(request, (stage) => stages.push(stage), recommendation);

    expect(stages).toEqual(["routing", "applying_recipe", "compiling", "validating", "proofing"]);
    expect(receipt).toMatchObject({ runtime: 1, versionId: "version-1", status: "draft" });
    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ designRequest: request, recommendedResolution: recommendation });
    vi.unstubAllGlobals();
  });

  it("passes the caller abort signal to the runtime-1 build request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Stopped", "AbortError")));

    const pending = buildStudioStoreStream(
      { prompt: "Try a new direction", mode: "auto" },
      () => {},
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    vi.unstubAllGlobals();
  });

  it("preserves custom generation stages and stable in-band conflict codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"routing","resolution":{"kind":"custom","reason":"explicit_custom","routingVersion":1,"registryVersion":1,"catalogFingerprint":"sha256:fresh","breakdown":[],"reasons":[]},"recommendationChanged":false}',
      '{"stage":"generating_original"}',
      '{"stage":"error","code":"storefront_draft_conflict","status":409,"message":"The draft changed. Try again."}',
    ])));
    const stages: string[] = [];
    await expect(buildStudioStoreStream(
      { prompt: "Create something completely new", mode: "custom" },
      (stage) => stages.push(stage),
    )).rejects.toMatchObject({ status: 409, code: "storefront_draft_conflict" });
    expect(stages).toEqual(["routing", "generating_original"]);
  });

  it("keeps the old helper compatible by routing it through the runtime-1 build stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"routing","resolution":{"kind":"recipe","templateId":"commons-index","templateVersion":1,"selectionKind":"niche_match","routingVersion":1,"registryVersion":1,"catalogFingerprint":"sha256:fresh","score":12,"runnerUpScore":0,"margin":12,"confidenceBand":"high","breakdown":[],"reasons":[]},"recommendationChanged":false}',
      '{"stage":"applying_recipe","templateId":"commons-index","templateVersion":1}',
      '{"stage":"installed","receipt":{"runtime":1,"versionId":"version-1","status":"draft","resolution":{"kind":"recipe","templateId":"commons-index","templateVersion":1,"selectionKind":"niche_match","routingVersion":1,"registryVersion":1,"catalogFingerprint":"sha256:fresh","score":12,"runnerUpScore":0,"margin":12,"confidenceBand":"high","breakdown":[],"reasons":[]}}}',
    ])));
    const stages: string[] = [];
    const receipt = await generateStudioStoreStream("a brief", "sonnet", (s) => stages.push(s));
    expect(stages).toEqual(["routing", "applying_recipe"]);
    expect(receipt).toEqual({ runId: "version-1", status: "draft" });
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ designRequest: { prompt: "a brief", mode: "auto" } });
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

describe("editStudioStorefrontStream", () => {
  it("forwards real edit stages and resolves only after the preview version is installed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([
      '{"stage":"compiling"}',
      '{"stage":"validating"}',
      '{"stage":"proofing"}',
      '{"stage":"installing"}',
      '{"stage":"installed","receipt":{"status":"installed","versionId":"version-2","baseVersionId":"version-1","bundle":{},"changedScope":{"designTokens":[],"routes":["collection"]},"browserProof":{"ok":true,"diagnostics":[],"screenshots":[],"browserMs":4},"detachedFromRecipe":true,"undo":{"targetVersionId":"version-1","expectedDraftVersionId":"version-2"}}}',
    ])));
    const stages: string[] = [];

    const receipt = await editStudioStorefrontStream({
      prompt: "Redesign these cards",
      expectedDraftVersionId: "version-1",
    }, (stage) => stages.push(stage));

    expect(stages).toEqual(["compiling", "validating", "proofing", "installing"]);
    expect(receipt).toMatchObject({ status: "installed", versionId: "version-2" });
    vi.unstubAllGlobals();
  });

  it("passes the caller abort signal to the edit request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Stopped", "AbortError")));

    const pending = editStudioStorefrontStream({
      prompt: "Make every page quieter",
      expectedDraftVersionId: "version-1",
    }, () => {}, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    vi.unstubAllGlobals();
  });
});
