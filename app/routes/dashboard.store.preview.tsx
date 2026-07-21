// app/routes/dashboard.store.preview.tsx
// Session-gated, same-origin frameable preview for immutable storefront drafts.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import storefrontCss from "~/styles/storefront.css?url";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getCatalog, getPreviewCatalog } from "~/lib/storefront/catalog.server";
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
import { isStorefrontBundleReadEnabled } from "~/lib/storefront-runtime/csp.server";
import {
  resolveRuntime1VersionRoute,
  type Runtime1RouteData,
  type StorefrontVersionRecord,
} from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import {
  commitPreviewCommerceSession,
  createPreviewCommerceAdapter,
  readPreviewBundleVersion,
  readPreviewCommerceSession,
} from "~/lib/storefront-runtime/preview-commerce.server";
import type { PublicRouteContext } from "~/lib/storefront-runtime/public-data.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { getStorefrontRecipe } from "~/lib/storefront-recipes";
import { getStorefrontRecipeReviewCatalog } from "~/lib/storefront-recipes/review-catalog.server";
import {
  isStorefrontRecipeReviewEnabled,
  isStorefrontRecipeReviewTemplateId,
} from "~/lib/storefront-recipes/review.server";
import { isStoreTemplateId, STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import { DEMO_SHOP_ID } from "~/lib/storefront/shop.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

const REVIEW_POLICY_LINKS = [
  { id: "privacy", title: "Privacy", href: "/storefront/policies/privacy" },
  { id: "terms", title: "Terms", href: "/storefront/policies/terms" },
  { id: "refund", title: "Returns", href: "/storefront/policies/refund" },
  { id: "shipping", title: "Shipping", href: "/storefront/policies/shipping" },
] as const;

async function previewRouteContext(request: Request, shopId: string, catalog: StorefrontCatalog): Promise<PublicRouteContext> {
  const url = new URL(request.url);
  const route = url.searchParams.get("route") ?? "home";
  if (route === "product") {
    const requested = url.searchParams.get("handle");
    const handle = requested ?? (await catalog.listProducts(shopId, { limit: 1 }))[0]?.handle ?? "";
    return { kind: "product", handle };
  }
  if (route === "collection") {
    const requested = url.searchParams.get("handle");
    const handle = requested ?? (await catalog.listCollections(shopId))[0]?.handle ?? "";
    return { kind: "collection", handle };
  }
  if (route === "search") return { kind: "search", query: url.searchParams.get("q")?.slice(0, 200) ?? "" };
  if (route === "cart" || route === "checkout") return { kind: route };
  if (route === "collections" || route === "story" || route === "notFound") return { kind: route };
  return { kind: "home" };
}

function withPreviewRecipeAssetUrls(request: Request, runtime1: Runtime1RouteData, reviewOrigin?: string): Runtime1RouteData {
  const configuredOrigin = reviewOrigin || process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  let assetOrigin: string;
  try {
    assetOrigin = new URL(configuredOrigin).origin;
  } catch {
    assetOrigin = new URL(request.url).origin;
  }
  const urls: Record<string, string> = { ...runtime1.data.storefrontAssetUrls };
  if (runtime1.bundle.source.kind === "recipe") {
    const extension = { "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" } as const;
    for (const asset of runtime1.bundle.assets.entries) {
      if (asset.mediaType in extension && (reviewOrigin || !urls[asset.key])) {
        urls[asset.key] = `/storefront-recipes/${runtime1.bundle.source.templateId}/${asset.contentHash}.${extension[asset.mediaType as keyof typeof extension]}`;
      }
    }
  }
  for (const [key, value] of Object.entries(urls)) {
    if (value.startsWith("/storefront-recipes/")) urls[key] = new URL(value, assetOrigin).toString();
  }
  return Object.keys(urls).length === 0
    ? runtime1
    : { ...runtime1, data: { ...runtime1.data, storefrontAssetUrls: urls } };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const requestedTemplateId = requestUrl.searchParams.get("template");
  const reviewTemplateId = isStorefrontRecipeReviewEnabled() && isStorefrontRecipeReviewTemplateId(requestedTemplateId)
    ? requestedTemplateId
    : null;
  const shopId = reviewTemplateId ? DEMO_SHOP_ID : (await requireDashboardSession(request)).shopId;
  if (reviewTemplateId || isStorefrontBundleReadEnabled()) {
    const templateId = reviewTemplateId ?? requestedTemplateId;
    const registered = isStoreTemplateId(templateId) && STORE_TEMPLATE_REGISTRY.templates.some((template) => template.id === templateId)
      ? templateId
      : null;
    if (registered) {
      const catalog = reviewTemplateId
        ? getStorefrontRecipeReviewCatalog(reviewTemplateId)
        : getPreviewCatalog();
      const recipe = getStorefrontRecipe(registered);
      const version: StorefrontVersionRecord = {
        id: `preview:${registered}`,
        shopId,
        sourceKind: "recipe",
        status: "validated",
        schemaVersion: recipe.bundle.schemaVersion,
        runtimeVersion: recipe.bundle.runtimeVersion,
        validationProfileVersion: recipe.bundle.validationProfileVersion,
        artifactHash: `sha256:${recipe.hash}`,
        artifact: { sourceKind: "recipe", bundle: recipe.bundle },
        createdAt: new Date(0).toISOString(),
      };
      const route = await previewRouteContext(request, shopId, catalog);
      const commerce = await readPreviewCommerceSession(request, shopId);
      const runtime1 = await resolveRuntime1VersionRoute({
        shopId,
        route,
        version,
        dataDependencies: {
          catalog,
          cartLoader: async () => commerce.cart,
          ...(reviewTemplateId ? { policyLoader: async () => [...REVIEW_POLICY_LINKS] } : {}),
        },
      });
      if (runtime1) {
        const nonce = randomBytes(18).toString("base64url");
        const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
        const reviewInfo = reviewTemplateId ? requestUrl.searchParams.get("info") : null;
        const reviewPolicy = reviewInfo === "policy" ? requestUrl.searchParams.get("policy") : null;
        return json({ ...withPreviewRecipeAssetUrls(request, runtime1, reviewTemplateId ? requestUrl.origin : undefined), nonce, reviewInfo, reviewPolicy }, { headers });
      }
    }
    const version = await readPreviewBundleVersion(shopId);
    if (version) {
      const catalog = getPreviewCatalog();
      const route = await previewRouteContext(request, shopId, catalog);
      const commerce = await readPreviewCommerceSession(request, shopId);
      const runtime1 = await resolveRuntime1VersionRoute({
        shopId,
        route,
        version,
        dataDependencies: { catalog, cartLoader: async () => commerce.cart },
      });
      if (runtime1) {
        const nonce = randomBytes(18).toString("base64url");
        const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
        return json({ ...withPreviewRecipeAssetUrls(request, runtime1), nonce }, { headers });
      }
    }
  }
  throw new Response("No storefront draft is available.", { status: 404 });
}

export async function action({ request }: ActionFunctionArgs) {
  const requestUrl = new URL(request.url);
  const selectedTemplateId = requestUrl.searchParams.get("template");
  const reviewTemplateId = isStorefrontRecipeReviewEnabled() && isStorefrontRecipeReviewTemplateId(selectedTemplateId)
    ? selectedTemplateId
    : null;
  if (reviewTemplateId) {
    if (request.headers.get("Origin") !== requestUrl.origin) throw jsonError(403, "bad_origin");
  } else {
    requireSameOrigin(request);
  }
  const shopId = reviewTemplateId ? DEMO_SHOP_ID : (await requireDashboardSession(request)).shopId;
  const commerceCatalog = (): StorefrontCatalog => reviewTemplateId
    ? getStorefrontRecipeReviewCatalog(reviewTemplateId)
    : getCatalog();
  const hasEphemeralRecipe = isStoreTemplateId(selectedTemplateId) &&
    STORE_TEMPLATE_REGISTRY.templates.some((template) => template.id === selectedTemplateId);
  if ((!reviewTemplateId && !isStorefrontBundleReadEnabled()) || (!hasEphemeralRecipe && !(await readPreviewBundleVersion(shopId)))) {
    throw new Response(null, { status: 404 });
  }
  const current = await readPreviewCommerceSession(request, shopId);
  const adapter = createPreviewCommerceAdapter(current);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "checkout") {
    return json(adapter.checkout(), { headers: storefrontCacheHeaders({ routeId: "preview", personalized: true }) });
  }
  if (intent === "addBundle") {
    const entries = [...form.entries()];
    if (entries.length !== 2 || form.getAll("intent").length !== 1 || form.getAll("lines").length !== 1 ||
      entries.some(([key]) => key !== "intent" && key !== "lines")) {
      throw new Response("Invalid preview bundle", { status: 400 });
    }
    const encoded = form.get("lines");
    let lines: unknown;
    try { lines = typeof encoded === "string" && encoded.length <= 4096 ? JSON.parse(encoded) : null; } catch { lines = null; }
    if (!Array.isArray(lines) || lines.length < 2 || lines.length > 12 || lines.some((line) => {
      if (!line || typeof line !== "object" || Array.isArray(line)) return true;
      const candidate = line as Record<string, unknown>;
      return Object.keys(candidate).some((key) => key !== "variantId" && key !== "quantity") ||
        typeof candidate.variantId !== "string" || !candidate.variantId || candidate.variantId.length > 128 || candidate.quantity !== 1;
    })) throw new Response("Invalid preview bundle", { status: 400 });
    const catalog = commerceCatalog();
    const products = catalog.getVariantById ? null : await catalog.listProducts(shopId);
    const resolvedLines = await Promise.all((lines as Array<{ variantId: string; quantity: 1 }>).map(async (line) => {
      const resolved = catalog.getVariantById
        ? await catalog.getVariantById(shopId, line.variantId)
        : products!.flatMap((product) => product.variants.map((variant) => ({ product, variant })))
          .find((entry) => entry.variant.id === line.variantId) ?? null;
      if (!resolved || !resolved.variant.available) throw new Response("Variant unavailable", { status: 422 });
      return {
        lineId: `preview:${line.variantId}`,
        variantId: line.variantId,
        title: resolved.variant.title && resolved.variant.title !== resolved.product.title
          ? `${resolved.product.title} - ${resolved.variant.title}`
          : resolved.product.title,
        quantity: line.quantity,
        unitPrice: { cents: resolved.variant.priceCents, currency: resolved.variant.currency.toUpperCase() },
      };
    }));
    try { adapter.addBundle(resolvedLines); } catch { throw new Response("Invalid preview bundle", { status: 422 }); }
  } else if (intent === "add") {
    const variantId = form.get("variantId");
    const quantity = Number(form.get("quantity") ?? 1);
    if (typeof variantId !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Response("Invalid preview cart line", { status: 400 });
    }
    const catalog = commerceCatalog();
    const resolved = catalog.getVariantById
      ? await catalog.getVariantById(shopId, variantId)
      : (await catalog.listProducts(shopId)).flatMap((product) => product.variants.map((variant) => ({ product, variant })))
        .find((entry) => entry.variant.id === variantId) ?? null;
    if (!resolved || !resolved.variant.available) throw new Response("Variant unavailable", { status: 422 });
    adapter.add({
      lineId: `preview:${variantId}`,
      variantId,
      title: resolved.variant.title && resolved.variant.title !== resolved.product.title
        ? `${resolved.product.title} - ${resolved.variant.title}`
        : resolved.product.title,
      quantity,
      unitPrice: { cents: resolved.variant.priceCents, currency: resolved.variant.currency.toUpperCase() },
    });
  } else if (intent === "quantity") {
    const lineId = form.get("lineId");
    const quantity = Number(form.get("quantity"));
    if (typeof lineId !== "string") throw new Response("lineId is required", { status: 400 });
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
      throw new Response("Invalid preview quantity", { status: 400 });
    }
    adapter.setQuantity(lineId, quantity);
  } else if (intent === "remove") {
    const lineId = form.get("lineId");
    if (typeof lineId !== "string") throw new Response("lineId is required", { status: 400 });
    adapter.remove(lineId);
  } else if (intent === "clear") adapter.clear();
  else throw new Response("Unknown preview action", { status: 400 });

  const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
  let cookie: string;
  try { cookie = await commitPreviewCommerceSession(adapter.snapshot()); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "Preview cart exceeds cookie capacity") throw error;
    throw new Response(error.message, { status: 422 });
  }
  headers.append("Set-Cookie", cookie);
  return json({ cart: adapter.cart() }, { headers });
}

export default function StoreDraftPreview() {
  const loaded = useLoaderData<typeof loader>();
  if (!isRuntime1RenderData(loaded)) throw new Error("Storefront preview data is unavailable.");
  const reviewTemplate = loaded.bundle.source.kind === "recipe" ? loaded.bundle.source.templateId : "";
  const reviewPolicy = "reviewPolicy" in loaded && typeof loaded.reviewPolicy === "string" ? loaded.reviewPolicy : null;
  if ("reviewInfo" in loaded && loaded.reviewInfo === "account") return <main className="cd-account cd-account--narrow"><h1>Account preview</h1><p>Customers can securely view orders, manage saved addresses, and update payment methods after signing in.</p><a href={`/dashboard/store/preview?template=${reviewTemplate}`}>Return to store</a></main>;
  if ("reviewInfo" in loaded && loaded.reviewInfo === "policy") return <main className="cd-account cd-account--narrow"><h1>{reviewPolicy ? `${reviewPolicy[0]?.toUpperCase()}${reviewPolicy.slice(1)} policy` : "Store policies"}</h1><p>The merchant&apos;s published policy content appears here. Review links are read-only and never expose another store&apos;s policy data.</p><a href={`/dashboard/store/preview?template=${reviewTemplate}`}>Return to store</a></main>;
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: loaded.routeId, data: loaded.data, nonce: loaded.nonce, mode: "preview", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId={loaded.routeId} data={loaded.data} mode="preview" /></>;
}
