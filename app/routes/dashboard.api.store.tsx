import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  loadStudioState,
  saveStudioHero,
  saveStudioAccent,
  saveStudioVibe,
  publishStudioStore,
  moveStudioSection,
  removeStudioSection,
  regenerateStudioSection,
} from "~/lib/storebuilder/studio.server";
import { decideExperiment, startExperiment, type StoreExperimentKind } from "~/lib/experiments/store-experiment.server";
import { classifyAttachmentIntent, type AttachmentImage, type AttachmentIntent } from "~/lib/storegen/attachment-intent.server";
import { assertDesignerQuota, assertGeneratePrechecks } from "~/lib/storegen/guard.server";
import { createProduct } from "~/lib/catalog/catalog.server";
import { uploadProductMedia } from "~/lib/catalog/media.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import {
  STUDIO_IMAGE_MEDIA_TYPES,
  STUDIO_EXPERIMENT_KINDS,
  type StudioVibe,
  type StudioGenerateReceipt,
  type StudioAddedProduct,
} from "~/lib/storebuilder/studio-types";
import { quotaTrusted } from "~/lib/ai-quota.server";
import type { DashboardSession } from "~/lib/dashboard/session.server";
import {
  editStorefrontByPrompt,
  StorefrontEditError,
  undoStorefrontEdit,
} from "~/lib/storefront-edit/edit.server";
import type { PreviewEditContext, StorefrontEditEvent } from "~/lib/storefront-edit/types";
import {
  buildStorefrontDesign,
  prepareStorefrontDesignBuild,
  readStorefrontReleaseState,
  StorefrontBuildError,
  type PreparedStorefrontDesignBuild,
} from "~/lib/storefront-bundle/build.server";
import {
  garbageCollectUnreferencedStorefrontAsset,
  persistStorefrontAssetBytes,
} from "~/lib/storefront-bundle/assets.server";
import { StorefrontReleaseError } from "~/lib/storefront-bundle/release.server";
import {
  STOREFRONT_REFERENCE_MEDIA_TYPES,
  type MerchantReferenceImage,
} from "~/lib/storefront-ai/contracts";
import {
  deleteStorefrontPolicy,
  isStorefrontPolicyId,
  saveStorefrontPolicy,
  STOREFRONT_POLICY_BODY_MAX,
  STOREFRONT_POLICY_TITLE_MAX,
} from "~/lib/storefront/policies.server";

// Store studio read model: brand settings, home hero copy, preview products,
// draft/published flags, and the latest generation run.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadStudioState(session.shopId));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HERO_TEXT_MAX = 300;
const STUDIO_VIBES: readonly string[] = ["minimal", "bold", "warm"];
const EXPERIMENT_KINDS: readonly string[] = STUDIO_EXPERIMENT_KINDS;
const EXPERIMENT_DECISIONS: readonly string[] = ["ship", "keep", "stop"];
const EXPERIMENT_NAME_MAX = 80;
const EDIT_PROMPT_MAX = 2_000;
const EDIT_ROUTES = new Set(["home", "collection", "product", "search", "cart", "checkout"]);
const COMPILER_ID_RE = /^[a-zA-Z0-9_-]{1,120}$/;

function heroText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length <= HERO_TEXT_MAX ? t : null;
}

function editContext(value: unknown): PreviewEditContext | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.routeId !== "string" || !EDIT_ROUTES.has(record.routeId) ||
      typeof record.regionId !== "string" || !COMPILER_ID_RE.test(record.regionId)) return null;
  return { routeId: record.routeId as PreviewEditContext["routeId"], regionId: record.regionId };
}

async function editResponse(run: () => Promise<unknown>): Promise<Response> {
  try {
    return new Response(JSON.stringify(await run()), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof StorefrontEditError) return jsonError(error.status, error.code, error.message);
    console.error("[dashboard.api.store] storefront edit failed", error);
    return jsonError(500, "storefront_edit_failed", "The storefront edit failed. Your draft was not changed.");
  }
}

function editStreamResponse(run: (send: (event: StorefrontEditEvent) => void) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StorefrontEditEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await run(send);
        if (result && typeof result === "object" && (result as { status?: unknown }).status === "start_over") {
          send({ stage: "start_over", receipt: result as { status: "start_over"; mode: "custom" } });
        }
      } catch (error) {
        if (error instanceof StorefrontEditError) {
          send({ stage: "error", code: error.code, status: error.status, message: error.message });
        } else {
          console.error("[dashboard.api.store] storefront edit failed", error);
          send({ stage: "error", code: "storefront_edit_failed", status: 500, message: "The storefront edit failed. Your draft was not changed." });
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function releaseResponse(run: () => Promise<unknown>): Promise<Response> {
  try {
    return new Response(JSON.stringify(await run()), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof StorefrontReleaseError || error instanceof StorefrontBuildError) {
      return jsonError(error.status, error.code, error.message);
    }
    if (error instanceof CalderynError) return jsonError(error.status, error.code, error.message);
    console.error("[dashboard.api.store] storefront release mutation failed", error);
    return jsonError(500, "storefront_release_failed", "The storefront release was not changed.");
  }
}

// Attachment limits for the multipart generate path. The Anthropic image API
// caps a single image at ~5MB AFTER base64 inflation; base64 grows raw bytes by
// ~4/3, so the RAW (pre-inflation) cap must be lower: 3,932,160 bytes (3.75 MiB)
// inflates to ~5 MiB of base64 and stays under the per-image ceiling. Reject at
// this raw size before buffering/encoding the body.
const MAX_IMAGE_BYTES = 3_932_160;
const MAX_IMAGES = 4;
// Shared with the composer's staging screen (studio-types.ts) — one allowlist.
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(STUDIO_IMAGE_MEDIA_TYPES);
const REFERENCE_MEDIA_TYPES: ReadonlySet<string> = new Set(STOREFRONT_REFERENCE_MEDIA_TYPES);

// Explicit intent override the needs_intent quick-reply resubmits: the merchant
// already told us what to do, so map the choice straight to a decision and SKIP
// classifyAttachmentIntent — re-running the classifier on the same ambiguous
// brief would return null again and loop the merchant back to the same question.
// Any other value is a client bug → 422 invalid_intent.
const EXPLICIT_INTENTS: Record<string, AttachmentIntent> = {
  products: { addAsProducts: true, useAsReference: false },
  reference: { addAsProducts: false, useAsReference: true },
  both: { addAsProducts: true, useAsReference: true },
};

/** An attachment buffered once and reused for classification, the vision
 *  reference blocks, and the draft-product upload. */
interface BufferedImage {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  dataBase64: string;
}

/** "red-ceramic_mug.v2.jpg" → "Red ceramic mug v2" — a starter title for a draft
 *  product created from a chat-box image attachment. Server twin of the client's
 *  productTitleFromFilename (store-client.ts); reimplemented here so the server
 *  path pulls in no client module. */
function productTitleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]+$/i, "");
  const words = stem.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "New product";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Turn one attachment into a draft catalog product: create the draft row, then
 *  attach the image. CONTAINED per item — this never throws, so one bad image
 *  can't abort its siblings or hide the drafts already written (rule 12):
 *  a failed create returns an `error` item (no id, nothing was written); a
 *  failed upload leaves the imageless draft and records `imageError` — never a
 *  rollback (a retry would mint a duplicate) and never hidden. Mirrors the
 *  client's addProductFromImage semantics. */
async function createDraftProductFromImage(shopId: string, img: BufferedImage): Promise<StudioAddedProduct> {
  const title = productTitleFromFilename(img.filename);
  let id: string;
  try {
    ({ id } = await createProduct(shopId, { title, status: "draft", variants: [{}] }));
  } catch (err) {
    console.error(`[dashboard.api.store] draft product create failed for "${title}"`, err);
    return { title, error: err instanceof Error ? err.message : "product create failed" };
  }
  try {
    await uploadProductMedia(shopId, id, { bytes: img.bytes, filename: img.filename, contentType: img.contentType });
  } catch (err) {
    console.error(`[dashboard.api.store] product media upload failed for ${id}`, err);
    return { id, title, imageError: err instanceof Error ? err.message : "image upload failed" };
  }
  return { id, title };
}

async function runStorefrontBuild(
  session: DashboardSession,
  prompt: string,
  mode: "auto" | "custom",
  referenceImages?: MerchantReferenceImage[],
  preparedInput?: PreparedStorefrontDesignBuild,
): Promise<{ versionId: string }> {
  try {
    const request = { prompt, mode } as const;
    const prepared = preparedInput ?? await prepareRuntimeBuild(session.shopId, request, quotaTrusted(session));
    const receipt = await buildStorefrontDesign({
      shopId: session.shopId,
      actorId: session.userId,
      trusted: quotaTrusted(session),
      request,
      prepared,
      ...(referenceImages?.length ? { referenceImages } : {}),
    });
    return { versionId: receipt.versionId };
  } catch (err) {
    if (err instanceof CalderynError) throw err;
    if (err instanceof StorefrontBuildError || err instanceof StorefrontReleaseError) {
      throw new CalderynError({ code: err.code, status: err.status, message: err.message });
    }
    console.error("[dashboard.api.store] storefront build failed", err);
    throw new CalderynError({
      code: "storefront_build_failed",
      status: 502,
      message: "Storefront build failed. Your current draft was not changed.",
    });
  }
}

async function prepareRuntimeBuild(
  shopId: string,
  request: { prompt: string; mode: "auto" | "custom" },
  trusted: boolean,
): Promise<PreparedStorefrontDesignBuild> {
  if (!(await rateLimit(`storefront-build:${shopId}`, 10, 60_000))) {
    throw new CalderynError({ code: "rate_limited", status: 429, message: "Too many storefront builds. Please wait a moment." });
  }
  try {
    return await prepareStorefrontDesignBuild({ shopId, request, trusted });
  } catch (error) {
    if (error instanceof StorefrontBuildError || error instanceof StorefrontReleaseError) {
      throw new CalderynError({ code: error.code, status: error.status, message: error.message });
    }
    throw error;
  }
}

async function assertLegacySectionMutationAllowed(shopId: string): Promise<void> {
  const release = await readStorefrontReleaseState(shopId);
  if (release.draftVersionId && release.draftRuntimeVersion === 1) {
    throw new CalderynError({
      code: "storefront_bundle_section_edit_required",
      status: 409,
      message: "This storefront uses prompt editing. Ask Calderyn to change or reorder this section.",
    });
  }
}

/**
 * Multipart generate: the studio chat sends the brief + attached images together.
 * Validates every attachment at the boundary (422 before any model spend), runs
 * the shared generate guard, then lets the model DECIDE what the images are for
 * (add-as-products / style-reference / both) and acts on that decision
 * deterministically. A null decision is surfaced as "needs_intent" — the route
 * never silently drafts products off an ambiguous attachment (rule 12).
 */
async function handleMultipartGenerate(request: Request, session: DashboardSession): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(422, "invalid_form");
  }
  if (form.get("action") !== "generate") return jsonError(422, "unknown_action");

  const briefField = form.get("brief");
  if (briefField !== null && typeof briefField !== "string") return jsonError(422, "invalid_brief");
  const modelField = form.get("model");
  if (modelField !== null && modelField !== "sonnet" && modelField !== "opus") {
    return jsonError(422, "invalid_model", "Model must be sonnet or opus.");
  }
  const rawBrief = typeof briefField === "string" ? briefField : undefined;

  // Optional explicit intent (the needs_intent quick-reply resubmission). Valid
  // → bypass the classifier below; invalid → 422 before any spend.
  const intentField = form.get("intent");
  let explicitIntent: AttachmentIntent | undefined;
  if (intentField !== null) {
    if (typeof intentField !== "string" || !Object.hasOwn(EXPLICIT_INTENTS, intentField)) {
      return jsonError(422, "invalid_intent", "Intent must be products, reference or both.");
    }
    explicitIntent = EXPLICIT_INTENTS[intentField];
  }

  // Validate every attachment BEFORE any model spend (rule: never trust body shapes).
  const entries = form.getAll("image");
  if (entries.length > MAX_IMAGES) {
    return jsonError(422, "too_many_images", "Attach at most 4 images.");
  }
  const files: File[] = [];
  for (const entry of entries) {
    if (!(entry instanceof File) || entry.size === 0) {
      return jsonError(422, "invalid_image", "Each attachment must be an image file.");
    }
    if (!IMAGE_MEDIA_TYPES.has(entry.type)) {
      return jsonError(422, "unsupported_media_type", "Images must be PNG, JPEG, WebP or GIF.");
    }
    if (entry.size > MAX_IMAGE_BYTES) {
      return jsonError(422, "image_too_large", "Each image must be under 3.75 MB.");
    }
    files.push(entry);
  }

  return dashboardJson(async () => {
    // Cheap guards first (brief cap, burst limit, mid-test refusal) — BEFORE any
    // model spend. The daily designer quota is deliberately NOT consumed here:
    // checkAiQuota records a hit at check time, so a needs_intent reply (and the
    // merchant's follow-up retry) or a products-only outcome must not burn one of
    // the day's generation slots. The classification call below is still model
    // spend, but it is cheap (digest model, ~300 tokens) and bounded by the same
    // burst limit — an accepted tradeoff, see guard.server.ts.
    await assertGeneratePrechecks(session.shopId, rawBrief);
    const brief = rawBrief && rawBrief.trim() ? rawBrief.trim() : undefined;

    // Multipart with no attachments uses the same prompt-first runtime-1 router
    // as the JSON compatibility path. Recipe installs do not consume AI quota;
    // a custom resolution is billed inside the original compiler preflight.
    if (files.length === 0) {
      const result = await runStorefrontBuild(session, brief ?? "", "auto");
      return { runId: result.versionId, status: "draft" } satisfies StudioGenerateReceipt;
    }

    // Buffer + base64-encode each image once; reused across the three consumers.
    const images: BufferedImage[] = await Promise.all(
      files.map(async (f) => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        return { filename: f.name, contentType: f.type, bytes, dataBase64: Buffer.from(bytes).toString("base64") };
      }),
    );
    const asAttachmentImages = (): AttachmentImage[] =>
      images.map((i) => ({ mediaType: i.contentType, dataBase64: i.dataBase64 }));

    // An explicit intent skips classification entirely (the quick-reply already
    // resolved the ambiguity); otherwise the model decides what the images are for.
    const intent = explicitIntent ?? (await classifyAttachmentIntent({ brief: brief ?? null, images: asAttachmentImages() }));
    // Couldn't tell what to do → ask the merchant. No generation, no products —
    // and no designer quota consumed. (Unreachable when intent was explicit.)
    if (!intent) return { status: "needs_intent" } satisfies StudioGenerateReceipt;

    const customPrompt = brief ?? "Use the attached images as the design reference.";
    if (intent.useAsReference && images.some((image) => !REFERENCE_MEDIA_TYPES.has(image.contentType))) {
      throw new CalderynError({
        code: "unsupported_reference_image",
        status: 422,
        message: "Design references must be PNG, JPEG or WebP images.",
      });
    }
    // Freeze switches and write permission before persisting reference assets
    // or creating catalog drafts. The builder consumes this exact decision.
    const prepared = intent.useAsReference
      ? await prepareRuntimeBuild(session.shopId, { prompt: customPrompt, mode: "custom" }, quotaTrusted(session))
      : undefined;

    const referenceAssetKeys: string[] = [];
    try {
      const referenceImages: MerchantReferenceImage[] = [];
      if (intent.useAsReference) {
        for (const image of images) {
          const persisted = await persistStorefrontAssetBytes({ shopId: session.shopId, bytes: image.bytes });
          referenceAssetKeys.push(persisted.assetKey);
          if (!REFERENCE_MEDIA_TYPES.has(persisted.mediaType)) {
            throw new CalderynError({
              code: "unsupported_reference_image",
              status: 422,
              message: "Design references must be PNG, JPEG or WebP images.",
            });
          }
          referenceImages.push({ assetKey: persisted.assetKey, mediaType: persisted.mediaType as MerchantReferenceImage["mediaType"] });
        }
      }

    // Create products FIRST (draft rows), THEN generate — the generator re-reads
    // the catalog, so the new drafts land in the snapshot it designs around.
    // In PARALLEL (distinct rows, no contention) and contained per item (the
    // helper never throws), so every attached image gets a receipt entry.
      const products: StudioAddedProduct[] = intent.addAsProducts
      ? await Promise.all(images.map((img) => createDraftProductFromImage(session.shopId, img)))
      : [];

      if (intent.useAsReference) {
      let result: { versionId: string };
      try {
        result = await runStorefrontBuild(session, customPrompt, "custom", referenceImages, prepared);
      } catch (err) {
        // Products were already written; the shared 502 would discard that fact.
        // Return an honest 200 receipt carrying both: the created products AND
        // the failed generation (status "failed", no runId). The products-free
        // reference path keeps the same 502 as the JSON path.
        if (products.length > 0) {
          return { status: "failed", intent, products } satisfies StudioGenerateReceipt;
        }
        throw err;
      }
      return {
        runId: result.versionId,
        status: "draft",
        intent,
        ...(products.length > 0 ? { products } : {}),
      } satisfies StudioGenerateReceipt;
    }

    // Products only — no generation ran, no designer quota touched.
      return { status: "products_added", intent, products } satisfies StudioGenerateReceipt;
    } finally {
      await Promise.all(referenceAssetKeys.map((assetKey) => garbageCollectUnreferencedStorefrontAsset({
        shopId: session.shopId,
        assetKey,
      })));
    }
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Images travel with the prompt as multipart/form-data; every other studio
  // action (and a plain generate) stays JSON, so the JSON path below is untouched.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return handleMultipartGenerate(request, session);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_json");
  }
  if (typeof body !== "object" || body === null) return jsonError(422, "invalid_body");
  const b = body as Record<string, unknown>;

  switch (b.action) {
    case "edit": {
      const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
      const expectedDraftVersionId = typeof b.expectedDraftVersionId === "string" ? b.expectedDraftVersionId : "";
      const context = editContext(b.context);
      if (!prompt || prompt.length > EDIT_PROMPT_MAX) return jsonError(422, "invalid_edit_prompt", "Keep the edit prompt under 2,000 characters.");
      if (!isUuid(expectedDraftVersionId)) return jsonError(422, "invalid_draft_version");
      if (context === null) return jsonError(422, "invalid_edit_context");
      return editStreamResponse((onEvent) => editStorefrontByPrompt({
        shopId: session.shopId,
        actorId: session.userId,
        prompt,
        expectedDraftVersionId,
        trusted: quotaTrusted(session),
        onEvent,
        ...(context ? { context } : {}),
      }));
    }

    case "undo-edit": {
      const targetVersionId = typeof b.targetVersionId === "string" ? b.targetVersionId : "";
      const expectedDraftVersionId = typeof b.expectedDraftVersionId === "string" ? b.expectedDraftVersionId : "";
      if (!isUuid(targetVersionId) || !isUuid(expectedDraftVersionId)) return jsonError(422, "invalid_edit_undo");
      return editResponse(() => undoStorefrontEdit({
        shopId: session.shopId,
        actorId: session.userId,
        targetVersionId,
        expectedDraftVersionId,
      }));
    }

    case "save-hero": {
      const headline = heroText(b.headline);
      const subhead = heroText(b.subhead);
      if (headline == null || subhead == null || headline === "") {
        return jsonError(422, "invalid_hero", "Hero copy must be text (headline non-empty, 300 chars max).");
      }
      return dashboardJson(async () => ({
        hero: await saveStudioHero(session.shopId, { headline, subhead }),
      }));
    }

    case "policy-save": {
      const policyId = typeof b.policyId === "string" ? b.policyId : "";
      const title = typeof b.title === "string" ? b.title.trim() : "";
      const policyBody = typeof b.body === "string" ? b.body.trim() : "";
      if (!isStorefrontPolicyId(policyId)) {
        return jsonError(422, "invalid_storefront_policy_id", "Choose a supported store policy.");
      }
      if (!title || title.length > STOREFRONT_POLICY_TITLE_MAX) {
        return jsonError(422, "invalid_storefront_policy_title", "Policy titles must be between 1 and 120 characters.");
      }
      if (!policyBody || policyBody.length > STOREFRONT_POLICY_BODY_MAX) {
        return jsonError(422, "invalid_storefront_policy_body", "Policy text must be between 1 and 50,000 characters.");
      }
      return dashboardJson(async () => ({
        policy: await saveStorefrontPolicy(session.shopId, { id: policyId, title, body: policyBody }),
      }));
    }

    case "policy-delete": {
      const policyId = typeof b.policyId === "string" ? b.policyId : "";
      if (!isStorefrontPolicyId(policyId)) {
        return jsonError(422, "invalid_storefront_policy_id", "Choose a supported store policy.");
      }
      return dashboardJson(async () => {
        await deleteStorefrontPolicy(session.shopId, policyId);
        return { deletedPolicyId: policyId };
      });
    }

    case "accent": {
      const color = typeof b.color === "string" ? b.color : "";
      if (!HEX_COLOR_RE.test(color)) {
        return jsonError(422, "invalid_color", "Accent must be a #rrggbb hex color.");
      }
      return dashboardJson(async () => {
        await saveStudioAccent(session.shopId, color);
        return { accent: color };
      });
    }

    case "generate": {
      if (b.brief !== undefined && typeof b.brief !== "string") {
        return jsonError(422, "invalid_brief");
      }
      if (b.model !== undefined && b.model !== "sonnet" && b.model !== "opus") {
        return jsonError(422, "invalid_model", "Model must be sonnet or opus.");
      }
      const rawBrief = typeof b.brief === "string" ? b.brief : undefined;
      return dashboardJson(async () => {
        const release = await readStorefrontReleaseState(session.shopId);
        if (release.draftRuntimeVersion === 1) {
          throw new CalderynError({
            code: "storefront_edit_request_required",
            status: 409,
            message: "This store uses the new storefront editor. Send the prompt as an edit or explicitly start over.",
          });
        }
        const brief = rawBrief && rawBrief.trim() ? rawBrief.trim() : undefined;
        const result = await runStorefrontBuild(session, brief ?? "", "auto");
        return { runId: result.versionId, status: "draft" };
      });
    }

    case "publish": {
      return releaseResponse(async () => {
        const storefrontUrl = await publishStudioStore(session.shopId, session.userId);
        return { publishedAt: new Date().toISOString(), storefrontUrl };
      });
    }

    case "vibe": {
      const vibe = typeof b.vibe === "string" ? b.vibe : "";
      if (!STUDIO_VIBES.includes(vibe)) {
        return jsonError(422, "invalid_vibe", "Vibe must be minimal, bold or warm.");
      }
      return dashboardJson(async () => {
        await saveStudioVibe(session.shopId, vibe as StudioVibe);
        return { vibe };
      });
    }

    case "section-move": {
      const id = typeof b.id === "string" ? b.id : "";
      const direction = b.direction === "up" || b.direction === "down" ? b.direction : null;
      if (!id || !direction) return jsonError(422, "invalid_section", "Section move needs an id and a direction.");
      return dashboardJson(async () => {
        await assertLegacySectionMutationAllowed(session.shopId);
        return { sections: await moveStudioSection(session.shopId, id, direction) };
      });
    }

    case "section-remove": {
      const id = typeof b.id === "string" ? b.id : "";
      if (!id) return jsonError(422, "invalid_section", "Section remove needs an id.");
      return dashboardJson(async () => {
        await assertLegacySectionMutationAllowed(session.shopId);
        return { sections: await removeStudioSection(session.shopId, id) };
      });
    }

    case "section-regenerate": {
      const id = typeof b.id === "string" ? b.id : "";
      if (!id) return jsonError(422, "invalid_section", "Section regenerate needs an id.");
      if (b.instruction !== undefined && typeof b.instruction !== "string") {
        return jsonError(422, "invalid_instruction");
      }
      const instruction = typeof b.instruction === "string" && b.instruction.trim() ? b.instruction.trim() : undefined;
      if (instruction && instruction.length > 500) {
        return jsonError(422, "invalid_instruction", "Keep the instruction under 500 characters.");
      }
      // A real design-model call: bound it like other paid entry points. The shared
      // storegen burst limit is deliberately not consumed (a section redo must not lock
      // the merchant out of a full rebuild); a dedicated hourly cap bounds the spend.
      return dashboardJson(async () => {
        await assertLegacySectionMutationAllowed(session.shopId);
        if (!(await rateLimit(`sectionregen:${session.shopId}`, 20, 3_600_000))) {
          throw new CalderynError({
            code: "rate_limited",
            status: 429,
            message: "Too many section redos. Please wait a little while.",
          });
        }
        return { sections: await regenerateStudioSection(session.shopId, id, instruction) };
      });
    }

    case "experiment-start": {
      // Starting a test writes a row and reads the catalog; cap per shop to
      // bound abuse the same way generate does.
      if (!(await rateLimit(`experiment:${session.shopId}`, 10, 60_000))) {
        return jsonError(429, "rate_limited", "Too many experiment starts. Please wait a moment.");
      }
      const kind = typeof b.kind === "string" ? b.kind : "";
      if (!EXPERIMENT_KINDS.includes(kind)) {
        return jsonError(422, "invalid_kind", "Experiment kind must be headline, vibe, pdp_copy or ai_page.");
      }
      if (b.name !== undefined && typeof b.name !== "string") {
        return jsonError(422, "invalid_name");
      }
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
      if (name && name.length > EXPERIMENT_NAME_MAX) {
        return jsonError(422, "invalid_name", "Keep the test name under 80 characters.");
      }
      return dashboardJson(async () => {
        // The AI challenger runs a real design-model generation, so it shares the generate
        // entry points' guards: the burst limit up front (a scripted client must not fire
        // unlimited challenger generations), and the daily designer quota LAST — consumed via
        // the hook only once startExperiment's own refusals (running test, nothing published)
        // have passed, so a refused start never burns a slot (quota-last, guard.server.ts).
        if (kind === "ai_page") await assertGeneratePrechecks(session.shopId, undefined);
        return {
          experiment: await startExperiment(session.shopId, {
            kind: kind as StoreExperimentKind,
            name,
            ...(kind === "ai_page"
              ? { onBeforeAiCall: () => assertDesignerQuota(session.shopId, { trusted: quotaTrusted(session) }) }
              : {}),
          }),
        };
      });
    }

    case "experiment-decide": {
      const id = typeof b.id === "string" ? b.id : "";
      if (!isUuid(id)) return jsonError(422, "invalid_id");
      const decision = typeof b.decision === "string" ? b.decision : "";
      if (!EXPERIMENT_DECISIONS.includes(decision)) {
        return jsonError(422, "invalid_decision", "Decision must be ship, keep or stop.");
      }
      return dashboardJson(async () => ({
        experiment: await decideExperiment(session.shopId, id, decision as "ship" | "keep" | "stop"),
      }));
    }

    default:
      return jsonError(422, "unknown_action");
  }
}
