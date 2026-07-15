// app/routes/dashboard.api.campaigns.first-run.creatives.tsx
// First-campaign wizard, step 3: generate up to three complete ad directions
// from a catalog product. Copy and visual providers share one scored brief. The
// product's signed primary image is the visual model's reference, and generated
// outputs are quota-reserved and persisted before being returned to the browser.
// Missing image credentials/quota returns an honest unavailable result.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import {
  getProduct,
  getProductPrimaryMediaSource,
} from "~/lib/catalog/catalog.server";
import { signMediaPath } from "~/lib/catalog/sign-media.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { formatMoney } from "~/lib/storefront/money";
import { buildProductCreative } from "~/lib/screener/product-creative.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { buildGenerateRequest } from "~/lib/screener/generate.server";
import { calibrate } from "~/lib/screener/calibrate.server";
import {
  combineFirstRunDirections,
  generateFirstRunImages,
  normalizeFirstRunCreativePayload,
  normalizeGeneratedText,
} from "~/lib/screener/first-run-creatives.server";
import type { ScoreCard } from "~/lib/screener/types";
import { isUuid } from "~/lib/ids";
import {
  completeFirstRunGeneration,
  markFirstRunGenerationStarted,
  releaseFirstRunGeneration,
  reserveFirstRunGeneration,
} from "~/lib/screener/first-run-generation.server";
import { persistExternalImage } from "~/lib/assets/persist.server";
import { getSupabase } from "~/lib/supabase.server";
import {
  geminiImageClient,
  imageGenerator as createImageGenerator,
} from "~/lib/screener/image-generator.server";

interface CreativeVariantDTO {
  headline: string;
  primaryText: string;
  cta: string;
  rationale: string;
  imageUrl: string | null;
  imageGenerated: boolean;
  score: number | null;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const productId =
    typeof body.productId === "string" ? body.productId.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const attempt = Number(body.attempt);
  if (!isUuid(productId))
    return jsonError(422, "invalid_product_id", "productId must be a uuid");
  if (!isUuid(runId))
    return jsonError(422, "invalid_run_id", "runId must be a uuid");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    return jsonError(422, "invalid_attempt", "attempt must be 1, 2, or 3");
  }

  return dashboardJson(async () => {
    // getShopStorefrontOrigin only needs shopId — no reason to wait on
    // getProduct before starting it.
    const [product, origin, primaryMediaSource] = await Promise.all([
      getProduct(session.shopId, productId),
      getShopStorefrontOrigin(session.shopId),
      getProductPrimaryMediaSource(session.shopId, productId),
    ]);
    if (!product) throw jsonError(404, "not_found");

    const reservation = await reserveFirstRunGeneration(
      session.shopId,
      runId,
      productId,
      attempt,
    );
    if (!reservation.ok) {
      if (reservation.reason === "daily_limit") {
        throw jsonError(
          429,
          "creative_generation_daily_limit",
          "Creative generation is at its daily limit for this store. Try again tomorrow.",
        );
      }
      throw jsonError(
        409,
        "creative_generation_in_progress",
        "That creative set is still being generated. Try again in a moment.",
      );
    }
    if (reservation.kind === "replay") {
      return normalizeFirstRunCreativePayload(reservation.result);
    }
    const directionCount = attempt === 1 ? 3 : 1;
    const imagePurpose =
      attempt === 1 ? "campaign_initial" : "campaign_regeneration";
    let keepReservation = false;
    let terminalFallback: Record<string, unknown> | null = null;
    const finish = async <T extends Record<string, unknown>>(response: T) => {
      if (keepReservation) {
        await completeFirstRunGeneration(
          session.shopId,
          reservation.id,
          response,
        );
      }
      return normalizeFirstRunCreativePayload(response);
    };

    try {
      const sourceImageUrl = primaryMediaSource.storagePath
        ? await signMediaPath(primaryMediaSource.storagePath)
        : primaryMediaSource.externalUrl;
      let imageUrl: string | null = null;
      if (sourceImageUrl) {
        // Drafts can be resumed long after a private product-media signature
        // expires. Mirror the chosen product reference once per wizard run so
        // every fallback creative, saved draft, and Meta launch keeps a stable
        // owned URL. Regenerations reuse the existing mirror.
        const referenceKind = `campaign-reference:${runId}:${productId}`;
        const { data: existingReference, error: referenceError } =
          await getSupabase()
            .from("asset_dim")
            .select("public_url")
            .eq("shop_id", session.shopId)
            .eq("kind", referenceKind)
            .eq("source", "mirrored")
            .limit(1)
            .maybeSingle();
        if (referenceError) throw referenceError;
        if (existingReference?.public_url) {
          imageUrl = String(existingReference.public_url);
        } else {
          const mirrored = await persistExternalImage(
            session.shopId,
            sourceImageUrl,
            referenceKind,
            "mirrored",
          );
          imageUrl = mirrored.persisted ? mirrored.url : null;
        }
      }

      const productUrl = origin
        ? `${origin}/storefront/products/${product.handle}`
        : new URL(
            `/storefront/products/${product.handle}`,
            request.url,
          ).toString();

      const priceCents = product.variants[0]?.retailPriceCents ?? null;
      const price =
        typeof priceCents === "number" ? formatMoney(priceCents, "usd") : null;

      const productCreative = buildProductCreative({
        title: product.title,
        description: product.description,
        imageUrl: sourceImageUrl,
        productUrl,
        price,
      });
      const original = {
        ...productCreative,
        headline: normalizeGeneratedText(productCreative.headline),
        primaryText: normalizeGeneratedText(productCreative.primaryText),
      };
      const fallback = {
        headline: original.headline,
        primaryText: original.primaryText,
        cta: original.cta,
      };
      terminalFallback = {
        available: false,
        variants: [] as CreativeVariantDTO[],
        destinationUrl: productUrl,
        imageUrl,
        fallback,
        regenerationsLeft: reservation.regenerationsLeft,
      };

      // Image generation is independent from Anthropic. If scoring/copy is not
      // configured, still produce the three product-grounded visual directions
      // and label their scores honestly as unavailable.
      if (!process.env.ANTHROPIC_API_KEY) {
        const imageOnlyRequest = {
          input: original,
          weakMetrics: [],
          tips: [],
          styleRefs: [],
          count: directionCount,
        };
        const generator = createImageGenerator({
          generateImage: geminiImageClient({
            shopId: session.shopId,
            purpose: imagePurpose,
            generationId: reservation.id,
          }),
        });
        const imageResult = await generateFirstRunImages({
          shop: session.shopId,
          count: directionCount,
          generator,
          request: imageOnlyRequest,
        });
        // Only commit the reservation once the paid provider was actually
        // invoked. Gating on generator.available() (credentials) alone burned a
        // merchant regeneration when the image quota was exhausted and no
        // provider call — and no cost — occurred; this branch does no other paid
        // work, so an unattempted run must stay releasable.
        if (imageResult.providerAttempted) {
          await markFirstRunGenerationStarted(
            session.shopId,
            reservation.id,
            terminalFallback,
          );
          keepReservation = true;
        }
        if (imageResult.candidates.length === directionCount) {
          return finish({
            available: true,
            variants: imageResult.candidates.map((candidate, index) => ({
              headline: normalizeGeneratedText(original.headline),
              primaryText: normalizeGeneratedText(original.primaryText),
              cta: original.cta,
              rationale: `Product-grounded visual direction ${index + 1}`,
              imageUrl: candidate.input.imageUrl,
              imageGenerated: true,
              score: null,
            })),
            destinationUrl: productUrl,
            imageUrl,
            fallback,
            regenerationsLeft: reservation.regenerationsLeft,
          });
        }
        return finish({
          available: false,
          variants: [] as CreativeVariantDTO[],
          destinationUrl: productUrl,
          imageUrl,
          fallback,
          regenerationsLeft: keepReservation
            ? reservation.regenerationsLeft
            : Math.min(2, reservation.regenerationsLeft + 1),
        });
      }

      const { calib, scoreOne, claudeDeps } = await gateScoreDeps(
        session.shopId,
        DEFAULT_SPEND_CENTS,
      );
      const copyGenerator = pickGenerator("copy", claudeDeps);
      const imageGenerator = pickGenerator("image", {
        ...claudeDeps,
        image: {
          shopId: session.shopId,
          purpose: imagePurpose,
          generationId: reservation.id,
        },
      });

      // The intended experience requires three real product-grounded images.
      // Do not spend copy/scoring work or persist a completed fallback attempt
      // when the image provider is not configured.
      if (!imageGenerator.available()) return terminalFallback;

      await markFirstRunGenerationStarted(
        session.shopId,
        reservation.id,
        terminalFallback,
      );
      keepReservation = true;
      const scored = await scoreOne(original);
      const { outcomes, grade, confidence } = calibrate(
        scored.metrics,
        calib,
        DEFAULT_SPEND_CENTS,
      );
      const originalScorecard: ScoreCard = {
        composite: scored.composite,
        grade,
        confidence,
        summary: scored.summary,
        metrics: scored.metrics,
        outcomes,
        tips: [],
      };

      const generationRequest = buildGenerateRequest({
        original,
        originalScorecard,
        styleRefs: calib.topAdNames,
        count: directionCount,
      });
      const [copyCandidates, imageResult] = await Promise.all([
        copyGenerator.generate(generationRequest),
        generateFirstRunImages({
          shop: session.shopId,
          count: directionCount,
          generator: imageGenerator,
          request: generationRequest,
        }),
      ]);
      keepReservation ||=
        imageResult.providerAttempted || copyCandidates.length > 0;
      if (imageResult.candidates.length !== directionCount) {
        return finish({
          available: false,
          variants: [] as CreativeVariantDTO[],
          destinationUrl: productUrl,
          imageUrl,
          fallback,
          regenerationsLeft: keepReservation
            ? reservation.regenerationsLeft
            : Math.min(2, reservation.regenerationsLeft + 1),
        });
      }
      const candidates = combineFirstRunDirections(
        original,
        copyCandidates,
        imageResult.candidates,
        directionCount,
      );
      if (candidates.length === 0) {
        return finish({
          available: false,
          variants: [] as CreativeVariantDTO[],
          destinationUrl: productUrl,
          imageUrl,
          fallback,
          regenerationsLeft: Math.min(2, reservation.regenerationsLeft + 1),
        });
      }

      const variants: CreativeVariantDTO[] = await Promise.all(
        candidates.map(async (candidate) => {
          let score: number | null = null;
          try {
            score = (await scoreOne(candidate.input)).composite;
          } catch {
            // The visual is already generated and durably stored. A transient
            // scoring failure must not collapse the required three choices.
          }
          return {
            headline: normalizeGeneratedText(candidate.input.headline),
            primaryText: normalizeGeneratedText(candidate.input.primaryText),
            cta: candidate.input.cta,
            rationale: normalizeGeneratedText(candidate.rationale),
            imageUrl: candidate.input.imageUrl,
            imageGenerated: candidate.imageGenerated,
            score,
          };
        }),
      );
      variants.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

      if (variants.length === 0) {
        return finish({
          available: false,
          variants: [] as CreativeVariantDTO[],
          destinationUrl: productUrl,
          imageUrl,
          fallback,
          regenerationsLeft: Math.min(2, reservation.regenerationsLeft + 1),
        });
      }
      keepReservation = true;
      return finish({
        available: true,
        variants,
        destinationUrl: productUrl,
        imageUrl,
        fallback,
        regenerationsLeft: reservation.regenerationsLeft,
      });
    } catch (error) {
      if (keepReservation && terminalFallback) {
        return finish(terminalFallback);
      }
      throw error;
    } finally {
      if (!keepReservation) {
        await releaseFirstRunGeneration(session.shopId, reservation.id);
      }
    }
  });
}
