// app/routes/__tests__/dashboard.api.store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import { readFileSync } from "node:fs";
import type * as HttpServer from "~/lib/dashboard/http.server";
// vi.mock is hoisted above these imports by vitest, so the mocks are in place
// before the route module is evaluated (same ordering as dashboard.store.preview
// .test). CalderynError resolves to the mocked class below.
import { action } from "../dashboard.api.store";
import { CalderynError } from "~/lib/calderyn.server";
import { StorefrontEditError } from "~/lib/storefront-edit/edit.server";
import { StorefrontReleaseError } from "~/lib/storefront-bundle/release.server";
import { StorefrontBuildError } from "~/lib/storefront-bundle/build.server";

// The route pulls in the whole studio/experiment/catalog server graph. Mock the
// direct deps so the multipart handler's control flow runs in isolation; keep
// dashboardJson/jsonError real (only requireSameOrigin is stubbed) so the real
// response envelope + CalderynError mapping is exercised.
const {
  sessionMock,
  prechecksMock,
  designerQuotaMock,
  classifyMock,
  createProductMock,
  uploadMediaMock,
  publishMock,
  editMock,
  undoEditMock,
  releaseStateMock,
  buildMock,
  prepareBuildMock,
  persistAssetMock,
  cleanupAssetMock,
  rateLimitMock,
  moveSectionMock,
  removeSectionMock,
  regenerateSectionMock,
  savePolicyMock,
  deletePolicyMock,
} = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  prechecksMock: vi.fn(),
  designerQuotaMock: vi.fn(),
  classifyMock: vi.fn(),
  createProductMock: vi.fn(),
  uploadMediaMock: vi.fn(),
  publishMock: vi.fn(),
  editMock: vi.fn(),
  undoEditMock: vi.fn(),
  releaseStateMock: vi.fn(),
  buildMock: vi.fn(),
  prepareBuildMock: vi.fn(),
  persistAssetMock: vi.fn(),
  cleanupAssetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  moveSectionMock: vi.fn(),
  removeSectionMock: vi.fn(),
  regenerateSectionMock: vi.fn(),
  savePolicyMock: vi.fn(),
  deletePolicyMock: vi.fn(),
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
  return { ...actual, requireSameOrigin: () => "https://test.example.com", rateLimit: rateLimitMock };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => true }));
vi.mock("~/lib/storegen/guard.server", () => ({
  assertGeneratePrechecks: prechecksMock,
  assertDesignerQuota: designerQuotaMock,
}));
vi.mock("~/lib/storegen/attachment-intent.server", () => ({ classifyAttachmentIntent: classifyMock }));
vi.mock("~/lib/catalog/catalog.server", () => ({ createProduct: createProductMock }));
vi.mock("~/lib/catalog/media.server", () => ({ uploadProductMedia: uploadMediaMock }));
vi.mock("~/lib/storebuilder/studio.server", () => ({
  loadStudioState: vi.fn(),
  saveStudioHero: vi.fn(),
  saveStudioAccent: vi.fn(),
  saveStudioVibe: vi.fn(),
  moveStudioSection: moveSectionMock,
  removeStudioSection: removeSectionMock,
  regenerateStudioSection: regenerateSectionMock,
  publishStudioStore: publishMock,
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  decideExperiment: vi.fn(),
  startExperiment: vi.fn(),
}));
vi.mock("~/lib/storefront-edit/edit.server", () => ({
  editStorefrontByPrompt: editMock,
  undoStorefrontEdit: undoEditMock,
  StorefrontEditError: class StorefrontEditError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  readStorefrontReleaseState: releaseStateMock,
  prepareStorefrontDesignBuild: prepareBuildMock,
  buildStorefrontDesign: buildMock,
  StorefrontBuildError: class StorefrontBuildError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront-bundle/assets.server", () => ({
  persistStorefrontAssetBytes: persistAssetMock,
  garbageCollectUnreferencedStorefrontAsset: cleanupAssetMock,
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront/policies.server", () => ({
  STOREFRONT_POLICY_TITLE_MAX: 120,
  STOREFRONT_POLICY_BODY_MAX: 50_000,
  isStorefrontPolicyId: (value: unknown) => ["privacy", "terms", "refund", "shipping"].includes(String(value)),
  saveStorefrontPolicy: savePolicyMock,
  deleteStorefrontPolicy: deletePolicyMock,
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const URL = "https://test.example.com/dashboard/api/store";

beforeEach(() => {
  for (const m of [sessionMock, prechecksMock, designerQuotaMock, classifyMock, createProductMock, uploadMediaMock, publishMock, editMock, undoEditMock, releaseStateMock, buildMock, prepareBuildMock, persistAssetMock, cleanupAssetMock, rateLimitMock, moveSectionMock, removeSectionMock, regenerateSectionMock, savePolicyMock, deletePolicyMock]) {
    m.mockReset();
  }
  sessionMock.mockResolvedValue({ shopId: SHOP, userId: null, accountCreatedAt: null });
  prechecksMock.mockResolvedValue(undefined);
  designerQuotaMock.mockResolvedValue(undefined);
  createProductMock.mockResolvedValue({ id: "prod-1" });
  uploadMediaMock.mockResolvedValue({ id: "media-1", storagePath: "p" });
  publishMock.mockResolvedValue("https://moonlight-ceramics-a1b2c3.calderyncompany.com/storefront");
  editMock.mockResolvedValue({ status: "installed", versionId: "44444444-4444-4444-4444-444444444444", changedScope: { routes: ["home"], designTokens: [] }, detachedFromRecipe: false });
  undoEditMock.mockResolvedValue({ status: "installed", versionId: "33333333-3333-3333-3333-333333333333", undoneVersionId: "44444444-4444-4444-4444-444444444444" });
  releaseStateMock.mockResolvedValue({ draftVersionId: null, publishedVersionId: null, draftRuntimeVersion: null, publishedRuntimeVersion: null });
  prepareBuildMock.mockResolvedValue({ evidence: {}, resolution: { kind: "custom" }, pointers: { draftVersionId: null, publishedVersionId: null } });
  buildMock.mockResolvedValue({ runtime: 1, versionId: "55555555-5555-5555-5555-555555555555", status: "draft", resolution: { kind: "custom" } });
  persistAssetMock.mockResolvedValue({ assetKey: `${SHOP}/storefront/sha256/asset.png`, contentHash: "a".repeat(64), mediaType: "image/png", byteSize: 16 });
  cleanupAssetMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue(true);
  moveSectionMock.mockResolvedValue([]);
  removeSectionMock.mockResolvedValue([]);
  regenerateSectionMock.mockResolvedValue([]);
  savePolicyMock.mockResolvedValue({
    id: "privacy", title: "Privacy policy", body: "We use data to fulfill orders.", updatedAt: "2026-07-14T12:00:00.000Z",
  });
  deletePolicyMock.mockResolvedValue(undefined);
});

function pngFile(name: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function gifFile(name: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/gif" });
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
  it("saves a bounded policy for the authenticated session shop", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "policy-save",
        policyId: "privacy",
        title: "Privacy policy",
        body: "We use data to fulfill orders.",
      }),
    });

    const response = await action({ request } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(savePolicyMock).toHaveBeenCalledWith(SHOP, {
      id: "privacy", title: "Privacy policy", body: "We use data to fulfill orders.",
    });
  });

  it("rejects invalid policy fields before calling the service", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "policy-save", policyId: "privacy", title: "", body: "Body" }),
    });

    const response = await action({ request } as ActionFunctionArgs);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_storefront_policy_title" });
    expect(savePolicyMock).not.toHaveBeenCalled();
  });

  it("deletes only an allowlisted policy for the authenticated session shop", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "policy-delete", policyId: "shipping" }),
    });

    const response = await action({ request } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(deletePolicyMock).toHaveBeenCalledWith(SHOP, "shipping");
  });

  it.each(["section-move", "section-remove", "section-regenerate"])(
    "rejects legacy %s against a runtime-1 draft before mutating page documents",
    async (sectionAction) => {
      releaseStateMock.mockResolvedValue({
        draftVersionId: "33333333-3333-3333-3333-333333333333",
        publishedVersionId: null,
        draftRuntimeVersion: 1,
        publishedRuntimeVersion: null,
      });
      const request = new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: sectionAction, id: "hero", direction: "down", instruction: "Try again" }),
      });

      const response = await action({ request } as ActionFunctionArgs);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "storefront_bundle_section_edit_required",
        message: "This storefront uses prompt editing. Ask Calderyn to change or reorder this section.",
      });
      expect(moveSectionMock).not.toHaveBeenCalled();
      expect(removeSectionMock).not.toHaveBeenCalled();
      expect(regenerateSectionMock).not.toHaveBeenCalled();
    },
  );

  it("keeps every active storefront build entrypoint off the legacy generator import path", () => {
    const sources = [
      "app/routes/dashboard.api.store.tsx",
      "app/routes/dashboard.api.store.generate.tsx",
      "app/lib/storefront-bundle/build.server.ts",
    ].map((url) => readFileSync(url, "utf8"));
    for (const source of sources) expect(source).not.toContain("storegen/generate.server");
    expect(sources.join("\n")).toContain("storefront-ai/generate.server");
  });

  it("routes a reference rebuild from a runtime-1 draft through the original compiler", async () => {
    releaseStateMock.mockResolvedValue({ draftVersionId: "33333333-3333-3333-3333-333333333333", publishedVersionId: null, draftRuntimeVersion: 1, publishedRuntimeVersion: null });
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    const response = await postMultipart({ brief: "use this as a design reference", images: [pngFile("reference.png")] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "draft", runId: "55555555-5555-5555-5555-555555555555" });
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(buildMock).toHaveBeenCalledTimes(1);
  });
  it("applies a scoped runtime-1 prompt edit with the authenticated actor", async () => {
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit", prompt: "Shorten this heading",
        expectedDraftVersionId: "33333333-3333-3333-3333-333333333333",
        context: { routeId: "home", regionId: "cd-home-n2" },
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(editMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP, actorId: null, prompt: "Shorten this heading",
      expectedDraftVersionId: "33333333-3333-3333-3333-333333333333",
      context: { routeId: "home", regionId: "cd-home-n2" },
    }));
  });

  it("aborts the underlying prompt edit when its stream consumer stops", async () => {
    let editSignal: AbortSignal | undefined;
    let finishEdit = () => {};
    editMock.mockImplementationOnce((input: { signal?: AbortSignal }) => new Promise((resolve) => {
      editSignal = input.signal;
      finishEdit = () => resolve({ status: "installed" });
    }));
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit", prompt: "Restyle every page",
        expectedDraftVersionId: "33333333-3333-3333-3333-333333333333",
      }),
    });

    const response = await action({ request } as ActionFunctionArgs);
    const cancelled = response.body!.getReader().cancel();

    expect(editSignal?.aborted).toBe(true);
    finishEdit();
    await cancelled;
  });

  it("undoes an edit through the same authenticated CAS boundary", async () => {
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "undo-edit",
        targetVersionId: "33333333-3333-3333-3333-333333333333",
        expectedDraftVersionId: "44444444-4444-4444-4444-444444444444",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(undoEditMock).toHaveBeenCalledWith(expect.objectContaining({ shopId: SHOP, actorId: null }));
  });

  it("streams the honest custom-writer disabled response for prompt edits", async () => {
    editMock.mockRejectedValueOnce(new StorefrontEditError(
      "storefront_custom_build_disabled",
      "Original AI storefront generation is not available right now. Your current draft was not changed.",
      503,
    ));
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit", prompt: "Create a cinematic editorial opening",
        expectedDraftVersionId: "33333333-3333-3333-3333-333333333333",
      }),
    });

    const response = await action({ request } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(JSON.parse((await response.text()).trim())).toEqual({
      stage: "error",
      code: "storefront_custom_build_disabled",
      status: 503,
      message: "Original AI storefront generation is not available right now. Your current draft was not changed.",
    });
    expect(undoEditMock).not.toHaveBeenCalled();
  });

  it("returns the honest recipe-writer disabled response for edit undo", async () => {
    undoEditMock.mockRejectedValueOnce(new StorefrontEditError(
      "storefront_recipe_build_disabled",
      "Recipe storefront builds are temporarily disabled. Your current draft was not changed.",
      503,
    ));
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "undo-edit",
        targetVersionId: "33333333-3333-3333-3333-333333333333",
        expectedDraftVersionId: "44444444-4444-4444-4444-444444444444",
      }),
    });

    const response = await action({ request } as ActionFunctionArgs);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "storefront_recipe_build_disabled",
      message: "Recipe storefront builds are temporarily disabled. Your current draft was not changed.",
    });
    expect(editMock).not.toHaveBeenCalled();
  });

  it("streams the stable edit conflict contract", async () => {
    editMock.mockRejectedValueOnce(new StorefrontEditError("storefront_edit_conflict", "The draft changed", 409));
    const request = new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "edit", prompt: "Make it warmer",
        expectedDraftVersionId: "33333333-3333-3333-3333-333333333333",
      }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(JSON.parse((await response.text()).trim())).toMatchObject({
      stage: "error", code: "storefront_edit_conflict", status: 409,
    });
  });
  it("passes the authenticated actor into the runtime-aware atomic publish seam", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    });
    const response = (await action({ request } as ActionFunctionArgs)) as Response;
    expect(response.status).toBe(200);
    expect(publishMock).toHaveBeenCalledWith(SHOP, null);
    await expect(response.json()).resolves.toMatchObject({
      storefrontUrl: "https://moonlight-ceramics-a1b2c3.calderyncompany.com/storefront",
    });
  });

  it("maps runtime-1 publish CAS conflicts to the truthful release status", async () => {
    publishMock.mockRejectedValueOnce(new StorefrontReleaseError("storefront_publish_conflict", "The live release changed.", 409));
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    });
    const response = await action({ request } as ActionFunctionArgs);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "storefront_publish_conflict", message: "The live release changed." });
  });

  it("rejects an oversize image with 422 before any model spend", async () => {
    const big = new File([new Uint8Array(3_932_161)], "big.png", { type: "image/png" });
    const res = await postMultipart({ brief: "hi", images: [big] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("image_too_large");
    // 422 lands before the guards AND before any classification/generation.
    expect(prechecksMock).not.toHaveBeenCalled();
    expect(designerQuotaMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
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
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("rejects a non-image media type with 422", async () => {
    const bad = new File([new Uint8Array(16)], "notes.pdf", { type: "application/pdf" });
    const res = await postMultipart({ images: [bad] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("unsupported_media_type");
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
    // A classification-only outcome must not delay the merchant's follow-up.
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
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toMatchObject({ id: "p1", title: "Red mug" });
    expect(body.products[0].imageError).toBeUndefined();
    expect(body.products[1]).toMatchObject({ id: "p2", title: "Blue mug", imageError: "media_too_large" });
    // Catalog work, not generation — no designer cooldown started.
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

  it("persists reference attachments into the Task10 asset path and calls the original builder, never legacy generation", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    const res = await postMultipart({ brief: "match this vibe", images: [pngFile("board.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("55555555-5555-5555-5555-555555555555");
    expect(body.intent).toEqual({ addAsProducts: false, useAsReference: true });
    expect(createProductMock).not.toHaveBeenCalled();
    // Generation is certain here, so the builder owns the designer cooldown.
    expect(persistAssetMock).toHaveBeenCalledWith({ shopId: SHOP, bytes: expect.any(Uint8Array) });
    expect(cleanupAssetMock).toHaveBeenCalledWith({
      shopId: SHOP,
      assetKey: `${SHOP}/storefront/sha256/asset.png`,
    });
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      request: { prompt: "match this vibe", mode: "custom" },
      referenceImages: [{ assetKey: `${SHOP}/storefront/sha256/asset.png`, mediaType: "image/png" }],
    }));
  });

  it("rejects GIF design references before persistence or quota reservation", async () => {
    const response = await postMultipart({ brief: "match this", intent: "reference", images: [gifFile("mood.gif")] });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "unsupported_reference_image" });
    expect(prepareBuildMock).not.toHaveBeenCalled();
    expect(persistAssetMock).not.toHaveBeenCalled();
    expect(cleanupAssetMock).not.toHaveBeenCalled();
  });

  it("garbage-collects reference-only assets when generation fails", async () => {
    buildMock.mockRejectedValueOnce(new Error("provider down"));
    const response = await postMultipart({ brief: "match this", intent: "reference", images: [pngFile("mood.png")] });
    expect(response.status).toBe(502);
    expect(cleanupAssetMock).toHaveBeenCalledWith({
      shopId: SHOP,
      assetKey: `${SHOP}/storefront/sha256/asset.png`,
    });
  });

  it("garbage-collects earlier reference assets when a later persistence fails", async () => {
    persistAssetMock
      .mockResolvedValueOnce({ assetKey: `${SHOP}/storefront/sha256/first.png`, contentHash: "a".repeat(64), mediaType: "image/png", byteSize: 16 })
      .mockRejectedValueOnce(new Error("storage unavailable"));
    const response = await postMultipart({
      brief: "match these",
      intent: "reference",
      images: [pngFile("one.png"), pngFile("two.png")],
    });
    expect(response.status).toBe(500);
    expect(cleanupAssetMock).toHaveBeenCalledWith({
      shopId: SHOP,
      assetKey: `${SHOP}/storefront/sha256/first.png`,
    });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("returns a truthful preflight flag refusal before persisting a reference asset", async () => {
    prepareBuildMock.mockRejectedValueOnce(new StorefrontBuildError(
      "storefront_custom_build_disabled", "Original builds are temporarily disabled.", 503,
    ));
    const response = await postMultipart({ brief: "match this vibe", intent: "reference", images: [pngFile("board.png")] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storefront_custom_build_disabled", message: "Original builds are temporarily disabled." });
    expect(persistAssetMock).not.toHaveBeenCalled();
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("creates products first, then generates, when the intent is both (guard before any write)", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: true });
    const res = await postMultipart({ brief: "add and match", images: [pngFile("mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("55555555-5555-5555-5555-555555555555");
    expect(createProductMock).toHaveBeenCalledTimes(1);
    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(body.products).toHaveLength(1);
    // The designer guard runs before any product row is written, so a refusal
    // is a clean 429 with no partial writes.
    expect(prepareBuildMock.mock.invocationCallOrder[0]).toBeLessThan(
      createProductMock.mock.invocationCallOrder[0],
    );
  });

  it("returns a 200 'failed' receipt carrying the created products when generation throws after creation", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: true, useAsReference: true });
    buildMock.mockRejectedValueOnce(new Error("api down"));
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
    buildMock.mockRejectedValueOnce(new Error("api down"));
    const res = await postMultipart({ brief: "match", images: [pngFile("a.png")] });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("storefront_build_failed");
  });

  it("returns the installed runtime-1 version for a reference build", async () => {
    classifyMock.mockResolvedValue({ addAsProducts: false, useAsReference: true });
    const body = await (await postMultipart({ brief: "match", images: [pngFile("a.png")] })).json();
    expect(body.referencesUnread).toBeUndefined();
    expect(body.runId).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("treats a multipart request with no attachments like the plain generate", async () => {
    const res = await postMultipart({ brief: "just a brief" });
    const body = await res.json();
    expect(body).toEqual({ runId: "55555555-5555-5555-5555-555555555555", status: "draft" });
    expect(classifyMock).not.toHaveBeenCalled();
    // Same guard path as the JSON request.
    expect(prechecksMock).toHaveBeenCalledTimes(1);
    expect(designerQuotaMock).not.toHaveBeenCalled();
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it("skips the classifier when an explicit reference intent is sent, and generates", async () => {
    const res = await postMultipart({ brief: "here you go", intent: "reference", images: [pngFile("board.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.runId).toBe("55555555-5555-5555-5555-555555555555");
    expect(body.intent).toEqual({ addAsProducts: false, useAsReference: true });
    // The whole point: the ambiguous brief is NOT re-classified (that would
    // return null again and loop the merchant back to the same question).
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
    // Generation is certain here, so the builder owns the designer cooldown.
    expect(designerQuotaMock).not.toHaveBeenCalled();
    expect(buildMock.mock.calls[0][0].referenceImages).toHaveLength(1);
  });

  it("rejects a GIF as an AI visual reference instead of casting it into the Task10 contract", async () => {
    persistAssetMock.mockResolvedValueOnce({
      assetKey: `${SHOP}/storefront/sha256/asset.gif`, contentHash: "a".repeat(64), mediaType: "image/gif", byteSize: 16,
    });
    const gif = new File([new Uint8Array(16)], "motion.gif", { type: "image/gif" });
    const response = await postMultipart({ brief: "match this", intent: "reference", images: [gif] });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "unsupported_reference_image" });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("skips the classifier for an explicit products intent and adds drafts only", async () => {
    const res = await postMultipart({ intent: "products", images: [pngFile("red-mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("products_added");
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: false });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).toHaveBeenCalledTimes(1);
    // Catalog work, not generation — no designer cooldown started.
    expect(designerQuotaMock).not.toHaveBeenCalled();
  });

  it("skips the classifier for an explicit both intent (drafts then generate)", async () => {
    const res = await postMultipart({ brief: "add and match", intent: "both", images: [pngFile("mug.png")] });
    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.intent).toEqual({ addAsProducts: true, useAsReference: true });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(createProductMock).toHaveBeenCalledTimes(1);
    expect(buildMock).toHaveBeenCalledTimes(1);
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
  });

  it("routes the JSON generate compatibility path into the runtime-1 builder", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate", brief: "hello" }),
    });
    const res = (await action({ request } as ActionFunctionArgs)) as Response;
    const body = await res.json();
    expect(body).toEqual({ runId: "55555555-5555-5555-5555-555555555555", status: "draft" });
    expect(classifyMock).not.toHaveBeenCalled();
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({ request: { prompt: "hello", mode: "auto" } }));
  });
});
