// app/routes/__tests__/dashboard.api.store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
// vi.mock is hoisted above these imports by vitest, so the mocks are in place
// before the route module is evaluated (same ordering as dashboard.store.preview
// .test). CalderynError resolves to the mocked class below.
import { action } from "../dashboard.api.store";
import { CalderynError } from "~/lib/calderyn.server";

// The route pulls in the whole studio/experiment/catalog server graph. Mock the
// direct deps so the multipart handler's control flow runs in isolation; keep
// dashboardJson/jsonError real (only requireSameOrigin is stubbed) so the real
// response envelope + CalderynError mapping is exercised.
const {
  sessionMock,
  assertGenMock,
  prechecksMock,
  designerQuotaMock,
  classifyMock,
  generateMock,
  createProductMock,
  uploadMediaMock,
} = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  assertGenMock: vi.fn(),
  prechecksMock: vi.fn(),
  designerQuotaMock: vi.fn(),
  classifyMock: vi.fn(),
  generateMock: vi.fn(),
  createProductMock: vi.fn(),
  uploadMediaMock: vi.fn(),
}));

vi.mock("~/lib/calderyn.server", () => ({
  CalderynError: class CalderynError extends Error {
    code: string;
    status: number;
    details: unknown;
    constructor(o: { code: string; status: number; message: string; details?: unknown }) {
      super(o.message);
      this.name = "CalderynError";
      this.code = o.code;
      this.status = o.status;
      this.details = o.details;
    }
  },
}));
vi.mock("~/lib/dashboard/http.server", async (orig) => {
  const actual = await orig<typeof HttpServer>();
  return { ...actual, requireSameOrigin: () => "https://test.example.com" };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => true }));
vi.mock("~/lib/storegen/guard.server", () => ({
  assertCanGenerate: assertGenMock,
  assertGeneratePrechecks: prechecksMock,
  assertDesignerQuota: designerQuotaMock,
}));
vi.mock("~/lib/storegen/generate.server", () => ({ generateStore: generateMock }));
vi.mock("~/lib/storegen/attachment-intent.server", () => ({ classifyAttachmentIntent: classifyMock }));
vi.mock("~/lib/catalog/catalog.server", () => ({ createProduct: createProductMock }));
vi.mock("~/lib/catalog/media.server", () => ({ uploadProductMedia: uploadMediaMock }));
vi.mock("~/lib/storebuilder/studio.server", () => ({
  loadStudioState: vi.fn(),
  saveStudioHero: vi.fn(),
  saveStudioAccent: vi.fn(),
  saveStudioVibe: vi.fn(),
  publishStudioStore: vi.fn(),
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  decideExperiment: vi.fn(),
  startExperiment: vi.fn(),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const URL = "https://test.example.com/dashboard/api/store";

beforeEach(() => {
  for (const m of [sessionMock, assertGenMock, prechecksMock, designerQuotaMock, classifyMock, generateMock, createProductMock, uploadMediaMock]) {
    m.mockReset();
  }
  sessionMock.mockResolvedValue({ shopId: SHOP, userId: null, accountCreatedAt: null });
  assertGenMock.mockResolvedValue(undefined);
  prechecksMock.mockResolvedValue(undefined);
  designerQuotaMock.mockResolvedValue(undefined);
  generateMock.mockResolvedValue({ runId: "run-1", status: "draft", tokenCost: 0, docs: {} });
  createProductMock.mockResolvedValue({ id: "prod-1" });
  uploadMediaMock.mockResolvedValue({ id: "media-1", storagePath: "p" });
});

function pngFile(name: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

async function postMultipart(fields: {
  action?: string;
  brief?: string;
  model?: string;
  intent?: string;
  images?: File[];
}): Promise<Response> {
  const form = new FormData();
  form.set("action", fields.action ?? "generate");
  if (fields.brief !== undefined) form.set("brief", fields.brief);
  if (fields.model !== undefined) form.set("model", fields.model);
  if (fields.intent !== undefined) form.set("intent", fields.intent);
  for (const f of fields.images ?? []) form.append("image", f);
  const request = new Request(URL, { method: "POST", body: form });
  return (await action({ request } as ActionFunctionArgs)) as Response;
}

describe("dashboard.api.store multipart generate", () => {
  it("rejects an oversize image with 422 before any model spend", async () => {
    const big = new File([new Uint8Array(3_932_161)], "big.png", { type: "image/png" });
    const res = await postMultipart({ brief: "hi", images: [big] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("image_too_large");
    // 422 lands before the guards AND before any classification/generation.
    expect(prechecksMock).not.toHaveBeenCalled();
    expect(designerQuotaMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("maps a precheck refusal to its status with zero model spend (guard before classify)", async () => {
    prechecksMock.mockImplementation(() => {
      throw new CalderynError({ code: "rate_limited", status: 429, message: "Too many generations." });
    });
    const res = await postMultipart({ brief: "hi", images: [pngFile("a.png")] });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("rejects a non-image media type with 422", async () => {
    const bad = new File([new Uint8Array(16)], "notes.pdf", { type: "application/pdf" });
    const res = await postMultipart({ images: [bad] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("unsupported_media_type");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("rejects more than four images with 422", async () => {
    const res = await postMultipart({
      images: [pngFile("a.png"), pngFile("b.png"), pngFile("c.png"), pngFile("d.png"), pngFile("e.png")],
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("too_many_images");
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("returns needs_intent and creates nothing when the model can't classify the attachment", async () => {
    classifyMock.mockResolvedValue(null);
    const res = await postMultipart({ brief: "here you go", images: [pngFile("a.png")] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_intent");
    expect(body.products).toBeUndefined();
    expect(body.runId).toBeUndefined();
    expect(createProductMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    // A classification-only outcome must not burn a daily designer slot — the
    // merchant's follow-up retry would otherwise cost 2 of 5 base-tier slots.
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("creates one draft product per image and surfaces a per-item media failure", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: false });
    createProductMock.mockResolvedValueOnce({ id: "p1" }).mockResolvedValueOnce({ id: "p2" });
    uploadMediaMock
      .mockResolvedValueOnce({ id: "m1", storagePath: "x" })
      .mockRejectedValueOnce(new Error("media_too_large"));
    const res = await postMultipart({ images: [pngFile("red-mug.png"), pngFile("blue-mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("products_added");
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: false });
    expect(createProductMock).toHaveBeenCalledTimes(2);
    expect(createProductMock).toHaveBeenCalledWith(SHOP, { title: "Red mug", status: "draft", variants: [{}] });
    expect(generateMock).not.toHaveBeenCalled();
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toMatchObject({ id: "p1", title: "Red mug" });
    expect(body.products[0].imageError).toBeUndefined();
    expect(body.products[1]).toMatchObject({ id: "p2", title: "Blue mug", imageError: "media_too_large" });
    // Catalog work, not generation — no daily designer slot consumed.
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("contains a failed product create — siblings still created, every image accounted for", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: false });
    createProductMock
      .mockImplementationOnce(() => Promise.reject(new Error("insert failed")))
      .mockResolvedValueOnce({ id: "p2" });
    const res = await postMultipart({ images: [pngFile("red-mug.png"), pngFile("blue-mug.png")] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("products_added");
    // One entry PER image, in order: the failed create carries error (no id);
    // its sibling was still created with its image.
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toEqual({ title: "Red mug", error: "insert failed" });
    expect(body.products[1]).toEqual({ id: "p2", title: "Blue mug" });
    expect(createProductMock).toHaveBeenCalledTimes(2);
    // No upload attempted for the product that was never created.
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);
  });

  it("passes the attachments to generateStore as referenceImages on the reference path", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    const res = await postMultipart({ brief: "match this vibe", images: [pngFile("board.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("run-1");
    expect(body.intent).toEqual({ addAsProducts: false, useAsReference: true });
    expect(createProductMock).not.toHaveBeenCalled();
    // Generation is certain here, so the daily designer slot IS consumed.
    expect(designerQuotaMock).toHaveBeenCalledTimes(1);
    const arg = generateMock.mock.calls[0][0];
    expect(arg.referenceImages).toHaveLength(1);
    expect(arg.referenceImages[0].mediaType).toBe("image/png");
    expect(arg.brief).toBe("match this vibe");
  });

  it("creates products first, then generates, when the intent is both (quota before any write)", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: true });
    const res = await postMultipart({ brief: "add and match", images: [pngFile("mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("run-1");
    expect(createProductMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(body.products).toHaveLength(1);
    // The designer quota is consumed BEFORE any product row is written, so a
    // quota refusal is a clean 429 with no partial writes.
    expect(designerQuotaMock.mock.invocationCallOrder[0]).toBeLessThan(
      createProductMock.mock.invocationCallOrder[0],
    );
  });

  it("returns a 200 'failed' receipt carrying the created products when generation throws after creation", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: true });
    generateMock.mockImplementation(() => Promise.reject(new Error("api down")));
    const res = await postMultipart({ brief: "add and match", images: [pngFile("mug.png")] });
    // NOT the bare 502 — that would discard the fact the drafts now exist.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.runId).toBeUndefined();
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: true });
    expect(body.products).toEqual([{ id: "prod-1", title: "Mug" }]);
  });

  it("keeps the 502 for a products-free reference generation failure (nothing to discard)", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    generateMock.mockImplementation(() => Promise.reject(new Error("api down")));
    const res = await postMultipart({ brief: "match", images: [pngFile("a.png")] });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("generation_failed");
  });

  it("passes the generator's referencesUnread flag through to the receipt", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    generateMock.mockResolvedValue({ runId: "run-2", status: "draft", tokenCost: 0, docs: {}, referencesUnread: true });
    const body = await (await postMultipart({ brief: "match", images: [pngFile("a.png")] })).json();
    expect(body.referencesUnread).toBe(true);
    expect(body.runId).toBe("run-2");
  });

  it("treats a multipart request with no attachments like the plain generate", async () => {
    const res = await postMultipart({ brief: "just a brief" });
    const body = await res.json();
    expect(body).toEqual({ runId: "run-1", status: "draft" });
    expect(classifyMock).not.toHaveBeenCalled();
    // Same guard pair as the JSON path: prechecks then the daily quota.
    expect(prechecksMock).toHaveBeenCalledTimes(1);
    expect(designerQuotaMock).toHaveBeenCalledTimes(1);
  });

  it("skips the classifier when an explicit reference intent is sent, and generates", async () => {
    const res = await postMultipart({ brief: "here you go", intent: "reference", images: [pngFile("board.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("run-1");
    expect(body.intent).toEqual({ addAsProducts: false, useAsReference: true });
    // The whole point: the ambiguous brief is NOT re-classified (that would
    // return null again and loop the merchant back to the same question).
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
    // Generation is certain here, so the daily designer slot IS consumed.
    expect(designerQuotaMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0].referenceImages).toHaveLength(1);
  });

  it("skips the classifier for an explicit products intent and adds drafts only", async () => {
    const res = await postMultipart({ intent: "products", images: [pngFile("red-mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("products_added");
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: false });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
    // Catalog work, not generation — no designer slot consumed.
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("skips the classifier for an explicit both intent (drafts then generate)", async () => {
    const res = await postMultipart({ brief: "add and match", intent: "both", images: [pngFile("mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: true });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(body.products).toHaveLength(1);
  });

  it("rejects an invalid explicit intent with 422 before any spend", async () => {
    const res = await postMultipart({ brief: "hi", intent: "sometimes", images: [pngFile("a.png")] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_intent");
    // Inherited Object.prototype keys must not pass the allowlist (own-key check).
    const proto = await postMultipart({ brief: "hi", intent: "toString", images: [pngFile("a.png")] });
    expect(proto.status).toBe(422);
    expect((await proto.json()).error).toBe("invalid_intent");
    // 422 lands before the guards AND before any classification/generation/spend.
    expect(prechecksMock).not.toHaveBeenCalled();
    expect(designerQuotaMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("leaves the JSON generate path unchanged (no intent classification)", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", brief: "hello" }),
    });
    const res = (await action({ request } as ActionFunctionArgs)) as Response;
    const body = await res.json();
    expect(body).toEqual({ runId: "run-1", status: "draft" });
    expect(classifyMock).not.toHaveBeenCalled();
    // The JSON path still runs the single combined guard, byte-identical.
    expect(assertGenMock).toHaveBeenCalledTimes(1);
  });
});
