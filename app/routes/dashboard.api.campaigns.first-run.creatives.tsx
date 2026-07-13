// app/routes/dashboard.api.campaigns.first-run.creatives.tsx
// First-campaign wizard, step 3: generate up to 3 ad-copy variants from a
// chosen catalog product. Builds a synthetic "original" CreativeInput from the
// product (buildProductCreative), scores it, and runs it through the SAME
// generate -> re-score gate as the per-ad Regenerate action
// (dashboard.api.campaigns.$id.regenerate.tsx) so results can't drift from it.
// No API key / quota -> { available: false, variants: [] }, never an error:
// the wizard falls back to manual copy editing seeded from buildProductCreative.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import { getProduct } from "~/lib/catalog/catalog.server";
import { signMediaPath } from "~/lib/catalog/sign-media.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { formatMoney } from "~/lib/storefront/money";
import { buildProductCreative } from "~/lib/screener/product-creative.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { calibrate } from "~/lib/screener/calibrate.server";
import type { ScoreCard } from "~/lib/screener/types";

interface CreativeVariantDTO {
  headline: string;
  primaryText: string;
  cta: string;
  rationale: string;
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
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  if (!productId) return jsonError(422, "invalid_request", "productId is required");

  return dashboardJson(async () => {
    const product = await getProduct(session.shopId, productId);
    if (!product) throw jsonError(404, "not_found");

    const primaryMedia =
      product.media.find((m) => m.isPrimary) ?? product.media[0] ?? null;
    const imageUrl = primaryMedia ? await signMediaPath(primaryMedia.storagePath) : null;

    const origin = await getShopStorefrontOrigin(session.shopId);
    const productUrl = origin
      ? `${origin}/storefront/products/${product.handle}`
      : `/storefront/products/${product.handle}`;

    const priceCents = product.variants[0]?.retailPriceCents ?? null;
    const price = typeof priceCents === "number" ? formatMoney(priceCents, "usd") : null;

    const original = buildProductCreative({
      title: product.title,
      description: product.description,
      imageUrl,
      productUrl,
      price,
    });

    // The copy generator itself is always-on (no key check in its available()),
    // unlike the image generator, so the "no key / not configured" gate for this
    // wizard step has to happen here rather than via generator.available().
    if (!process.env.ANTHROPIC_API_KEY) {
      return { available: false, variants: [] as CreativeVariantDTO[] };
    }

    // Same dep wiring as dashboard.api.campaigns.$id.regenerate.tsx: one
    // gateScoreDeps call seeds calibration + the scorer, pickGenerator("copy")
    // selects the always-on copy generator, generateImprovements runs the
    // generate -> re-score gate.
    const { calib, scoreOne, claudeDeps } = await gateScoreDeps(session.shopId, DEFAULT_SPEND_CENTS);
    const generator = pickGenerator("copy", claudeDeps);

    const scored = await scoreOne(original);
    const { outcomes, grade, confidence } = calibrate(scored.metrics, calib, DEFAULT_SPEND_CENTS);
    const originalScorecard: ScoreCard = {
      composite: scored.composite,
      grade,
      confidence,
      summary: scored.summary,
      metrics: scored.metrics,
      outcomes,
      tips: [],
    };

    const result = await generateImprovements(
      {
        original,
        originalScorecard,
        styleRefs: calib.topAdNames,
        count: 3,
      },
      { generator, scoreOne },
    );

    if (!result.available) {
      return { available: false, variants: [] as CreativeVariantDTO[] };
    }

    const variants: CreativeVariantDTO[] = result.variants.slice(0, 3).map((v) => ({
      headline: v.input.headline,
      primaryText: v.input.primaryText,
      cta: v.input.cta,
      rationale: v.rationale,
    }));
    return { available: true, variants };
  });
}
