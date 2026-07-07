import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  loadStudioState,
  saveStudioHero,
  saveStudioAccent,
  saveStudioVibe,
  publishStudioStore,
} from "~/lib/storebuilder/studio.server";
import { decideExperiment, startExperiment } from "~/lib/experiments/store-experiment.server";
import { generateStore, type GenerateResult } from "~/lib/storegen/generate.server";
import { classifyAttachmentIntent, type AttachmentImage, type AttachmentIntent } from "~/lib/storegen/attachment-intent.server";
import { assertCanGenerate, assertGeneratePrechecks, assertDesignerQuota } from "~/lib/storegen/guard.server";
import { createProduct } from "~/lib/catalog/catalog.server";
import { uploadProductMedia } from "~/lib/catalog/media.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import {
  STUDIO_IMAGE_MEDIA_TYPES,
  type StudioDesignModel,
  type StudioVibe,
  type StudioGenerateReceipt,
  type StudioAddedProduct,
} from "~/lib/storebuilder/studio-types";
import { quotaTrusted } from "~/lib/ai-quota.server";
import type { DashboardSession } from "~/lib/dashboard/session.server";

// Store studio read model: brand settings, home hero copy, preview products,
// draft/published flags, and the latest generation run.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadStudioState(session.shopId));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HERO_TEXT_MAX = 300;
const STUDIO_VIBES: readonly string[] = ["minimal", "bold", "warm"];
const EXPERIMENT_KINDS: readonly string[] = ["headline", "vibe"];
const EXPERIMENT_DECISIONS: readonly string[] = ["ship", "keep", "stop"];
const EXPERIMENT_NAME_MAX = 80;

function heroText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length <= HERO_TEXT_MAX ? t : null;
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

/** Real generation — awaited deliberately, can take several seconds. Any throw
 *  becomes the 502 both entry points share; the SOFT-degraded "failed" status
 *  comes back inside a successful result, not as a throw. */
async function runGenerate(
  shopId: string,
  brief: string | undefined,
  designModel: StudioDesignModel | undefined,
  referenceImages?: AttachmentImage[],
): Promise<GenerateResult> {
  try {
    return await generateStore({
      shopId,
      mode: brief ? "brief" : "catalog",
      brief,
      designModel,
      ...(referenceImages && referenceImages.length > 0 ? { referenceImages } : {}),
    });
  } catch (err) {
    console.error("[dashboard.api.store] store generation failed", err);
    throw new CalderynError({
      code: "generation_failed",
      status: 502,
      message: "Store generation failed. Please try again.",
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
  const designModel = (typeof modelField === "string" ? modelField : undefined) as StudioDesignModel | undefined;
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

    // Multipart with no attachments behaves exactly like the JSON generate path
    // (identical guard order: prechecks above, then the daily quota).
    if (files.length === 0) {
      await assertDesignerQuota(session.shopId, { trusted: quotaTrusted(session) });
      const result = await runGenerate(session.shopId, brief, designModel);
      return { runId: result.runId, status: result.status } satisfies StudioGenerateReceipt;
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

    // Generation is now certain when useAsReference, so consume the daily
    // designer slot HERE — before any product rows are written, so a quota
    // refusal is a clean 429 with no partial state. A products-only intent
    // takes no designer slot at all: adding catalog drafts is not a generation.
    if (intent.useAsReference) {
      await assertDesignerQuota(session.shopId, { trusted: quotaTrusted(session) });
    }

    // Create products FIRST (draft rows), THEN generate — the generator re-reads
    // the catalog, so the new drafts land in the snapshot it designs around.
    // In PARALLEL (distinct rows, no contention) and contained per item (the
    // helper never throws), so every attached image gets a receipt entry.
    const products: StudioAddedProduct[] = intent.addAsProducts
      ? await Promise.all(images.map((img) => createDraftProductFromImage(session.shopId, img)))
      : [];

    if (intent.useAsReference) {
      let result: GenerateResult;
      try {
        result = await runGenerate(session.shopId, brief, designModel, asAttachmentImages());
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
        runId: result.runId,
        status: result.status,
        intent,
        ...(products.length > 0 ? { products } : {}),
        ...(result.referencesUnread ? { referencesUnread: true as const } : {}),
      } satisfies StudioGenerateReceipt;
    }

    // Products only — no generation ran, no designer quota touched.
    return { status: "products_added", intent, products } satisfies StudioGenerateReceipt;
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
      const designModel = b.model as StudioDesignModel | undefined;
      const rawBrief = typeof b.brief === "string" ? b.brief : undefined;
      return dashboardJson(async () => {
        // Brief cap, burst limit, mid-test refusal AND the daily AI quota are
        // shared with dashboard.builder.generate.tsx (guard.server.ts) — one
        // shop gets one coherent budget across both paid entry points.
        await assertCanGenerate(session.shopId, rawBrief, { trusted: quotaTrusted(session) });
        const brief = rawBrief && rawBrief.trim() ? rawBrief.trim() : undefined;
        const result = await runGenerate(session.shopId, brief, designModel);
        return { runId: result.runId, status: result.status };
      });
    }

    case "publish": {
      return dashboardJson(async () => {
        await publishStudioStore(session.shopId);
        return { publishedAt: new Date().toISOString() };
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

    case "experiment-start": {
      // Starting a test writes a row and reads the catalog; cap per shop to
      // bound abuse the same way generate does.
      if (!(await rateLimit(`experiment:${session.shopId}`, 10, 60_000))) {
        return jsonError(429, "rate_limited", "Too many experiment starts. Please wait a moment.");
      }
      const kind = typeof b.kind === "string" ? b.kind : "";
      if (!EXPERIMENT_KINDS.includes(kind)) {
        return jsonError(422, "invalid_kind", "Experiment kind must be headline or vibe.");
      }
      if (b.name !== undefined && typeof b.name !== "string") {
        return jsonError(422, "invalid_name");
      }
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
      if (name && name.length > EXPERIMENT_NAME_MAX) {
        return jsonError(422, "invalid_name", "Keep the test name under 80 characters.");
      }
      return dashboardJson(async () => ({
        experiment: await startExperiment(session.shopId, {
          kind: kind as "headline" | "vibe",
          name,
        }),
      }));
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
